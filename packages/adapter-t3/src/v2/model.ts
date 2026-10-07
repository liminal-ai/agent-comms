// The slice of T3's orchestration protocol 2 (v0.0.46, 8ed276c) the adapter reads,
// the client it needs, and the rules that tie our message to its run. Plain types:
// nothing of T3's crosses this boundary. Reference: docs/t3-v2-notes.md.
//
// What V2 changes for us (against v0.0.44's turns):
// - A run records the message that started it (`userMessageId`), so "which run is
//   ours" is a lookup, not an inference from event order and clocks.
// - A message dispatched to a busy thread is queued as its own run; it joins a
//   running run only if someone asks to steer. So foreign input in our run is a
//   user message whose `runId` is ours and whose id isn't.
// - Interrupted, failed and cancelled are run states of their own.
// - Command and tool output never reaches a client, so a T3 agent's view of a
//   `comms send` answer can't be proven: T3 answers still fall back (fix pass 0.1).
//
// Privacy: the client keeps no user message text; it keeps assistant text only.

/** Run states (orchestrationV2.ts RunStatus). */
export type RunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

/** A run a message can be steered into. */
export const STEERABLE: readonly RunStatus[] = ["starting", "running"];

/** A run that keeps the thread busy (a dispatch would queue behind it). */
export const BLOCKING: readonly RunStatus[] = ["preparing", "queued", "starting", "running", "waiting"];
/** The agent's turn is over: `waiting` is completed-but-checkpointing (RunExecutionService). */
export const TURN_OVER: readonly RunStatus[] = ["waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"];

export interface V2Run {
  id: string;
  ordinal: number;
  /** The user message that created the run. */
  userMessageId: string;
  status: RunStatus;
}

/** An attempt of a run. A human `restart_active` steer adds a `steering_restart` attempt to the run it steers. */
export interface V2Attempt {
  runId: string;
  reason: "initial" | "steering_restart" | "retry" | "provider_recovery";
}

export interface V2Message {
  id: string;
  role: "user" | "assistant" | "system";
  /** The run the message is in (always set on user messages). */
  runId: string | null;
}

/** An assistant message as a turn item of a run: the latest upsert of the whole row. */
export interface V2Answer {
  runId: string;
  messageId: string;
  ordinal: number;
  streaming: boolean;
  text: string;
}

export interface V2Error {
  runId: string;
  message: string;
}

export interface V2Thread {
  id: string;
  snapshotSequence: number;
  runs: V2Run[];
  attempts: V2Attempt[];
  messages: V2Message[];
  answers: V2Answer[];
  errors: V2Error[];
}

export type V2Event =
  | { type: "run"; sequence: number; run: V2Run }
  | { type: "attempt"; sequence: number; attempt: V2Attempt }
  | { type: "message"; sequence: number; message: V2Message }
  | { type: "answer"; sequence: number; answer: V2Answer }
  | { type: "error"; sequence: number; error: V2Error }
  | { type: "other"; sequence: number };

export type V2StreamItem =
  | { kind: "snapshot"; thread: V2Thread }
  | { kind: "event"; event: V2Event }
  /** The replay after `afterSequence` is done; live events follow. */
  | { kind: "synchronized" };

/** The dispatch was refused, and that is certain (T3 says the command was previously rejected). */
export class V2Rejected extends Error {}

export interface V2Client {
  connected(): Promise<boolean>;
  /** The whole thread (HTTP full snapshot), or null if it doesn't exist. */
  getThread(threadId: string): Promise<V2Thread | null>;
  /**
   * `message.dispatch`: into the active run (`steer`, `steer_active`), or as a run of its own
   * (`start_immediately`). `commandId` is T3's idempotency key: the same id again returns the
   * first result and runs nothing twice. Throws V2Rejected if T3 recorded the command as
   * rejected; any other error may or may not have been accepted.
   */
  dispatch(threadId: string, message: { commandId: string; messageId: string; text: string; steer?: string }): Promise<{ sequence: number }>;
  /** The thread's stream: a snapshot (or a replay after `afterSequence`), `synchronized`, then live events. */
  subscribe(threadId: string, options: { afterSequence?: number }, onItem: (item: V2StreamItem | { kind: "closed" }) => void): Promise<() => void>;
  close(): Promise<void>;
}

