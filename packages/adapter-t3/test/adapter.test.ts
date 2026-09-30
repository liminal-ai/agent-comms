import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Delivery } from "@agent-comms/protocol";
import {
  makeT3Adapter,
  messageIdFor,
  noticeIdFor,
  T3Rejected,
  type T3Client,
  type T3Event,
  type T3StreamItem,
  type T3Thread,
} from "../src/index.ts";

type EventInput = T3Event extends infer E ? (E extends T3Event ? Omit<E, "sequence"> : never) : never;

/**
 * A small T3 that behaves like v0.0.44 as Hazel recorded it: a user message
 * carries no turn id; on an idle thread it starts a turn (session starting,
 * then running T); on a busy one it joins the running turn. Every change is a
 * sequenced event; subscribe gives a snapshot or a replay, then live events.
 */
class FakeT3 implements T3Client {
  private thread: T3Thread;
  private log: T3Event[] = [];
  private listeners = new Set<(i: T3StreamItem) => void>();
  private seq = 100;
  private clock = Date.parse("2026-09-30T12:00:00Z");
  private turns = 0;
  refuse = false;
  failStart = false;

  readonly id: string;

  constructor(id = "th1") {
    this.id = id;
    this.thread = {
      id,
      snapshotSequence: this.seq,
      runtimeMode: "approval-required",
      interactionMode: "default",
      session: { status: "ready", activeTurnId: null, lastError: null },
      latestTurn: null,
      messages: [],
      turnStartFailures: [],
    };
  }
  private at() {
    return new Date((this.clock += 1000)).toISOString();
  }
  private emit(e: EventInput) {
    const event = { ...e, sequence: ++this.seq } as T3Event;
    this.log.push(event);
    this.thread.snapshotSequence = this.seq;
    for (const f of [...this.listeners]) setTimeout(() => f({ kind: "event", event }), 1);
  }
  private setSession(status: string, activeTurnId: string | null) {
    this.thread.session = { status, activeTurnId, lastError: null };
    this.emit({ type: "session", session: { ...this.thread.session } });
  }

  // T3Client
  async connected() {
    return true;
  }
  async getThread(id: string) {
    return id === this.id ? structuredClone(this.thread) : null;
  }
  lastStart?: { runtimeMode: string; text: string; messageId: string };
  async startTurn(id: string, turn: { messageId: string; text: string; runtimeMode: string; interactionMode: string }) {
    if (this.refuse) throw new T3Rejected("thread.turn.start refused: thread is archived");
    this.lastStart = turn;
    this.userMessage(turn.messageId);
    if (this.failStart) {
      this.thread.turnStartFailures.push(turn.messageId);
      this.emit({ type: "turn-start-failed", requestId: turn.messageId });
    }
    void id;
  }
  async subscribe(id: string, options: { afterSequence?: number }, onItem: (i: T3StreamItem) => void) {
    if (id !== this.id) throw new Error("no such thread");
    if (options.afterSequence === undefined) {
      const snap = structuredClone(this.thread);
      setTimeout(() => onItem({ kind: "snapshot", thread: snap }), 1);
    } else {
      const replay = this.log.filter((e) => e.sequence > options.afterSequence!);
      setTimeout(() => {
        for (const event of replay) onItem({ kind: "event", event });
        onItem({ kind: "synchronized" });
      }, 1);
    }
    this.listeners.add(onItem);
    return () => void this.listeners.delete(onItem);
  }
  async close() {}

