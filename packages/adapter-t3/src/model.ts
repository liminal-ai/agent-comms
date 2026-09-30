// The slice of T3 v0.0.44 the adapter reads, the client it needs, and the
// rules that link our message to its turn. Plain types: nothing of T3's (or
// its effect) crosses this boundary.
//
// Privacy: the client keeps no text of user messages at all, and the adapter
// reads assistant text only for the turn our own message went into.
//
// Why events, not snapshots (Hazel's notes §3, §4, and her review): a user
// message carries no turn id, and a user message's `createdAt` is the sending
// client's clock. The server's event order is the only reliable record of
// what entered our turn. Snapshots give the answer text, and a fallback when
// the events are gone.

export interface T3Message {
  id: string;
  role: "user" | "assistant" | "system";
  /** Null on user messages (Hazel, live); set on assistant messages. */
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  /** Assistant messages only. */
  text?: string;
}

export interface T3Session {
  status: string;
  activeTurnId: string | null;
  lastError: string | null;
}

export interface T3Thread {
  id: string;
  snapshotSequence: number;
  runtimeMode: string;
  interactionMode: string;
  session: T3Session | null;
  latestTurn: {
    turnId: string;
    state: "running" | "interrupted" | "completed" | "error";
    requestedAt: string;
    completedAt: string | null;
    /** The turn's answer. Null on a completed turn means it was interrupted (Claude; Hazel's notes §6). */
    assistantMessageId: string | null;
  } | null;
  messages: T3Message[];
  /** Message ids T3 couldn't start a turn for (`provider.turn.start.failed` activities). */
  turnStartFailures: string[];
}

export type T3Event =
  | { type: "user-message"; sequence: number; messageId: string }
  | { type: "assistant-message"; sequence: number; messageId: string; turnId: string | null }
  | { type: "session"; sequence: number; session: T3Session }
  | { type: "turn-start-failed"; sequence: number; requestId: string }
  | { type: "other"; sequence: number };

export type T3StreamItem =
  | { kind: "snapshot"; thread: T3Thread }
  | { kind: "event"; event: T3Event }
  /** The replay after `afterSequence` is done; live events follow. */
  | { kind: "synchronized" };

export class T3Rejected extends Error {}

export interface T3Client {
  /** Whether the client is connected (or connects now). */
  connected(): Promise<boolean>;
  /** The thread, or null if T3 says it doesn't exist. `turnLimit` bounds it to recent turns; absent means all. */
  getThread(threadId: string, turnLimit?: number): Promise<T3Thread | null>;
  /** `thread.turn.start` with our message. Throws T3Rejected if T3 refuses the command. */
  startTurn(
    threadId: string,
    turn: { messageId: string; text: string; runtimeMode: string; interactionMode: string },
  ): Promise<void>;
  /**
   * The thread's stream. Without `afterSequence`: a snapshot, then live events.
   * With it: the events after that sequence (or a snapshot, if they're no
   * longer available), `synchronized`, then live events. Returns an unsubscribe.
   */
  subscribe(threadId: string, options: { afterSequence?: number }, onItem: (item: T3StreamItem) => void): Promise<() => void>;
  close(): Promise<void>;
}

const RUNNING = new Set(["running", "starting"]);

export function isBusy(thread: Pick<T3Thread, "session">): boolean {
  return !!thread.session && RUNNING.has(thread.session.status);
}

/**
 * Follows the server's events around our message:
 * - our turn is the first turn the session runs after our message was
 *   appended; if a turn was already running when it was appended, we joined
 *   someone else's turn (`joined`);
 * - any other user message appended after ours and before our turn ends is
 *   foreign input (`foreign`);
 * - our turn ends when the session stops running it.
 * Hazel's rule: joined or foreign makes the delivery ambiguous.
 */
export class TurnTracker {
  readonly messageId: string;
  private busy = false;
  private active: string | null = null;
  seenOurs = false;
  turnId: string | undefined;
  joined = false;
  foreign = 0;
  ended = false;
  /** When our turn ended (local clock), for the interrupt signature below. */
  endedAt: number | undefined;
  /**
   * The session stopped right after our turn ended: how the Claude adapter
   * shows an interrupt (it stops the whole provider session), even when part of
   * an answer was already streamed and recorded as the turn's answer.
   */
  stoppedAfterEnd = false;
  startFailed = false;
  lastSequence = -1;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  /** Session state from a snapshot taken before our message. */
  start(session: T3Session | null, sequence: number): void {
    this.busy = !!session && RUNNING.has(session.status);
    this.active = this.busy ? (session?.activeTurnId ?? null) : null;
    this.lastSequence = Math.max(this.lastSequence, sequence);
  }

  feed(event: T3Event): void {
    if (event.sequence <= this.lastSequence) return; // replay overlap
    this.lastSequence = event.sequence;
    switch (event.type) {
      case "session": {
        const running = RUNNING.has(event.session.status);
        const active = running ? event.session.activeTurnId : null;
        if (this.seenOurs && !this.ended) {
          if (this.turnId === undefined) {
            if (running && active) this.turnId = active;
          } else if (active !== this.turnId) {
            this.ended = true;
            this.endedAt = Date.now();
            if (event.session.status === "stopped") this.stoppedAfterEnd = true;
          }
        } else if (this.ended && event.session.status === "stopped") {
          this.stoppedAfterEnd = true;
        }
        this.busy = running;
        this.active = active;
        return;
      }
      case "user-message":
        if (event.messageId === this.messageId) {
          if (this.seenOurs) return;
          this.seenOurs = true;
          if (this.busy) {
            this.joined = true;
            if (this.active) this.turnId = this.active;
          }
        } else if (this.seenOurs && !this.ended) {
          this.foreign += 1;
        }
        return;
      case "turn-start-failed":
        if (event.requestId === this.messageId) this.startFailed = true;
        return;
      default:
        return;
    }
  }

  /** The session as last seen: running or starting a turn. */
  get sessionBusy(): boolean {
    return this.busy;
  }

  get ambiguous(): boolean {
    return this.joined || this.foreign > 0;
  }
}

/**
 * Snapshot-only fallback for a restart check whose events are gone: link our
 * message only to the latest turn, and only if that turn was requested at our
 * message's own timestamp (measured live: a turn our message starts has
 * `requestedAt` equal to its `createdAt`; both come from our command), or was
 * already running across it (joined). Anything else can't be linked without
 * guessing.
 */
export function linkFromSnapshot(thread: T3Thread, messageId: string): { turnId: string; joined: boolean } | undefined {
  const ours = thread.messages.find((m) => m.id === messageId);
  const latest = thread.latestTurn;
  if (!ours || !latest) return undefined;
  const at = Date.parse(ours.createdAt);
  const requested = Date.parse(latest.requestedAt);
  if (requested === at) return { turnId: latest.turnId, joined: false };
  const stillOpenAt = latest.completedAt === null || Date.parse(latest.completedAt) >= at;
  if (requested < at && stillOpenAt) return { turnId: latest.turnId, joined: true };
  return undefined;
}
