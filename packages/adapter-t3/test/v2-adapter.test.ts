// The V2 adapter (T3 orchestration protocol 2, closeout docs/08 section 2) against a
// small T3 that behaves like v0.0.46 as read from its source (notes in docs/t3-v2-notes.md).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Delivery } from "@agent-comms/protocol";
import {
  commandIdFor,
  decodeCursor,
  makeT3AdapterV2,
  messageIdFor,
  noticeIdFor,
  type RunStatus,
  V2Rejected,
  type V2Client,
  type V2Event,
  type V2StreamItem,
  type V2Thread,
} from "../src/v2/index.ts";

type EventInput = V2Event extends infer E ? (E extends V2Event ? Omit<E, "sequence"> : never) : never;
type Item = V2StreamItem | { kind: "closed" };

/**
 * A small T3 v0.0.46: a message dispatched with `start_immediately` is its own run,
 * queued behind a busy one; a human can queue, steer into the running run, or restart
 * it. `commandId` is idempotent: an accepted command returns its first sequence, a
 * rejected one fails "previously rejected". Every change is a sequenced event.
 */
class FakeV2 implements V2Client {
  private thread: V2Thread;
  private log: V2Event[] = [];
  listeners = new Set<(i: Item) => void>();
  private seq = 100;
  private receipts = new Map<string, { sequence: number } | { rejected: string }>();
  /** Refuse the next dispatches with this reason (recorded as rejected). */
  refuse: string | undefined;
  /** Commit the next dispatch but lose its response. */
  dropResponse = 0;
  /** T3 restarts after losing a response and forgets its command receipts (if they weren't persisted). */
  forgetReceipts = false;
  /** Fail the next dispatches before they reach T3 (nothing committed). */
  unreachable = 0;
  failResubscribes = 0;
  eventsGone = false;
  dispatched: { commandId: string; messageId: string; text: string }[] = [];

  readonly id: string;
  constructor(id = "th1") {
    this.id = id;
    this.thread = { id, snapshotSequence: this.seq, runs: [], attempts: [], messages: [], answers: [], errors: [] };
  }

  private emit(e: EventInput) {
    const event = { ...e, sequence: ++this.seq } as V2Event;
    this.log.push(event);
    this.thread.snapshotSequence = this.seq;
    for (const f of [...this.listeners]) setTimeout(() => f({ kind: "event", event: structuredClone(event) }), 1);
  }
  private active() {
    return this.thread.runs.find((r) => ["starting", "running", "waiting"].includes(r.status));
  }
  private blocking() {
    return this.thread.runs.some((r) => ["preparing", "queued", "starting", "running", "waiting"].includes(r.status));
  }
  private setRun(runId: string, status: RunStatus) {
    const run = this.thread.runs.find((r) => r.id === runId)!;
    run.status = status;
    this.emit({ type: "run", run: { ...run } });
    if (!["preparing", "queued", "starting", "running", "waiting"].includes(status)) this.startNext();
  }
  private startNext() {
    if (this.active()) return;
    const next = this.thread.runs.find((r) => r.status === "queued");
    if (!next) return;
    this.setRun(next.id, "starting");
    this.setRun(next.id, "running");
  }
  /** A user message as its own run: started now on an idle thread, queued behind a busy one. */
  private newRun(messageId: string) {
    const busy = this.blocking();
    const ordinal = this.thread.runs.length + 1;
    const runId = `run:thread:${this.id}:ordinal:${ordinal}`;
    this.thread.messages.push({ id: messageId, role: "user", runId });
    this.emit({ type: "message", message: { id: messageId, role: "user", runId } });
    const run = { id: runId, ordinal, userMessageId: messageId, status: (busy ? "queued" : "starting") as RunStatus };
    this.thread.runs.push(run);
    this.emit({ type: "run", run: { ...run } });
    this.thread.attempts.push({ runId, reason: "initial" });
    this.emit({ type: "attempt", attempt: { runId, reason: "initial" } });
    if (!busy) this.setRun(runId, "running");
    return runId;
  }