  // What people and models do
  /** A user message: joins the running turn, or starts one. Returns the turn it's in. */
  userMessage(messageId: string): string {
    const running = !this.idle();
    const createdAt = this.at();
    this.thread.messages.push({ id: messageId, role: "user", turnId: null, streaming: false, createdAt });
    this.emit({ type: "user-message", messageId });
    if (running && this.thread.session?.activeTurnId) return this.thread.session.activeTurnId;
    if (this.failStart) return "";
    const turnId = `turn-${++this.turns}`;
    this.thread.latestTurn = { turnId, state: "running", requestedAt: createdAt, completedAt: null, assistantMessageId: null };
    this.setSession("starting", null);
    this.setSession("running", turnId);
    return turnId;
  }
  /** A turn with no user message (Claude waking for a background task). */
  wake(): string {
    const turnId = `turn-${++this.turns}`;
    this.thread.latestTurn = { turnId, state: "running", requestedAt: this.at(), completedAt: null, assistantMessageId: null };
    this.setSession("running", turnId);
    return turnId;
  }
  idle() {
    return !["running", "starting"].includes(this.thread.session?.status ?? "");
  }
  assistant(text: string) {
    const turnId = this.thread.session!.activeTurnId;
    const id = `assistant:${this.thread.messages.length}`;
    this.thread.messages.push({ id, role: "assistant", turnId, streaming: false, createdAt: this.at(), text });
    if (this.thread.latestTurn?.turnId === turnId) this.thread.latestTurn!.assistantMessageId = id;
    this.emit({ type: "assistant-message", messageId: id, turnId });
  }
  finish(state: "completed" | "error" = "completed", lastError: string | null = null) {
    this.thread.latestTurn = { ...this.thread.latestTurn!, state, completedAt: this.at() };
    this.thread.session = { status: state === "error" ? "error" : "ready", activeTurnId: null, lastError };
    this.emit({ type: "session", session: { ...this.thread.session } });
  }
  /** v0.0.44 interrupt on Claude: completed (with any answer streamed so far), then the session stops. */
  interrupt() {
    this.thread.latestTurn = { ...this.thread.latestTurn!, state: "completed", completedAt: this.at() };
    this.setSession("ready", null);
    setTimeout(() => this.setSession("stopped", null), 20);
  }
  userMessages() {
    return this.thread.messages.filter((m) => m.role === "user").map((m) => m.id);
  }
}

const delivery = (id = "d_1", status: Delivery["status"] = { state: "claimed", at: 0 }): Delivery => ({
  id,
  recipient: { id: "p_tee", name: "tee", kind: "agent" },
  conversation: { id: "c_1", kind: "dm" },
  message: {
    id: `m_${id}`,
    conversationId: "c_1",
    seq: 1,
    sender: { id: "p_a", name: "a", kind: "agent" },
    recipients: [{ id: "p_tee", name: "tee", kind: "agent" }],
    kind: "request",
    text: "what's 2+2?",
    attachments: [],
    createdAt: 0,
    origin: { via: "cli" },
  },
  history: { messages: [], omitted: 0 },
  status,
});

const target = { participant: "tee", locator: "th1" };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const setup = () => {
  const t3 = new FakeT3();
  return { t3, adapter: makeT3Adapter({ client: t3, acceptTimeoutMs: 500, replayQuietMs: 100, interruptWindowMs: 150 }) };
};
const accepted = async (adapter: ReturnType<typeof setup>["adapter"], d = delivery()) => {
  const h = await adapter.handOff(target, d);
  assert.equal(h._tag, "accepted", JSON.stringify(h));
  return h as { _tag: "accepted"; turnId: string; cursor?: string };
};

