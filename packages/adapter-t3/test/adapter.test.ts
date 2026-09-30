import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Delivery } from "@agent-comms/protocol";
import { makeT3Adapter, messageIdFor, T3Rejected, type T3Client, type T3Thread } from "../src/index.ts";

/**
 * A small T3: turn.start on an idle thread opens a new turn; on a busy thread
 * it joins the running turn (v0.0.44 steers). Tests drive the rest.
 */
class FakeT3 implements T3Client {
  threads = new Map<string, T3Thread>();
  private listeners = new Map<string, Set<() => void>>();
  private clock = Date.parse("2026-09-30T12:00:00Z");
  private turns = 0;
  refuse = false;
  up = true;

  constructor(...ids: string[]) {
    for (const id of ids) {
      this.threads.set(id, {
        id,
        runtimeMode: "approval-required",
        interactionMode: "default",
        session: { status: "ready", activeTurnId: null, lastError: null },
        latestTurn: null,
        messages: [],
        finishedTurnIds: [],
      });
    }
  }
  private at() {
    return new Date((this.clock += 1000)).toISOString();
  }
  private changed(id: string) {
    for (const f of this.listeners.get(id) ?? []) setTimeout(f, 1);
  }
  thread(id: string) {
    return this.threads.get(id)!;
  }

  // T3Client
  async connected() {
    return this.up;
  }
  async getThread(id: string) {
    const t = this.threads.get(id);
    return t ? structuredClone(t) : null;
  }
  lastStart?: { runtimeMode: string; interactionMode: string; text: string };
  async startTurn(id: string, turn: { messageId: string; text: string; runtimeMode: string; interactionMode: string }) {
    if (this.refuse) throw new T3Rejected("thread.turn.start refused: thread is archived");
    this.lastStart = turn;
    this.userMessage(id, turn.messageId);
  }
  async watch(id: string, onChange: () => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(onChange);
    this.listeners.set(id, set);
    return () => set.delete(onChange);
  }
  async close() {}

  // What people and the model do
  /**
   * A user message: joins the running turn if there is one, else starts a new
   * turn. Like v0.0.44, the message itself carries no turn id. Returns the turn.
   */
  userMessage(id: string, messageId: string): string {
    const t = this.thread(id);
    const createdAt = this.at();
    let turnId = t.session?.status === "running" ? t.session.activeTurnId : null;
    if (!turnId) {
      turnId = `turn-${++this.turns}`;
      t.latestTurn = { turnId, state: "running", requestedAt: createdAt, completedAt: null };
      t.session = { status: "running", activeTurnId: turnId, lastError: null };
    }
    t.messages.push({ id: messageId, role: "user", turnId: null, streaming: false, createdAt });
    this.changed(id);
    return turnId;
  }
  assistant(id: string, text: string, streaming = false) {
    const t = this.thread(id);
    t.messages.push({ id: `a-${t.messages.length}`, role: "assistant", turnId: t.session!.activeTurnId, streaming, createdAt: this.at(), text });
    this.changed(id);
  }
  finish(id: string, state: "completed" | "interrupted" | "error" = "completed", lastError: string | null = null) {
    const t = this.thread(id);
    t.latestTurn = { ...t.latestTurn!, state, completedAt: this.at() };
    t.session = { status: state === "error" ? "error" : "ready", activeTurnId: null, lastError };
    this.changed(id);
  }
}

const delivery = (id = "d_1"): Delivery => ({
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
  status: { state: "claimed", at: 0 },
});

