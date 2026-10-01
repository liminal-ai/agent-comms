import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Delivery } from "@agent-comms/protocol";
import {
  decodeCursor,
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
  listeners = new Set<(i: T3StreamItem) => void>();
  private seq = 100;
  private clock = Date.parse("2026-09-30T12:00:00Z");
  private turns = 0;
  refuse = false;
  failStart = false;
  /** Resubscriptions to fail before one succeeds; and whether a resumed subscription gets a snapshot (events gone). */
  failResubscribes = 0;
  eventsGone = false;

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
  /** The WebSocket drops: every subscriber is told its stream closed. */
  drop() {
    const subs = [...this.listeners];
    this.listeners.clear();
    for (const f of subs) setTimeout(() => (f as (i: unknown) => void)({ kind: "closed" }), 1);
  }
  async subscribe(id: string, options: { afterSequence?: number }, onItem: (i: T3StreamItem) => void) {
    if (id !== this.id) throw new Error("no such thread");
    if (options.afterSequence !== undefined && this.failResubscribes > 0) {
      this.failResubscribes -= 1;
      throw new Error("ECONNREFUSED");
    }
    if (options.afterSequence === undefined || this.eventsGone) {
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
  /** A user message appended without a turn starting yet (a queued web message flushing, say). */
  appendOnly(messageId: string): void {
    this.thread.messages.push({ id: messageId, role: "user", turnId: null, streaming: false, createdAt: this.at() });
    this.emit({ type: "user-message", messageId });
  }
  /** A turn starts for messages already appended; `requestedAt` from the given message. */
  startFor(messageId: string): string {
    const turnId = `turn-${++this.turns}`;
    const requestedAt = this.thread.messages.find((m) => m.id === messageId)!.createdAt;
    this.thread.latestTurn = { turnId, state: "running", requestedAt, completedAt: null, assistantMessageId: null };
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
    assert.deepEqual(decodeCursor(h.cursor), { sequence: 100, confirmedTurnId: "turn-1" }, "cursor: before our message, turn confirmed ours");
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

  it("reports presence from the thread's session", async () => {
    const { t3, adapter } = setup();
    assert.equal(await adapter.presence(target), "idle");
    t3.userMessage("lee");
    assert.equal(await adapter.presence(target), "busy");
    assert.equal(await adapter.presence({ participant: "x", locator: "nope" }), "offline");
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

  it("without a cursor, never collects from the snapshot alone (1.3)", async () => {
    const { t3, adapter } = setup();
    await accepted(adapter);
    t3.assistant("4");
    t3.finish();
    const fresh = makeT3Adapter({ client: t3 });
    assert.equal((await fresh.check(target, delivery(), undefined))._tag, "unknown");
  });
});

describe("fix pass 1: reply ownership", () => {
  it("1.1 a foreign message landing just before ours, with no turn started in between, makes it ambiguous", async () => {
    const { t3, adapter } = setup();
    t3.startTurn = async (_id, turn) => {
      t3.lastStart = turn;
      t3.appendOnly("lee-queued"); // Lee's queued web message flushes on the same ready
      t3.appendOnly(turn.messageId);
      t3.startFor("lee-queued"); // one turn takes both
    };
    const h = await adapter.handOff(target, delivery());
    const outcome = h._tag === "accepted" ? await (async () => {
      const o = adapter.awaitOutcome(target, delivery(), h.turnId);
      t3.assistant("answer to Lee and to us");
      t3.finish();
      return o;
    })() : h;
    assert.equal(outcome._tag, "ambiguous", JSON.stringify(outcome));
  });

  it("1.2 a background turn starting between our message and our turn isn't taken as ours", async () => {
    const { t3, adapter } = setup();
    t3.startTurn = async (_id, turn) => {
      t3.lastStart = turn;
      t3.appendOnly(turn.messageId); // ours lands, then Claude wakes for a background task first
      t3.wake();
    };
    const h = await adapter.handOff(target, delivery());
    const outcome = h._tag === "accepted" ? await (async () => {
      const o = adapter.awaitOutcome(target, delivery(), h.turnId);
      t3.assistant("background task finished");
      t3.finish();
      return o;
    })() : h;
    assert.notEqual(outcome._tag, "replied", JSON.stringify(outcome));
    assert.equal(outcome._tag, "ambiguous");
  });

  it("1.3 recovery without the turn's full events reports uncertain, never collects", async () => {
    const { t3, adapter } = setup();
    await accepted(adapter);
    t3.assistant("4");
    t3.finish();
    const fresh = makeT3Adapter({ client: t3 });
    const c = await fresh.check(target, delivery(), undefined); // no cursor: events can't be replayed
    assert.equal(c._tag, "unknown", JSON.stringify(c));
  });

  it("1.3 the restart check never collects an interrupted turn's partial answer", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    t3.assistant("Once upon a ti");
    t3.interrupt();
    await tick(60); // the session's ready -> stopped lands
    const fresh = makeT3Adapter({ client: t3, replayQuietMs: 100, interruptWindowMs: 150 });
    const d = delivery("d_1", { state: "delivered", at: 0, turnId: h.turnId, cursor: h.cursor! });
    const c = await fresh.check(target, d, h.turnId);
    assert.equal(c._tag, "completed");
    assert.notEqual((c as { outcome: { _tag: string } }).outcome._tag, "replied", JSON.stringify(c));
  });

  it("1.4 reads our turn's own end state when a later turn has started", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.assistant("Let me check that.");
    t3.finish("error", "provider crashed");
    t3.userMessage("lee-next"); // Lee's next turn is latest before we read the outcome
    const o = await outcome;
    assert.notEqual(o._tag, "replied", JSON.stringify(o));
    assert.equal(o._tag, "failed");
  });

  it("1.4 can't read our turn's end state: uncertain", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.assistant("partial");
    t3.wake(); // another turn takes over with no end event for ours
    const o = await outcome;
    assert.equal(o._tag, "uncertain", JSON.stringify(o));
  });
});

describe("fix pass 2.2 / 2.3", () => {
  it("2.2 the claim is re-checked right before sending; a lost claim sends nothing", async () => {
    const { t3, adapter } = setup();
    const gate = { confirm: async () => false, signal: new AbortController().signal };
    const h = await (adapter.handOff as (...a: unknown[]) => Promise<{ _tag: string }>)(target, delivery(), gate);
    assert.notEqual(h._tag, "accepted");
    assert.deepEqual(t3.userMessages(), [], "nothing was sent");
  });

  it("2.2 an aborted handoff (claim lost during the courtesy wait) sends nothing", async () => {
    const { t3, adapter } = setup();
    t3.userMessage("lee-busy"); // the thread is busy: we wait
    const abort = new AbortController();
    let confirmed = 0;
    const gate = { confirm: async () => (confirmed++, true), signal: abort.signal };
    const handOff = (adapter.handOff as (...a: unknown[]) => Promise<{ _tag: string }>)(target, delivery(), gate);
    await tick(80);
    abort.abort();
    t3.finish(); // the thread goes idle after the claim was lost
    const h = await Promise.race([handOff, tick(2000).then(() => ({ _tag: "hung" }))]);
    assert.notEqual(h._tag, "accepted");
    assert.equal(confirmed, 0);
    assert.deepEqual(t3.userMessages(), ["lee-busy"], "ours was never sent");
  });

  it("2.3 the real client: an HTTP 4xx refusal is rejected; a 5xx or a dropped connection is not", async () => {
    const { createServer } = await import("node:http");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { makeT3Client } = await import("../src/t3/client.ts");
    let mode: "400" | "500" | "drop" = "400";
    const server = createServer((req, res) => {
      if (mode === "drop") return req.socket.destroy();
      res.writeHead(Number(mode), { "content-type": "application/json" });
      res.end('{"_tag":"EnvironmentRequestInvalidError"}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), "t3client-"));
    await writeFile(join(dir, "token"), "dummy-bearer", { mode: 0o600 });
    const client = makeT3Client({ baseUrl: `http://127.0.0.1:${port}`, authFile: join(dir, "token"), log: () => {} });
    const turn = { messageId: "comms-d", text: "x", runtimeMode: "auto", interactionMode: "default" };
    const kind = async () => client.startTurn("th", turn).then(() => "ok", (e) => (e instanceof T3Rejected ? "rejected" : "transport"));
    mode = "400";
    assert.equal(await kind(), "rejected");
    mode = "500";
    assert.equal(await kind(), "transport");
    mode = "drop";
    assert.equal(await kind(), "transport");
    server.close();
  });
});

describe("fix pass 3.3", () => {
  it("3.3 an answer's delivery leaves no subscription behind", async () => {
    const { t3, adapter } = setup();
    const answer = delivery("d_ans");
    answer.message = { ...answer.message, kind: "answer", inReplyTo: "m_x" };
    const h = await adapter.handOff(target, answer);
    assert.equal(h._tag, "accepted");
    assert.equal(t3.listeners.size, 0);
  });
});

describe("fix pass 3.2", () => {
  it("3.2 a dropped stream is resubscribed with retries, and the turn still resolves", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.failResubscribes = 2;
    t3.drop();
    await tick(2_500); // two failed attempts, then a good one
    t3.assistant("4");
    t3.finish();
    assert.deepEqual(await outcome, { _tag: "replied", answer: "4" });
  });

  it("3.2 a resubscription that gets a snapshot (events missed) makes the outcome uncertain", async () => {
    const { t3, adapter } = setup();
    const h = await accepted(adapter);
    const outcome = adapter.awaitOutcome(target, delivery(), h.turnId);
    t3.eventsGone = true;
    t3.drop();
    t3.userMessage("lee-while-down"); // unseen
    await tick(100);
    t3.eventsGone = false;
    t3.assistant("mixed");
    t3.finish();
    const o = await outcome;
    assert.equal(o._tag, "uncertain", JSON.stringify(o));
  });
});