describe("T3 adapter: live", () => {
  it("starts its own turn on an idle thread, with the thread's modes and the T3 rendering", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    assert.equal(h.turnId, "turn-1");
    assert.ok(h.cursor !== undefined && Number(h.cursor) > 0);
    assert.equal(t3.lastStart!.messageId, messageIdFor("d_1"));
    assert.equal(t3.lastStart!.runtimeMode, "approval-required", "never forces full access");
    assert.match(t3.lastStart!.text, /^\[agent-comms v1\] delivery=d_1 /);
    assert.match(t3.lastStart!.text, /^Source: agent-comms/m);
  });

  it("collects the turn's answer", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.assistant("Let me think.");
    t3.assistant("4");
    await tick();
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("waits for a busy thread, then runs as its own turn", async () => {
    const { t3, adapter } = setup();
    t3.userMessage("lee-typed");
    const handOff = adapter.handOff(target, delivery());
    await tick(80);
    assert.deepEqual(t3.userMessages(), ["lee-typed"], "didn't send while busy");
    t3.assistant("done with Lee's thing");
    t3.finish();
    const h = await handOff;
    assert.equal((h as { turnId: string }).turnId, "turn-2");
    const outcome = adapter.awaitOutcome(target, delivery(), "turn-2");
    t3.assistant("4");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("is ambiguous when someone types into our turn, reporting only that it happened", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.userMessage("lee-steer");
    t3.assistant("an answer to both");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "ambiguous", entered: [{ origin: "t3-user-message" }] });
  });

  it("is ambiguous when our message joins a turn someone else started", async () => {
    const { t3, adapter } = setup();
    const realStart = t3.startTurn.bind(t3);
    t3.startTurn = async (id, turn) => {
      t3.userMessage("lee-raced"); // Lee's turn starts in the gap after our idle check
      return realStart(id, turn);
    };
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.assistant("mixed");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "ambiguous", entered: [{ origin: "t3-turn-already-running" }] });
  });

  it("isn't ambiguous when a later message starts its own turn", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.assistant("4");
    t3.finish();
    t3.userMessage("lee-next");
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("reports an interrupt and an errored turn as failed", async () => {
    {
      // Interrupted before any answer: completed with no assistantMessageId.
      const { t3, adapter } = setup();
      const h = await accepted(adapter);
      const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
      t3.interrupt();
      assert.deepEqual(await outcome, { _tag: "failed", reason: "aborted", detail: "the turn ended without an answer (interrupted)" });
    }
    {
      // Interrupted mid-answer: the partial answer is recorded, then the session stops.
      const { t3, adapter } = setup();
      const h = await accepted(adapter);
      const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
      t3.assistant("Once upon a ti");
      t3.interrupt();
      assert.deepEqual(await outcome, { _tag: "failed", reason: "aborted", detail: "the turn was interrupted; its partial answer wasn't collected" });
    }
    {
      const { t3, adapter } = setup();
      const h = await accepted(adapter);
      const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
      t3.finish("error", "provider crashed");
      assert.deepEqual(await outcome, { _tag: "failed", reason: "error", detail: "provider crashed" });
    }
  });

  it("rejects when T3 can't start the turn, when it refuses, or when the thread is missing", async () => {
    const { t3, adapter } = setup();
    t3.failStart = true;
    assert.equal((await adapter.handOff(target, delivery("d_a")))._tag, "rejected");
    t3.failStart = false;
    t3.refuse = true;
    const h = await adapter.handOff(target, delivery("d_b"));
    assert.equal(h._tag, "rejected");
    assert.match((h as { detail: string }).detail, /archived/);
    assert.equal((await adapter.handOff({ participant: "tee", locator: "nope" }, delivery("d_c")))._tag, "rejected");
  });

  it("sends the unmatched notice once, as its own turn", async () => {
    const { t3, adapter } = setup();
    await adapter.notifyUnmatched(target, delivery());
    t3.finish();
    await adapter.notifyUnmatched(target, delivery());
    assert.deepEqual(t3.userMessages(), [noticeIdFor("d_1")]);
    assert.match(t3.lastStart!.text, /notice=unmatched delivery=d_1/);
    assert.match(t3.lastStart!.text, /comms reply --as tee m_d_1/);
  });
});

describe("T3 adapter: restart check", () => {
  it("says absent when our message never arrived", async () => {
    const { adapter } = setup();
    assert.deepEqual(await adapter.check(target, delivery(), undefined), { _tag: "absent" });
  });

  it("replays from the cursor: running, then completed with the outcome", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    // A new process: a fresh adapter that only has the cursor saved with `delivered`.
    const fresh = makeT3Adapter({ client: t3, replayQuietMs: 100 });
    const d = delivery("d_1", { state: "delivered", at: 0, turnId: h.turnId, cursor: h.cursor! });
    assert.deepEqual(await fresh.check(target, d, h.turnId), { _tag: "running", turnId: h.turnId });
    const outcome = fresh.awaitOutcome(target, d, h.turnId);
    t3.assistant("4");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("replays foreign input that entered our turn while the connector was down", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    t3.userMessage("lee-while-down");
    t3.assistant("mixed");
    t3.finish();
    t3.userMessage("later-turn");
    t3.assistant("unrelated");
    t3.finish();
    const fresh = makeT3Adapter({ client: t3, replayQuietMs: 100 });
    const d = delivery("d_1", { state: "delivered", at: 0, turnId: h.turnId, cursor: h.cursor! });
    const c = await fresh.check(target, d, h.turnId);
    assert.deepEqual(c, { _tag: "completed", turnId: h.turnId, outcome: { _tag: "ambiguous", entered: [{ origin: "t3-user-message" }] } });
  });

  it("without a cursor, links only what the snapshot proves", async () => {
    {
      const { t3, adapter } = setup();
      await accepted(adapter);
      t3.assistant("4");
      t3.finish();
      const fresh = makeT3Adapter({ client: t3 });
      assert.deepEqual(await fresh.check(target, delivery(), undefined), {
        _tag: "completed",
        turnId: "turn-1",
        outcome: { _tag: "replied", answer: "4" },
      });
    }
    {
      // Our message was dropped, then Claude woke on its own: never ours.
      const { t3, adapter } = setup();
      t3.failStart = true;
      await adapter.handOff(target, delivery());
      t3.failStart = false;
      t3.wake();
      t3.assistant("background task finished");
      t3.finish();
      const fresh = makeT3Adapter({ client: t3 });
      const c = await fresh.check(target, delivery(), undefined);
      assert.equal(c._tag, "unknown");
    }
  });
});