  // V2Client
  async connected() {
    return true;
  }
  async getThread(id: string) {
    return id === this.id ? structuredClone(this.thread) : null;
  }
  async dispatch(id: string, m: { commandId: string; messageId: string; text: string }) {
    if (this.unreachable > 0) {
      this.unreachable -= 1;
      throw new Error("ECONNREFUSED");
    }
    const receipt = this.receipts.get(m.commandId);
    if (receipt && "rejected" in receipt) throw new V2Rejected(`Command ${m.commandId} was previously rejected: ${receipt.rejected}`);
    if (receipt) return receipt;
    if (this.refuse) {
      this.receipts.set(m.commandId, { rejected: this.refuse });
      throw new Error(this.refuse); // every dispatch error is one tag on the wire
    }
    assert.equal(id, this.id);
    this.dispatched.push(m);
    this.newRun(m.messageId);
    const result = { sequence: this.seq };
    this.receipts.set(m.commandId, result);
    if (this.dropResponse > 0) {
      this.dropResponse -= 1;
      if (this.forgetReceipts) this.receipts.clear();
      throw new Error("socket closed");
    }
    return result;
  }
  drop() {
    const subs = [...this.listeners];
    this.listeners.clear();
    for (const f of subs) setTimeout(() => f({ kind: "closed" }), 1);
  }
  async subscribe(id: string, options: { afterSequence?: number }, onItem: (i: Item) => void): Promise<() => void> {
    if (id !== this.id) throw new Error("no such thread");
    if (options.afterSequence !== undefined && this.failResubscribes > 0) {
      this.failResubscribes -= 1;
      throw new Error("ECONNREFUSED");
    }
    if (options.afterSequence === undefined || this.eventsGone) {
      const snap = structuredClone(this.thread);
      setTimeout(() => {
        onItem({ kind: "snapshot", thread: snap });
        onItem({ kind: "synchronized" });
      }, 1);
    } else {
      const replay = this.log.filter((e) => e.sequence > options.afterSequence!);
      setTimeout(() => {
        for (const event of replay) onItem({ kind: "event", event: structuredClone(event) });
        onItem({ kind: "synchronized" });
      }, 1);
    }
    this.listeners.add(onItem);
    return () => void this.listeners.delete(onItem);
  }
  async close() {}

  // What people and models do
  /** Lee types: `queue` (its own run), `steer` (into the running run) or `restart` (the running run restarts with it). */
  human(messageId: string, mode: "queue" | "steer" | "restart" = "queue") {
    const active = this.active();
    if (mode === "queue" || !active) return this.newRun(messageId);
    this.thread.messages.push({ id: messageId, role: "user", runId: active.id });
    this.emit({ type: "message", message: { id: messageId, role: "user", runId: active.id } });
    if (mode === "restart") {
      this.thread.attempts.push({ runId: active.id, reason: "steering_restart" });
      this.emit({ type: "attempt", attempt: { runId: active.id, reason: "steering_restart" } });
    }
    return active.id;
  }
  /** An assistant message in the running run: a whole-row upsert, streaming until final. */
  assistant(text: string, opts: { streaming?: boolean; messageId?: string } = {}) {
    const run = this.active()!;
    const messageId = opts.messageId ?? `assistant:${this.thread.answers.length}`;
    const answer = { runId: run.id, messageId, ordinal: this.thread.answers.length + 1, streaming: opts.streaming ?? false, text };
    const i = this.thread.answers.findIndex((a) => a.messageId === messageId);
    if (i >= 0) this.thread.answers[i] = { ...answer, ordinal: this.thread.answers[i]!.ordinal };
    else this.thread.answers.push(answer);
    this.thread.messages = this.thread.messages.filter((m) => m.id !== messageId).concat({ id: messageId, role: "assistant", runId: run.id });
    this.emit({ type: "answer", answer: { ...answer } });
  }
  /** The run's turn ends: `waiting` (checkpoint pending), then `completed` unless told to stay. */
  finish(opts: { stayWaiting?: boolean } = {}) {
    const run = this.active()!;
    this.setRun(run.id, "waiting");
    if (!opts.stayWaiting) setTimeout(() => this.setRun(run.id, "completed"), 20);
  }
  complete(runId: string) {
    this.setRun(runId, "completed");
  }
  end(status: "interrupted" | "cancelled" | "failed", error?: string) {
    const run = this.active()!;
    if (error) {
      this.thread.errors.push({ runId: run.id, message: error });
      this.emit({ type: "error", error: { runId: run.id, message: error } });
    }
    this.setRun(run.id, status);
  }
  rollBack(runId: string) {
    this.setRun(runId, "rolled_back");
  }
  runOf(messageId: string) {
    return this.thread.runs.find((r) => r.userMessageId === messageId);
  }
  userMessages() {
    return this.thread.messages.filter((m) => m.role === "user").map((m) => m.id);
  }
}

