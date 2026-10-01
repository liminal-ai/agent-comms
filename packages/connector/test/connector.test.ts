import { call } from "@agent-comms/comms-cli/client";
import { parseDeliveryHeader, renderDelivery } from "@agent-comms/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "../../../convex/_generated/api.js";
import { ADMIN, type Convex, Mod, type Running, sleep, startConnector, until, world } from "./harness.ts";

let running: Running[] = [];
afterEach(async () => {
  for (const r of running) await r.stop().catch(() => {});
  running = [];
});
const start = async (...args: Parameters<typeof startConnector>) => {
  const r = await startConnector(...args);
  running.push(r);
  return r;
};

async function deliveryState(t: Convex, conversationId: string, messageId: string, recipient: string) {
  const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId });
  return view.messages.find((m) => m.message.id === messageId)?.deliveries.find((d) => d.recipient === recipient);
}

async function send(socket: string, as: string, to: string, text: string) {
  const r = await call(socket, "send", { as, to: [to], text });
  if (!r.ok) throw new Error(r.error.message);
  return r;
}

describe("connector with a mod session", () => {
  it("delivers a request, collects the answer, and delivers the answer back without collecting it", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const a = new Mod(w.socket, "a");
    const b = new Mod(w.socket, "b");
    await a.register();
    await b.register();

    const sent = await send(w.socket, "a", "b", "what's 2+2?");
    const d = await b.nextDelivery();
    expect(d.message.text).toBe("what's 2+2?");
    expect(parseDeliveryHeader(renderDelivery(d, { harnessLabelsSource: true }))?.deliveryId).toBe(d.id);

    await b.ok("delivered", { deliveryId: d.id, turnId: "tb1" } as never);
    await until("delivered in Convex", async () => (await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state === "delivered");
    const out = await b.ok("outcome", { deliveryId: d.id, turnId: "tb1", outcome: "replied", answer: "4" } as never);
    expect(out.duplicate).toBe(false);
    await until("replied in Convex", async () => (await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state === "replied");

    // The answer reaches a as an answer delivery.
    const ans = await a.nextDelivery();
    expect(ans.message.kind).toBe("answer");
    expect(ans.message.text).toBe("4");
    expect(ans.inReplyTo?.id).toBe(sent.message.id);
    await a.ok("delivered", { deliveryId: ans.id, turnId: "ta1" } as never);
    await until("answer delivered", async () => (await deliveryState(w.t, sent.message.conversationId, ans.message.id, "a"))?.state === "delivered");
    const again = await b.ok("outcome", { deliveryId: d.id, turnId: "tb1", outcome: "replied", answer: "4!" } as never);
    expect(again.duplicate).toBe(true);
  });

  it("claims nothing for a participant with no session, and delivers once one registers", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const sent = await send(w.socket, "a", "b", "hello?");
    await sleep(300);
    expect((await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state).toBe("pending");
    const b = new Mod(w.socket, "b");
    await b.register();
    expect((await b.nextDelivery()).message.text).toBe("hello?");
  });

  it("delivers serially per participant", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const b = new Mod(w.socket, "b");
    await b.register();
    await send(w.socket, "a", "b", "one");
    await send(w.socket, "a", "b", "two");
    const first = await b.nextDelivery();
    expect(first.message.text).toBe("one");
    await b.ok("delivered", { deliveryId: first.id, turnId: "t1" } as never);
    await sleep(400);
    expect(await b.poll(200)).toEqual([]);
    await b.ok("outcome", { deliveryId: first.id, turnId: "t1", outcome: "failed", reason: "aborted" } as never);
    expect((await b.nextDelivery()).message.text).toBe("two");
  });

  it("records an ambiguous turn, and comms reply completes it", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const b = new Mod(w.socket, "b");
    await b.register();
    const sent = await send(w.socket, "a", "b", "review this");
    const d = await b.nextDelivery();
    await b.ok("delivered", { deliveryId: d.id, turnId: "t1" } as never);
    await b.ok("outcome", { deliveryId: d.id, turnId: "t1", outcome: "ambiguous", entered: [{ origin: "composer" }] } as never);
    await until("ambiguous", async () => (await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state === "ambiguous");
    const r = await call(w.socket, "reply", { as: "b", messageId: sent.message.id, text: "looks fine" });
    expect(r.ok && r.completed).toBe(d.id);
  });

  it("passes CLI operations through and maps errors", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const status = await call(w.socket, "status", {});
    expect(status.ok && status.implementation).toBe("connector");
    expect(status.ok && status.participants.map((p) => p.participant.name).sort()).toEqual(["a", "b", "tee"]);
    const sent = await send(w.socket, "a", "b", "hi");
    const read = await call(w.socket, "read", { as: "b", conversationId: sent.message.conversationId });
    expect(read.ok && read.messages.map((m) => m.text)).toEqual(["hi"]);
    const list = await call(w.socket, "list", { as: "a" });
    expect(list.ok && list.conversations).toHaveLength(1);
    const bad = await call(w.socket, "send", { as: "lee", to: ["a"], text: "x" });
    expect(!bad.ok && bad.error.code).toBe("not_homed_here");
    const reg = await call(w.socket, "register", { participant: "tee", harness: "claude-code", sessionId: "s", cwd: "/", status: "idle" });
    expect(!reg.ok && reg.error.code).toBe("not_homed_here");
    w.tr.down = true;
    const down = await call(w.socket, "send", { as: "a", to: ["b"], text: "x" });
    expect(!down.ok && down.error.code).toBe("unavailable");
  });

  it("supersedes an older session, and the new one gets the check for what the old one had", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const old = new Mod(w.socket, "b", "old");
    await old.register();
    const sent = await send(w.socket, "a", "b", "long job");
    const d = await old.nextDelivery();
    // The old session never acks; a new session for b takes over.
    const fresh = new Mod(w.socket, "b", "new");
    await fresh.register();
    const r = await old.op("poll", { waitMs: 10 } as never);
    expect(!r.ok && r.error.code).toBe("session_superseded");
    const check = await fresh.nextCheck();
    expect(check).toMatchObject({ deliveryId: d.id, state: "claimed" });
    // It really did start in the new session (say, resumed): running, then done.
    await fresh.ok("check-result", { deliveryId: d.id, found: "yes", turnId: "t7", turn: "running" } as never);
    await until("delivered", async () => (await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state === "delivered");
    await fresh.ok("outcome", { deliveryId: d.id, turnId: "t7", outcome: "replied", answer: "done" } as never);
    await until("replied", async () => (await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state === "replied");
  });
});

