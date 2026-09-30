// The slice of a T3 thread the adapter reads, and the client it needs. Plain
// types: nothing of T3's (or its effect) crosses this boundary.
//
// Privacy: the client keeps no text of user messages at all, and the adapter
// reads assistant text only for the turn our own message went into.

export interface T3Message {
  id: string;
  role: "user" | "assistant" | "system";
  /** Null on user messages in v0.0.44 (Hazel, live); set on assistant messages. */
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  /** Assistant messages only. */
  text?: string;
}

export interface T3Thread {
  id: string;
  runtimeMode: string;
  interactionMode: string;
  session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
  latestTurn: {
    turnId: string;
    state: "running" | "interrupted" | "completed" | "error";
    requestedAt: string;
    completedAt: string | null;
  } | null;
  messages: T3Message[];
  /** Turns that have finished, from the thread's checkpoints. */
  finishedTurnIds: string[];
}

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
  /** Calls `onChange` whenever the thread may have changed. Returns an unsubscribe function. */
  watch(threadId: string, onChange: () => void): Promise<() => void>;
  close(): Promise<void>;
}

const RUNNING = new Set(["running", "starting"]);

export function isBusy(thread: T3Thread): boolean {
  if (thread.session && RUNNING.has(thread.session.status)) return true;
  return thread.latestTurn?.state === "running" && thread.latestTurn.completedAt === null;
}

/**
 * Our turn is over when T3 says so: it's the latest turn and no longer
 * running, or a checkpoint recorded it, or a later turn has begun (with no
 * server-side queue, a new turn only starts once ours has ended). A stale
 * `latestTurn` (the turn before ours) never counts.
 */
export function turnFinished(thread: T3Thread, turnId: string, messageId?: string): boolean {
  if (thread.latestTurn?.turnId === turnId) return thread.latestTurn.state !== "running" && !isActive(thread, turnId);
  if (thread.finishedTurnIds.includes(turnId)) return true;
  const times = thread.messages.filter((m) => m.turnId === turnId || m.id === messageId).map((m) => ms(m.createdAt));
  if (times.length === 0) return false;
  const start = Math.min(...times);
  if (thread.latestTurn && ms(thread.latestTurn.requestedAt) > start) return true;
  return thread.messages.some((m) => m.turnId !== null && m.turnId !== turnId && ms(m.createdAt) > start);
}

const ms = (iso: string) => Date.parse(iso);

function isActive(thread: T3Thread, turnId: string): boolean {
  return thread.session?.activeTurnId === turnId && RUNNING.has(thread.session.status);
}

/**
 * The turn a user message went into. v0.0.44 leaves `turnId` null on user
 * messages, so it's read from T3's other records, in order:
 * 1. the first turn-tagged message created after ours (the turn's output);
 * 2. the session's active turn, once our message is there and it's running;
 * 3. the latest turn, if it was requested at our message's own timestamp.
 * With no server-side queue, a message sent into a running turn joins it, so
 * all three name the turn our message is in.
 */
export function turnOf(thread: T3Thread, messageId: string): string | undefined {
  const ours = thread.messages.find((m) => m.id === messageId);
  if (!ours) return undefined;
  if (ours.turnId) return ours.turnId;
  const after = thread.messages
    .filter((m) => m.turnId !== null && m.createdAt > ours.createdAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  if (after) return after.turnId!;
  if (thread.session?.activeTurnId && RUNNING.has(thread.session.status)) return thread.session.activeTurnId;
  if (thread.latestTurn && thread.latestTurn.requestedAt === ours.createdAt) return thread.latestTurn.turnId;
  return undefined;
}

/**
 * User messages other than ours that entered the same turn: created after the
 * previous turn's last output and no later than our turn's end. Includes the
 * message that started the turn when ours was steered into someone else's.
 * Errs toward including: an extra message only makes a delivery ambiguous,
 * never misattributed.
 */
export function othersInTurn(thread: T3Thread, messageId: string, turnId: string): T3Message[] {
  const ours = thread.messages.find((m) => m.id === messageId);
  if (!ours) return [];
  // Where our turn began: exactly, when it's the latest turn; otherwise after the last output of any earlier turn.
  const latestIsOurs = thread.latestTurn?.turnId === turnId;
  const earlierOutput = thread.messages
    .filter((m) => m.turnId !== null && m.turnId !== turnId && ms(m.createdAt) < ms(ours.createdAt))
    .reduce((a, m) => Math.max(a, ms(m.createdAt)), Number.NEGATIVE_INFINITY);
  const start = latestIsOurs ? ms(thread.latestTurn!.requestedAt) : earlierOutput + 1;
  const lastOutput = thread.messages
    .filter((m) => m.turnId === turnId)
    .reduce((a, m) => Math.max(a, ms(m.createdAt)), ms(ours.createdAt));
  const completed = latestIsOurs && thread.latestTurn!.completedAt ? ms(thread.latestTurn!.completedAt) : Number.NEGATIVE_INFINITY;
  const end = Math.max(lastOutput, completed);
  return thread.messages.filter((m) => m.role === "user" && m.id !== messageId && ms(m.createdAt) >= start && ms(m.createdAt) <= end);
}