export const isBusy = (thread: Pick<V2Thread, "runs">): boolean => thread.runs.some((r) => BLOCKING.includes(r.status));

/**
 * What the snapshot says about our message: the run it started (`run`), or the run it
 * was put in otherwise (`steeredInto`: then the run isn't ours), or nothing. The thread
 * records which run every message is in, so a snapshot alone shows foreign input in our
 * run: user messages in it that aren't ours, and restarts a steer forced on it.
 */
export function find(thread: V2Thread, messageId: string) {
  const message = thread.messages.find((m) => m.id === messageId);
  const run = thread.runs.find((r) => r.userMessageId === messageId);
  const steeredInto = !run && message?.runId ? thread.runs.find((r) => r.id === message.runId) : undefined;
  const entered: { origin: string }[] = [];
  if (run) {
    for (const m of thread.messages) if (m.role === "user" && m.runId === run.id && m.id !== messageId) entered.push({ origin: "t3-user-message" });
    for (const a of thread.attempts) if (a.runId === run.id && a.reason === "steering_restart") entered.push({ origin: "t3-steering-restart" });
  }
  return { present: !!message || !!run, run, steeredInto, entered };
}

/** Our run's answer: its last finished assistant message (the v0.0.44 rule was "last"). */
export function answerOf(thread: V2Thread, runId: string): V2Answer | undefined {
  return thread.answers.filter((a) => a.runId === runId && !a.streaming).sort((a, b) => a.ordinal - b.ordinal).at(-1);
}

/**
 * Follows the stream to know when to look: whether the thread is busy, and the run our
 * message started and its status. What happened in the run is read from a snapshot.
 */
export class RunTracker {
  readonly messageId: string;
  runId: string | undefined;
  status: RunStatus | undefined;
  /** When our run reached `waiting` (turn over, checkpoint pending). */
  waitingSince: number | undefined;
  lastSequence = 0;
  /** Runs keeping the thread busy, by id. */
  private readonly blocking = new Set<string>();
  /** Runs a message can be steered into (starting, running or waiting on its turn). */
  private readonly active = new Map<string, number>();
  /** When our message was steered into a run it didn't start: that run. */
  steeredRunId: string | undefined;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  /** From a snapshot: the state of every run. */
  load(thread: V2Thread): void {
    this.lastSequence = Math.max(this.lastSequence, thread.snapshotSequence);
    this.blocking.clear();
    this.active.clear();
    const steered = find(thread, this.messageId).steeredInto;
    if (steered) this.steeredRunId = steered.id;
    for (const r of thread.runs) this.run(r);
  }

  /** Follow the run our message was steered into, as if it were ours. */
  adopt(runId: string): void {
    this.steeredRunId = runId;
    this.runId = runId;
  }

  feed(event: V2Event): void {
    this.lastSequence = Math.max(this.lastSequence, event.sequence);
    if (event.type === "run") this.run(event.run);
  }

  private run(r: V2Run): void {
    if (BLOCKING.includes(r.status)) this.blocking.add(r.id);
    else this.blocking.delete(r.id);
    if (STEERABLE.includes(r.status)) this.active.set(r.id, this.active.get(r.id) ?? this.active.size);
    else this.active.delete(r.id);
    if (r.userMessageId === this.messageId || r.id === this.steeredRunId) {
      this.runId = r.id;
      if (r.status === "waiting" && this.status !== "waiting") this.waitingSince = Date.now();
      this.status = r.status;
    }
  }

  get busy(): boolean {
    return this.blocking.size > 0;
  }
  /** The run a message would be steered into now, if any. */
  get activeRunId(): string | undefined {
    return [...this.active.keys()].at(-1);
  }
  /** Our run is over and won't change: final, not just `waiting`. */
  get final(): boolean {
    return this.status !== undefined && this.status !== "waiting" && TURN_OVER.includes(this.status);
  }
}

/** The cursor saved with `delivered`: version 2, so a v0.0.44 cursor is never misread. */
export const encodeCursor = (sequence: number) => `v2:${sequence}`;
export const decodeCursor = (cursor: string | undefined) => {
  const m = /^v2:(\d+)$/.exec(cursor ?? "");
  return m ? Number(m[1]) : undefined;
};