const target = { participant: "tee", locator: "th1" };
const setup = () => {
  const t3 = new FakeT3("th1");
  return { t3, adapter: makeT3Adapter({ client: t3, refreshMs: 20, acceptTimeoutMs: 500 }) };
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("T3 adapter", () => {
  it("starts a turn on an idle thread with the thread's own modes and the T3 rendering", async () => {
    const { t3, adapter } = setup();
    const h = await adapter.handOff(target, delivery());
    assert.deepEqual(h, { _tag: "accepted", turnId: "turn-1" });
    assert.equal(t3.thread("th1").messages[0]!.id, messageIdFor("d_1"));
    assert.equal(t3.lastStart!.runtimeMode, "approval-required", "never forces full access");
    assert.match(t3.lastStart!.text, /^\[agent-comms v1\] delivery=d_1 /);
    assert.match(t3.lastStart!.text, /^Source: agent-comms/m);
  });

  it("collects the turn's final assistant message", async () => {
    const { t3, adapter } = setup();
    const h = await adapter.handOff(target, delivery());
    const outcome = adapter.awaitOutcome(target, delivery(), (h as { turnId: string }).turnId);
    t3.assistant("th1", "Let me think.");
    t3.assistant("th1", "4");
    await tick();
    t3.finish("th1");
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("waits for a busy thread, then runs as its own turn", async () => {
    const { t3, adapter } = setup();
    t3.userMessage("th1", "lee-typed");
    const handOff = adapter.handOff(target, delivery());
    await tick(80);
    assert.equal(t3.thread("th1").messages.length, 1, "didn't start while busy");
    t3.assistant("th1", "done with Lee's thing");
    t3.finish("th1");
    const h = await handOff;
    assert.deepEqual(h, { _tag: "accepted", turnId: "turn-2" });
    const outcome = adapter.awaitOutcome(target, delivery(), "turn-2");
    t3.assistant("th1", "4");
    t3.finish("th1");
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("is ambiguous when someone types into our turn, and reports only that it happened", async () => {
    const { t3, adapter } = setup();
    const h = await adapter.handOff(target, delivery());
    const outcome = adapter.awaitOutcome(target, delivery(), (h as { turnId: string }).turnId);
    t3.userMessage("th1", "lee-steer");
    t3.assistant("th1", "an answer to both");
    t3.finish("th1");
    const o = await outcome;
    assert.deepEqual(o, { _tag: "ambiguous", entered: [{ origin: "t3-user-message" }] });
  });

  it("is ambiguous when our message lands in a turn someone else started", async () => {
    const { t3, adapter } = setup();
    // Lee's turn starts in the gap between our idle check and our turn.start.
    const realStart = t3.startTurn.bind(t3);
    t3.startTurn = async (id, turn) => {
      t3.userMessage(id, "lee-raced");
      return realStart(id, turn);
    };
    const h = await adapter.handOff(target, delivery());
    assert.equal(h._tag, "accepted");
    const outcome = adapter.awaitOutcome(target, delivery(), (h as { turnId: string }).turnId);
    t3.assistant("th1", "mixed");
    t3.finish("th1");
    assert.equal((await outcome)._tag, "ambiguous");
  });

  it("isn't ambiguous when a later message starts its own turn", async () => {
    const { t3, adapter } = setup();
    const h = await adapter.handOff(target, delivery());
    const outcome = adapter.awaitOutcome(target, delivery(), (h as { turnId: string }).turnId);
    t3.assistant("th1", "4");
    t3.finish("th1");
    t3.userMessage("th1", "lee-next");
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("reports interrupted and errored turns as failed", async () => {
    for (const [state, expected] of [
      ["interrupted", { _tag: "failed", reason: "aborted", detail: "the turn was interrupted" }],
      ["error", { _tag: "failed", reason: "error", detail: "provider crashed" }],
    ] as const) {
      const { t3, adapter } = setup();
      const h = await adapter.handOff(target, delivery());
      const outcome = adapter.awaitOutcome(target, delivery(), (h as { turnId: string }).turnId);
      t3.finish("th1", state, state === "error" ? "provider crashed" : null);
      assert.deepEqual(await outcome, expected);
    }
  });

  it("doesn't treat the previous turn as ours having finished", async () => {
    const { t3, adapter } = setup();
    t3.userMessage("th1", "earlier");
    t3.finish("th1");
    const h = await adapter.handOff(target, delivery());
    const turnId = (h as { turnId: string }).turnId;
    // Simulate a snapshot where our message has its turn id but latestTurn still names the old turn.
    const ourTurn = { ...t3.thread("th1").latestTurn! };
    t3.thread("th1").latestTurn = { turnId: "turn-1", state: "completed", requestedAt: "2026-09-30T12:00:01.000Z", completedAt: "2026-09-30T12:00:02.000Z" };
    t3.thread("th1").session = { status: "ready", activeTurnId: null, lastError: null };
    let settled = false;
    const outcome = adapter.awaitOutcome(target, delivery(), turnId).then((o) => ((settled = true), o));
    await tick(100);
    assert.equal(settled, false);
    t3.thread("th1").latestTurn = ourTurn;
    t3.thread("th1").session = { status: "running", activeTurnId: turnId, lastError: null };
    t3.assistant("th1", "4");
    t3.finish("th1");
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("rejects a missing thread or a refused turn.start", async () => {
    const { t3, adapter } = setup();
    assert.equal((await adapter.handOff({ participant: "tee", locator: "nope" }, delivery()))._tag, "rejected");
    t3.refuse = true;
    const h = await adapter.handOff(target, delivery());
    assert.equal(h._tag, "rejected");
    assert.match((h as { detail: string }).detail, /archived/);
  });

  it("doesn't start a second turn for a delivery already in the thread", async () => {
    const { t3, adapter } = setup();
    await adapter.handOff(target, delivery());
    t3.finish("th1");
    const again = await adapter.handOff(target, delivery());
    assert.deepEqual(again, { _tag: "accepted", turnId: "turn-1" });
    assert.equal(t3.thread("th1").messages.filter((m) => m.role === "user").length, 1);
  });

  it("answers the restart check from T3's records", async () => {
    const { t3, adapter } = setup();
    assert.deepEqual(await adapter.check(target, delivery(), undefined), { _tag: "absent" });
    await adapter.handOff(target, delivery());
    assert.deepEqual(await adapter.check(target, delivery(), undefined), { _tag: "running", turnId: "turn-1" });
    t3.assistant("th1", "4");
    t3.finish("th1");
    // Later turns happen before the connector comes back.
    t3.userMessage("th1", "later");
    t3.assistant("th1", "something else");
    t3.finish("th1");
    assert.deepEqual(await adapter.check(target, delivery(), "turn-1"), {
      _tag: "completed",
      turnId: "turn-1",
      outcome: { _tag: "replied", answer: "4" },
    });
    assert.equal((await adapter.check({ participant: "tee", locator: "gone" }, delivery(), undefined))._tag, "unknown");
  });
});