const delivery = (id = "d_1", kind: "request" | "answer" = "request"): Delivery => ({
  id,
  recipient: { id: "p_tee", name: "tee", kind: "agent" },
  conversation: { id: "c_1", kind: "dm" },
  message: {
    id: `m_${id}`,
    conversationId: "c_1",
    seq: 1,
    sender: { id: "p_a", name: "a", kind: "agent" },
    recipients: [{ id: "p_tee", name: "tee", kind: "agent" }],
    kind,
    text: "what's 2+2?",
    attachments: [],
    createdAt: 0,
    origin: { via: "cli" },
  },
  history: { messages: [], omitted: 0 },
  status: { state: "claimed", at: 0 },
});

const target = { participant: "tee", locator: "th1" };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const options = { acceptTimeoutMs: 500, waitingSettleMs: 200, idlePollMs: 20, retryDelayMs: 10 };
const setup = () => {
  const t3 = new FakeV2();
  return { t3, adapter: makeT3AdapterV2({ client: t3, ...options }) };
};
type Adapter = ReturnType<typeof setup>["adapter"];
const accepted = async (adapter: Adapter, d = delivery()) => {
  const h = await adapter.handOff(target, d);
  assert.equal(h._tag, "accepted", JSON.stringify(h));
  return h as { _tag: "accepted"; turnId: string; cursor?: string };
};