describe("connector restart", () => {
  it("recovers a delivered turn by asking the session, and never runs it twice", async () => {
    const w = await world();
    const first = await start(w.api, w.socket);
    const b = new Mod(w.socket, "b");
    await b.register();
    const sent = await send(w.socket, "a", "b", "slow one");
    const d = await b.nextDelivery();
    await b.ok("delivered", { deliveryId: d.id, turnId: "t1" } as never);
    await until("delivered", async () => (await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state === "delivered");

    // Killed mid-turn.
    await first.stop();
    running = running.filter((r) => r !== first);
    await start(w.api, w.socket);
    const lost = await b.op("poll", { waitMs: 10 } as never);
    expect(!lost.ok && lost.error.code).toBe("unknown_session");
    await b.register();

    // After our old lease runs out, the new connector asks instead of re-running.
    const check = await b.nextCheck();
    expect(check).toMatchObject({ deliveryId: d.id, state: "delivered", turnId: "t1", createdAt: d.message.createdAt });
    await b.ok("check-result", {
      deliveryId: d.id, found: "yes", turnId: "t1", turn: "completed", outcome: "replied", answer: "finished",
    } as never);
    await until("replied", async () => (await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state === "replied");
    const view = await w.t.query(api.conversations.view, { adminToken: ADMIN, conversationId: sent.message.conversationId });
    expect(view.messages.filter((m) => m.message.kind === "answer").map((m) => m.message.text)).toEqual(["finished"]);
  });

  it("re-runs a claimed delivery only when the session says it never arrived, and marks unknowns uncertain", async () => {
    const w = await world();
    const first = await start(w.api, w.socket);
    const b = new Mod(w.socket, "b");
    await b.register();
    const one = await send(w.socket, "a", "b", "one");
    const d1 = await b.nextDelivery();
    await first.stop();
    running = running.filter((r) => r !== first);

    await start(w.api, w.socket);
    await b.register();
    const c1 = await b.nextCheck();
    expect(c1).toMatchObject({ deliveryId: d1.id, state: "claimed" });
    await b.ok("check-result", { deliveryId: d1.id, found: "no" } as never);
    const again = await b.nextDelivery();
    expect(again.id).toBe(d1.id);
    await b.ok("delivered", { deliveryId: d1.id, turnId: "t2" } as never);
    await b.ok("outcome", { deliveryId: d1.id, turnId: "t2", outcome: "replied", answer: "ok" } as never);
    await until("replied", async () => (await deliveryState(w.t, one.message.conversationId, one.message.id, "b"))?.state === "replied");

    const two = await send(w.socket, "a", "b", "two");
    const d2 = await b.nextDelivery();
    await b.ok("delivered", { deliveryId: d2.id, turnId: "t3" } as never);
    await until("delivered", async () => (await deliveryState(w.t, two.message.conversationId, two.message.id, "b"))?.state === "delivered");
    await running[running.length - 1]!.stop();
    running = [];
    await start(w.api, w.socket);
    await b.register();
    await b.nextCheck();
    await b.ok("check-result", { deliveryId: d2.id, found: "unknown", detail: "session was resumed without its memory" } as never);
    await until("uncertain", async () => (await deliveryState(w.t, two.message.conversationId, two.message.id, "b"))?.state === "uncertain");
  });

  it("keeps retrying writes while the server is unreachable", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const b = new Mod(w.socket, "b");
    await b.register();
    const sent = await send(w.socket, "a", "b", "during an outage");
    const d = await b.nextDelivery();
    w.tr.down = true;
    await b.ok("delivered", { deliveryId: d.id, turnId: "t1" } as never);
    const out = await b.ok("outcome", { deliveryId: d.id, turnId: "t1", outcome: "replied", answer: "still here" } as never);
    expect(out.delivery.state).toBe("replied");
    await sleep(600);
    w.tr.down = false;
    await until("replied after the outage", async () => (await deliveryState(w.t, sent.message.conversationId, sent.message.id, "b"))?.state === "replied");
  });
});

describe("fix pass 3.6", () => {
  it("3.6 an unclassified server error never carries its text (which may echo the secret)", async () => {
    const { classify } = await import("../src/server-api.ts");
    const e = classify("send", new Error('ArgumentValidationError: Value does not match validator. Path: .machine Value: {"secret":"box-secret-0123456789"}'));
    expect(e._tag).toBe("Unavailable");
    expect(e.message).not.toContain("box-secret");
    expect(classify("send", new TypeError("fetch failed")).message).toContain("fetch failed");
  });
});

describe("fix pass 3.3", () => {
  it("3.3 a superseded session is freed once its last poll is answered", async () => {
    const w = await world();
    const r = await startConnector(w.api, w.socket);
    running.push(r);
    const old = new Mod(w.socket, "b", "old");
    await old.register();
    await new Mod(w.socket, "b", "new").register();
    await old.op("poll", { waitMs: 10 } as never);
    await until("freed", async () => (r.sessions?.sessionCount() ?? -1) === 1, 8_000);
  });
});

describe("fix pass 3.1", () => {
  it("3.1 a Claude Code handoff and a restart question each have a deadline", async () => {
    const { ClaudeCodeSessions } = await import("../src/claude-code.ts");
    const { makePoke } = await import("../src/adapter.ts");
    const Effect = await import("effect/Effect");
    const sessions = new ClaudeCodeSessions({
      pollWaitMs: 50,
      handOffDeadlineMs: 200,
      checkDeadlineMs: 200,
      homed: async () => [{ participant: { id: "p", name: "b", kind: "agent" }, home: { machine: "box", harness: "claude-code", locator: "b" }, state: "active" }],
      presence: () => {},
      poke: makePoke(),
    });
    await sessions.register({ participant: "b", harness: "claude-code", sessionId: "s", cwd: "/", status: "idle" });
    const d = { id: "d1", message: { id: "m1", kind: "request" }, status: { state: "claimed", at: 0 } } as never;
    const target = { participant: "b", locator: "b" };
    const started = Date.now();
    const h = await Effect.runPromise(sessions.adapter.handOff(target, d, { confirm: async () => true }));
    expect(h._tag).toBe("lost");
    const c = await Effect.runPromise(sessions.adapter.check(target, d, undefined));
    expect(c._tag).toBe("later");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("capabilities R0", () => {
  it("answers the capabilities operations unsupported (501) until they're built; a waiting send isn't sent unwaited", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const cases: [string, unknown][] = [
      ["await", { as: "a", messageId: "m_1" }],
      ["ack", { as: "a", messageId: "m_1" }],
      ["message-status", { as: "a", messageId: "m_1" }],
      ["agents", { as: "a" }],
      ["agents-set", { as: "a", name: "a", description: "x" }],
      ["remind", { as: "a", target: "b", text: "x", everyMs: 60_000 }],
      ["reminders", { as: "a" }],
      ["reminder", { as: "a", id: "r_1" }],
      ["reminder-update", { as: "a", id: "r_1", action: "pause" }],
      ["send", { as: "a", to: ["b"], text: "x", wait: true }],
    ];
    for (const [name, body] of cases) {
      const r = await call(w.socket, name as never, body as never);
      expect(!r.ok && r.error.code, name).toBe("unsupported");
    }
    const list = await call(w.socket, "list", { as: "a" });
    expect(list.ok && list.conversations).toHaveLength(0);
  });
});
