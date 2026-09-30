// The slice of a T3 thread the adapter reads, and the client it needs. Plain
// types: nothing of T3's (or its effect) crosses this boundary.
//
// Privacy: the client keeps no text of user messages at all, and the adapter
// reads assistant text only for the turn our own message went into.

export interface T3Message {
  id: string;
  role: "user" | "assistant" | "system";
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
  latestTurn: { turnId: string; state: "running" | "interrupted" | "completed" | "error"; completedAt: string | null } | null;
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
 * running, or a checkpoint recorded it, or a different turn started after it.
 * A stale `latestTurn` (the turn before ours) never counts.
 */
export function turnFinished(thread: T3Thread, turnId: string): boolean {
  if (thread.latestTurn?.turnId === turnId) return thread.latestTurn.state !== "running" && !isActive(thread, turnId);
  if (thread.finishedTurnIds.includes(turnId)) return true;
  const ours = thread.messages.filter((m) => m.turnId === turnId).map((m) => m.createdAt);
  if (ours.length === 0) return false;
  const start = ours.reduce((a, b) => (a < b ? a : b));
  return thread.messages.some((m) => m.turnId !== null && m.turnId !== turnId && m.createdAt > start);
}

function isActive(thread: T3Thread, turnId: string): boolean {
  return thread.session?.activeTurnId === turnId && RUNNING.has(thread.session.status);
}