describe("T3 V2 adapter: live", () => {
  it("dispatches our message as its own run on an idle thread; the run is the turn", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    assert.equal(h.turnId, "run:thread:th1:ordinal:1");
    assert.equal(decodeCursor(h.cursor), 100, "cursor: the sequence before our message");
    assert.deepEqual(t3.dispatched.map((d) => [d.commandId, d.messageId]), [[commandIdFor("d_1"), messageIdFor("d_1")]]);
    assert.match(t3.dispatched[0]!.text, /^\[agent-comms v1\] delivery=d_1 /);
    assert.match(t3.dispatched[0]!.text, /^Source: agent-comms/m);
  });

  it("collects the run's last finished assistant message, never a streaming one", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.assistant("Let me think.");
    t3.assistant("4 and a bit", { streaming: true, messageId: "final" });
    await tick();
    t3.assistant("4", { messageId: "final" });
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("waits for a busy thread as a courtesy, then runs as its own run", async () => {
    const { t3, adapter } = setup();
    t3.human("lee-typed");
    const handOff = adapter.handOff(target, delivery());
    await tick(80);
    assert.deepEqual(t3.userMessages(), ["lee-typed"], "didn't send while busy");
    t3.assistant("done with Lee's thing");
    t3.finish();
    const h = await handOff;
    assert.equal((h as { turnId: string }).turnId, "run:thread:th1:ordinal:2");
    const outcome = adapter.awaitOutcome(target, delivery(), "run:thread:th1:ordinal:2");
    t3.assistant("4");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("losing the idle race queues our message as its own run: accepted, not ambiguous", async () => {
    const { t3, adapter } = setup();
    const real = t3.dispatch.bind(t3);
    t3.dispatch = async (id, m) => {
      t3.human("lee-raced"); // Lee's run starts in the gap after our idle check
      return real(id, m);
    };
    const h = await accepted(adapter);
    assert.equal(t3.runOf(messageIdFor("d_1"))!.status, "queued");
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.assistant("Lee's answer");
    t3.finish();
    await tick(60);
    t3.assistant("4");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("is ambiguous when Lee steers into our run, or restarts it with his message; reports only that it happened", async () => {
    for (const [mode, entered] of [
      ["steer", [{ origin: "t3-user-message" }]],
      ["restart", [{ origin: "t3-user-message" }, { origin: "t3-steering-restart" }]],
    ] as const) {
      const { t3, adapter } = setup();
      const h = await accepted(adapter);
      const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
      t3.human("lee-steer", mode);
      t3.assistant("an answer to both");
      t3.finish();
      assert.deepEqual(await outcome, { _tag: "ambiguous", entered }, mode);
    }
  });

  it("isn't ambiguous when Lee's message queues behind ours as its own run", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.human("lee-next", "queue");
    t3.assistant("4");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("reports interrupted, cancelled and failed runs as failed, never collecting a partial answer", async () => {
    const cases = [
      ["interrupted", undefined, { _tag: "failed", reason: "aborted", detail: "the run was interrupted" }],
      ["cancelled", undefined, { _tag: "failed", reason: "aborted", detail: "the run was cancelled" }],
      ["failed", "provider crashed", { _tag: "failed", reason: "error", detail: "provider crashed" }],
      ["failed", undefined, { _tag: "failed", reason: "error", detail: "the run failed" }],
    ] as const;
    for (const [status, error, expected] of cases) {
      const { t3, adapter } = setup();
      const h = await accepted(adapter);
      const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
      t3.assistant("Once upon a ti");
      t3.end(status, error);
      assert.deepEqual(await outcome, expected, status);
    }
  });

  it("a run that ends with no answer has failed", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "failed", reason: "error", detail: "the run produced no answer" });
  });

  it("a run stuck in waiting (checkpoint never lands) is read after the settle window", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.assistant("4");
    t3.finish({ stayWaiting: true });
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("rejects a refused dispatch (confirmed by the same commandId) and a missing thread", async () => {
    const { t3, adapter } = setup();
    t3.refuse = "thread is archived";
    const h = await adapter.handOff(target, delivery("d_a"));
    assert.equal(h._tag, "rejected", JSON.stringify(h));
    assert.match((h as { detail: string }).detail, /archived/);
    assert.deepEqual(t3.userMessages(), []);
    assert.equal((await adapter.handOff({ participant: "tee", locator: "nope" }, delivery("d_c")))._tag, "rejected");
  });

  it("a lost dispatch response is retried with the same commandId: one message, one run", async () => {
    const { t3, adapter } = setup();
    t3.dropResponse = 1;
    const h = await accepted(adapter);
    assert.equal(h.turnId, "run:thread:th1:ordinal:1");
    assert.deepEqual(t3.userMessages(), [messageIdFor("d_1")]);
    assert.equal(t3.dispatched.length, 1);
  });

  it("Reed: the retry doesn't depend on T3 remembering the command: our message in the thread means sent", async () => {
    const { t3, adapter } = setup();
    t3.dropResponse = 1;
    t3.forgetReceipts = true;
    const h = await accepted(adapter);
    assert.equal(h.turnId, "run:thread:th1:ordinal:1");
    assert.equal(t3.dispatched.length, 1, "not dispatched again");
    assert.deepEqual(t3.userMessages(), [messageIdFor("d_1")]);
  });

  it("T3 unreachable on send and on retry: lost; the next handoff sends once", async () => {
    const { t3, adapter } = setup();
    t3.unreachable = 2;
    assert.equal((await adapter.handOff(target, delivery()))._tag, "lost");
    assert.deepEqual(t3.userMessages(), []);
    await accepted(adapter);
    assert.equal(t3.dispatched.length, 1);
  });

  it("a second handoff of a delivery already dispatched finds its run and sends nothing (claim lost and re-claimed)", async () => {
    const { t3, adapter } = setup();
    const first = await accepted(adapter);
    const other = makeT3AdapterV2({ client: t3, ...options }); // another connector process
    const again = await accepted(other);
    assert.equal(again.turnId, first.turnId);
    assert.equal(t3.dispatched.length, 1);
    assert.deepEqual(t3.userMessages(), [messageIdFor("d_1")]);
  });

  it("reports presence from the runs: queued and waiting are busy", async () => {
    const { t3, adapter } = setup();
    assert.equal(await adapter.presence(target), "idle");
    t3.human("lee");
    assert.equal(await adapter.presence(target), "busy");
    t3.finish({ stayWaiting: true });
    assert.equal(await adapter.presence(target), "busy", "waiting");
    assert.equal(await adapter.presence({ participant: "tee", locator: "nope" }), "offline");
  });

  it("sends the unmatched notice once, as its own run, after the thread is idle", async () => {
    const { t3, adapter } = setup();
    await adapter.notifyUnmatched(target, delivery());
    await adapter.notifyUnmatched(target, delivery());
    assert.deepEqual(t3.userMessages(), [noticeIdFor("d_1")]);
    assert.match(t3.dispatched[0]!.text, /couldn't be matched|unmatched|no request/i);
  });

  it("an answer's delivery leaves no subscription behind", async () => {
    const { t3, adapter } = setup();
    await accepted(adapter, delivery("d_ans", "answer"));
    await tick();
    assert.equal(t3.listeners.size, 0);
  });
});

describe("T3 V2 adapter: gate", () => {
  it("re-checks the claim right before sending; a lost claim sends nothing", async () => {
    const { t3, adapter } = setup();
    const confirmed: (string | undefined)[] = [];
    const h = await adapter.handOff(target, delivery(), { confirm: async (c) => (confirmed.push(c), false), signal: new AbortController().signal });
    assert.equal(h._tag, "aborted");
    assert.deepEqual(confirmed, ["v2:100"]);
    assert.deepEqual(t3.userMessages(), []);
  });

  it("an aborted handoff (claim lost during the courtesy wait) sends nothing", async () => {
    const { t3, adapter } = setup();
    t3.human("lee");
    const ac = new AbortController();
    const h = adapter.handOff(target, delivery(), { confirm: async () => true, signal: ac.signal });
    await tick(60);
    ac.abort();
    assert.equal((await h)._tag, "aborted");
    t3.finish();
    await tick(60);
    assert.deepEqual(t3.userMessages(), ["lee"]);
  });
});

describe("T3 V2 adapter: restart check (from one snapshot)", () => {
  it("absent when our message never arrived", async () => {
    const { adapter } = setup();
    assert.deepEqual(await adapter.check(target, delivery(), undefined), { _tag: "absent" });
  });

  it("running while its run runs, then completed with the outcome, in a new process", async () => {
    const { t3, adapter } = setup();
    t3.human("lee");
    const h = adapter.handOff(target, delivery());
    await tick(40);
    t3.finish();
    const { turnId } = (await h) as { turnId: string };
    const after = makeT3AdapterV2({ client: t3, ...options });
    assert.deepEqual(await after.check(target, delivery(), turnId), { _tag: "running", turnId });
    t3.assistant("4");
    t3.finish();
    await tick(60);
    assert.deepEqual(await after.check(target, delivery(), turnId), { _tag: "completed", turnId, outcome: { _tag: "replied", answer: "4" } });
  });

  it("queued counts as running", async () => {
    const { t3 } = setup();
    t3.human("lee");
    await t3.dispatch("th1", { commandId: commandIdFor("d_1"), messageId: messageIdFor("d_1"), text: "x" });
    const after = makeT3AdapterV2({ client: t3, ...options });
    const runId = t3.runOf(messageIdFor("d_1"))!.id;
    assert.deepEqual(await after.check(target, delivery(), undefined), { _tag: "running", turnId: runId });
  });

  it("sees foreign input that entered our run while the connector was down", async () => {
    const { t3, adapter } = setup();
    const { turnId } = await accepted(adapter);
    t3.human("lee-steer", "steer");
    t3.assistant("both");
    t3.finish();
    await tick(60);
    const after = makeT3AdapterV2({ client: t3, ...options });
    assert.deepEqual(await after.check(target, delivery(), turnId), {
      _tag: "completed",
      turnId,
      outcome: { _tag: "ambiguous", entered: [{ origin: "t3-user-message" }] },
    });
  });

  it("an interrupted run is completed as failed (aborted), its partial answer never collected", async () => {
    const { t3, adapter } = setup();
    const { turnId } = await accepted(adapter);
    t3.assistant("Once upon");
    t3.end("interrupted");
    const after = makeT3AdapterV2({ client: t3, ...options });
    assert.deepEqual(await after.check(target, delivery(), turnId), {
      _tag: "completed",
      turnId,
      outcome: { _tag: "failed", reason: "aborted", detail: "the run was interrupted" },
    });
  });

  it("a rolled-back run is unknown: its outcome no longer stands", async () => {
    const { t3, adapter } = setup();
    const { turnId } = await accepted(adapter);
    t3.assistant("4");
    t3.finish();
    await tick(60);
    t3.rollBack(turnId);
    const after = makeT3AdapterV2({ client: t3, ...options });
    assert.equal((await after.check(target, delivery(), turnId))._tag, "unknown");
  });

  it("T3 down: later; thread gone: unknown", async () => {
    const { t3, adapter } = setup();
    t3.getThread = async () => {
      throw new Error("ECONNREFUSED");
    };
    assert.equal((await adapter.check(target, delivery(), undefined))._tag, "later");
    assert.equal((await setup().adapter.check({ participant: "tee", locator: "nope" }, delivery(), undefined))._tag, "unknown");
  });

  it("never reads a v0.0.44 cursor as a V2 one", () => {
    assert.equal(decodeCursor("100:turn-1"), undefined);
    assert.equal(decodeCursor("v2:100"), 100);
  });
});

describe("T3 V2 adapter: stream", () => {
  it("a dropped stream is resubscribed with retries, and the run still resolves", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.failResubscribes = 1;
    t3.drop();
    await tick(20);
    t3.assistant("4");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("a resubscription that gets a snapshot (events gone) still resolves from the thread's records", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.eventsGone = true;
    t3.drop();
    t3.human("lee-steer", "steer");
    t3.assistant("both");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "ambiguous", entered: [{ origin: "t3-user-message" }] });
  });
});

describe("docs/09: V2 adapter fixes", () => {
  // Alder's repro (review 2026-10-03): the first attempt never reached T3, then the claim is lost.
  it("P1: no retry dispatch after the claim is lost", async () => {
    const t3 = new FakeV2();
    const abort = new AbortController();
    const original = t3.dispatch.bind(t3);
    let attempts = 0;
    t3.dispatch = async (id, m) => {
      attempts++;
      if (attempts === 1) {
        abort.abort();
        throw new Error("socket closed before send");
      }
      return original(id, m);
    };
    const adapter = makeT3AdapterV2({ client: t3, ...options });
    const h = await adapter.handOff(target, delivery("retry-claim"), { signal: abort.signal, confirm: async () => true });
    assert.equal(t3.dispatched.length, 0, "a claim-lost connector must not issue a new dispatch");
    assert.equal(h._tag, "lost", "the first attempt may have reached T3: lost, so the restart check decides");
  });

  it("P1: the claim is confirmed again before the retry; refused there, nothing is sent", async () => {
    const t3 = new FakeV2();
    t3.unreachable = 1;
    const confirms: (string | undefined)[] = [];
    const adapter = makeT3AdapterV2({ client: t3, ...options });
    const h = await adapter.handOff(target, delivery(), { signal: new AbortController().signal, confirm: async (c) => (confirms.push(c), confirms.length === 1) });
    assert.equal(confirms.length, 2, "confirmed before the first dispatch and again before the retry");
    assert.equal(t3.dispatched.length, 0);
    assert.equal(h._tag, "lost");
  });

  it("P1: a retry whose message is already in the thread needs no new dispatch, so no confirm", async () => {
    const t3 = new FakeV2();
    t3.dropResponse = 1;
    const confirms: (string | undefined)[] = [];
    const adapter = makeT3AdapterV2({ client: t3, ...options });
    const h = await adapter.handOff(target, delivery(), { signal: new AbortController().signal, confirm: async (c) => (confirms.push(c), true) });
    assert.equal(h._tag, "accepted");
    assert.equal(confirms.length, 1);
    assert.equal(t3.dispatched.length, 1);
  });

  // Alder's repro: the socket connects but every stream closes at once; each resolved subscribe
  // cleared the outage clock, so the outage limit never triggered recovery (35 opens in 350 ms).
  it("P2: repeated failed subscriptions honor the stream outage limit, with backoff", async () => {
    const t3 = new FakeV2();
    const subscribe = t3.subscribe.bind(t3);
    let failing = false;
    let opens = 0;
    t3.subscribe = async (id, opts, cb) => {
      if (!failing) return subscribe(id, opts, cb);
      opens++;
      const timer = setTimeout(() => cb({ kind: "closed" }), 10);
      return () => void clearTimeout(timer);
    };
    const adapter = makeT3AdapterV2({ client: t3, ...options, streamDownLimitMs: 50 });
    await accepted(adapter);
    const pending = adapter.awaitOutcome(target, delivery(), "");
    failing = true;
    t3.drop();
    const result = await Promise.race([pending, tick(350).then(() => ({ _tag: "review-timeout" }))]);
    failing = false;
    t3.end("cancelled");
    await pending;
    assert.equal(result?._tag, "lost", "a continuous outage doesn't restart its clock on an unproven subscription");
    assert.ok(opens <= 4, `closed streams back off too (${opens} opens in 350 ms)`);
  });

  it("P2: a stream that comes back and synchronizes clears the outage; the run still resolves", async () => {
    const t3 = new FakeV2();
    const subscribe = t3.subscribe.bind(t3);
    let failures = 2;
    t3.subscribe = async (id, opts, cb) => {
      if (opts.afterSequence === undefined || failures <= 0) return subscribe(id, opts, cb);
      failures--;
      const timer = setTimeout(() => cb({ kind: "closed" }), 10);
      return () => void clearTimeout(timer);
    };
    const adapter = makeT3AdapterV2({ client: t3, ...options, streamDownLimitMs: 5_000 });
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.drop();
    await tick(1_500);
    t3.assistant("4");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("3: the courtesy wait for idle is capped; then our message is sent and queued as its own run", async () => {
    const t3 = new FakeV2();
    t3.human("lee-long"); // Lee's run never ends during the test
    const adapter = makeT3AdapterV2({ client: t3, ...options, idleWaitMs: 300 });
    const started = Date.now();
    const h = await Promise.race([adapter.handOff(target, delivery()), tick(2_000).then(() => ({ _tag: "still-waiting" }))]);
    assert.equal(h._tag, "accepted", JSON.stringify(h));
    assert.ok(Date.now() - started >= 300, "waited the courtesy period first");
    assert.equal(t3.runOf(messageIdFor("d_1"))!.status, "queued");
    assert.equal(t3.dispatched.length, 1);
  });
});

