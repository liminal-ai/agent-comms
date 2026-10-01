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
 * Follows the server's events around our message, from a snapshot taken
 * before we send it:
 * - foreign user messages appended after that snapshot and before ours, with
 *   no turn starting in between, are waiting for the same turn as ours
 *   (`preceded`, fix pass 1.1);
 * - our turn is the first turn the session runs after our message; if a turn
 *   was already running when ours was appended, we joined it (`joined`);
 *   whether we started it is confirmed separately (`startedByUs`, 1.2);
 * - any other user message appended after ours and before our turn ends is
 *   foreign input (`foreign`);
 * - how our turn ended (`endStatus`) is the session status at the event that
 *   ended it, or `superseded` if another turn simply took over (1.4);
 * - our answer is the last assistant message our turn produced (`answerId`).
 * Any of joined, preceded, foreign, or startedByUs === false makes the delivery
 * ambiguous.
 */
export class TurnTracker {
  readonly messageId: string;
  private busy = false;
  private active: string | null = null;
  private pending = 0;
  seenOurs = false;
  turnId: string | undefined;
  joined = false;
  preceded = 0;
  foreign = 0;
  /** True once confirmed that our message started our turn; false if it can't be. Undefined until checked. */
  startedByUs: boolean | undefined;
  /**
   * The session went `starting` after our message and before our turn ran: what
   * a turn started by a user command does. A turn Claude starts by itself (a
   * finished background task) goes straight to `running` (recorded live,
   * validation/fix-pass-1/1).
   */
  sawStarting = false;
  ended = false;
  endStatus: "ready" | "interrupted" | "error" | "stopped" | "superseded" | undefined;
  endError: string | null = null;
  answerId: string | undefined;
  /** When our turn ended (local clock), for the interrupt signature below. */
  endedAt: number | undefined;
  /**
   * The session stopped right after our turn ended: how the Claude adapter
   * shows an interrupt (it stops the whole provider session), even when part of
   * an answer was already streamed and recorded as the turn's answer.
   */
  stoppedAfterEnd = false;
  startFailed = false;
  /** Events were missed (a resubscription got a snapshot instead of a replay): can't vouch for the turn (3.2). */
  gap = false;
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
        const status = event.session.status;
        const running = RUNNING.has(status);
        const active = running ? event.session.activeTurnId : null;
        if (!this.seenOurs) {
          if (running) this.pending = 0; // a turn started: whatever was waiting went into it
        } else if (!this.ended) {
          if (this.turnId === undefined) {
            if (status === "starting") this.sawStarting = true;
            if (running && active) this.turnId = active;
          } else if (active !== this.turnId) {
            this.ended = true;
            this.endedAt = Date.now();
            this.endError = event.session.lastError;
            if (running) this.endStatus = "superseded";
            else this.endStatus = status === "interrupted" || status === "error" || status === "stopped" ? status : "ready";
            if (status === "stopped") this.stoppedAfterEnd = true;
          }
        } else if (status === "stopped") {
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
          this.preceded = this.pending;
          if (this.busy) {
            this.joined = true;
            if (this.active) this.turnId = this.active;
          }
        } else if (!this.seenOurs) {
          this.pending += 1;
        } else if (!this.ended) {
          this.foreign += 1;
        }
        return;
      case "assistant-message":
        if (this.turnId !== undefined && event.turnId === this.turnId && !this.ended) this.answerId = event.messageId;
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
    return this.joined || this.preceded > 0 || this.foreign > 0 || this.startedByUs === false || (!this.joined && !this.sawStarting);
  }

  /** What entered our turn besides our message, as reported (kinds only, never text). */
  entered(): { origin: string }[] {
    const out: { origin: string }[] = [];
    if (this.joined) out.push({ origin: "t3-turn-already-running" });
    if ((this.startedByUs === false || !this.sawStarting) && !this.joined) out.push({ origin: "t3-turn-not-started-by-us" });
    for (let i = 0; i < this.preceded; i++) out.push({ origin: "t3-user-message-before-ours" });
    for (let i = 0; i < this.foreign; i++) out.push({ origin: "t3-user-message" });
    return out;
  }
}

/**
 * Whether the thread's latest turn is `turnId` and was started by our message:
 * T3 copies the starting command's `createdAt` into the turn's `requestedAt`
 * (measured live). Undefined if the latest turn is a different one (can't tell).
 */
export function startedBy(thread: T3Thread, messageId: string, turnId: string): boolean | undefined {
  const ours = thread.messages.find((m) => m.id === messageId);
  if (!ours || thread.latestTurn?.turnId !== turnId) return undefined;
  return Date.parse(thread.latestTurn.requestedAt) === Date.parse(ours.createdAt);
}

/** The cursor saved with a delivery: the event sequence just before our message, and the turn we confirmed was ours. */
export function encodeCursor(sequence: number, confirmedTurnId?: string): string {
  return confirmedTurnId ? `${sequence}:${confirmedTurnId}` : String(sequence);
}

export function decodeCursor(cursor: string | undefined): { sequence: number; confirmedTurnId?: string } | undefined {
  if (cursor === undefined) return undefined;
  const [seq, turn] = cursor.split(":", 2);
  const sequence = Number(seq);
  if (!Number.isFinite(sequence)) return undefined;
  return turn ? { sequence, confirmedTurnId: turn } : { sequence };
}
