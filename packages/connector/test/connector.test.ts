import { EXIT, run as comms } from "@agent-comms/comms-cli";
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
  it("answers the capabilities operations unsupported (501) until they're built", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const cases: [string, unknown][] = [
      ["remind", { as: "a", target: "b", text: "x", everyMs: 60_000 }],
      ["reminders", { as: "a" }],
      ["reminder", { as: "a", id: "r_1" }],
      ["reminder-update", { as: "a", id: "r_1", action: "pause" }],
    ];
    for (const [name, body] of cases) {
      const r = await call(w.socket, name as never, body as never);
      expect(!r.ok && r.error.code, name).toBe("unsupported");
    }
    const list = await call(w.socket, "list", { as: "a" });
    expect(list.ok && list.conversations).toHaveLength(0);
  });
});

describe("capabilities R1", () => {
  it("passes the registry operations through", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const set = await call(w.socket, "agents-set", { as: "a", name: "a", description: "builds", duties: ["merge"] });
    expect(set.ok && set.agent).toMatchObject({ description: "builds", duties: ["merge"], owner: { name: "lee" } });
    const all = await call(w.socket, "agents", { as: "a" });
    expect(all.ok && all.agents.map((e) => e.participant.name)).toEqual(["a", "b", "lee", "tee"]);
    const one = await call(w.socket, "agents", { as: "a", name: "tee", long: true });
    expect(one.ok && one.agents[0]!.home).toEqual({ machine: "box", harness: "t3", locator: "thread-1" });
    const other = await call(w.socket, "agents-set", { as: "a", name: "b", description: "x" });
    expect(!other.ok && other.error.code).toBe("conflict");
  });
});

describe("capabilities R2: send-and-wait through the connector and the CLI", () => {
  async function cli(socket: string, args: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await comms(["--socket", socket, ...args], {
      env: {},
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      readStdin: async () => "",
    });
    return { code, stdout, stderr };
  }
  const presenceIs = (w: Awaited<ReturnType<typeof world>>, name: string, status: string) =>
    until(`@${name} ${status}`, async () => {
      const { participants } = await w.t.query(api.directory.list, { adminToken: ADMIN });
      return participants.find((p) => p.name === name)?.presence.status === status;
    });

  /** b's mod answers its next delivery with `text`. */
  async function answers(b: Mod, text: string) {
    const d = await b.nextDelivery();
    await b.ok("delivered", { deliveryId: d.id, turnId: `t-${d.id}` } as never);
    await b.ok("outcome", { deliveryId: d.id, turnId: `t-${d.id}`, outcome: "replied", answer: text } as never);
    return d;
  }

  it("comms send waits, prints the answer, and acks it in the turn that ran it; the answer never arrives as a turn", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const a = new Mod(w.socket, "a");
    const b = new Mod(w.socket, "b");
    await a.register();
    await b.register();
    await a.ok("presence", { status: "busy" } as never);
    await presenceIs(w, "a", "busy");

    const [r] = await Promise.all([cli(w.socket, ["send", "--as", "a", "@b", "what's", "2+2?"]), answers(b, "4")]);
    expect(r.code, r.stderr).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^sent \S+ \(#1 in \S+\), waiting up to 100s for @b$/m);
    expect(r.stdout).toMatch(/^@b answered \(\S+\):\n  4$/m);
    const id = /^sent (\S+)/m.exec(r.stdout)![1]!;
    const status = await call(w.socket, "message-status", { as: "a", messageId: id });
    expect(status.ok && status.wait?.results[0]!.state).toBe("acknowledged");
    expect(status.ok && status.recipients[0]!.answer?.text).toBe("4");
    expect(await a.poll(300)).toEqual([]);
  });

  it("--continue returns at once; a send to a person returns at once with the inbox; --json prints one object", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const go = await cli(w.socket, ["send", "--as", "a", "--continue", "@b", "fire and forget"]);
    expect(go.code).toBe(EXIT.ok);
    expect(go.stdout).toMatch(/→ @b: delivery \S+ pending/);
    const person = await cli(w.socket, ["send", "--as", "a", "@owner", "a decision please"]);
    expect(person.code).toBe(EXIT.ok);
    expect(person.stdout).toMatch(/→ @lee: in their inbox/);
    const json = await cli(w.socket, ["send", "--as", "a", "--json", "@owner", "again"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, noWait: { reason: "nobody-to-wait-for" } });
  });

  it("exits 4 at the bound with the answer still to come, and 5 when a recipient's delivery ends without one", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const b = new Mod(w.socket, "b");
    await b.register();
    const pending = await cli(w.socket, ["send", "--as", "a", "--wait", "2s", "@b", "slow one"]);
    expect(pending.code).toBe(EXIT.pending);
    expect(pending.stdout).toMatch(/^no answer from @b within 2s; it will arrive in your thread\. Check with `comms status \S+ --as a`\.$/m);

    const d = await b.nextDelivery();
    await b.ok("delivered", { deliveryId: d.id, turnId: "t1" } as never);
    await b.ok("outcome", { deliveryId: d.id, turnId: "t1", outcome: "replied", answer: "late" } as never);
    const [ended] = await Promise.all([
      cli(w.socket, ["send", "--as", "a", "@b", "this one fails"]),
      (async () => {
        const d2 = await b.nextDelivery();
        await b.ok("delivered", { deliveryId: d2.id, turnId: "t2" } as never);
        await b.ok("outcome", { deliveryId: d2.id, turnId: "t2", outcome: "failed", reason: "error", detail: "boom" } as never);
      })(),
    ]);
    expect(ended.code).toBe(EXIT.endedWithoutAnswer);
    expect(ended.stdout).toMatch(/^@b: no answer \(delivery failed: error: boom\)$/m);
  });

  it("doesn't wait on an agent that is itself waiting, and says so", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const first = call(w.socket, "send", { as: "b", to: ["tee"], text: "b waits on tee", wait: true });
    expect((await first).ok).toBe(true);
    const r = await cli(w.socket, ["send", "--as", "a", "@b", "are you free?"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/@b is waiting on another request, so this send didn't wait\. Your message is queued; check with `comms status \S+ --as a`\./);
  });

  it("comms await reattaches, and comms status shows each recipient", async () => {
    const w = await world();
    await start(w.api, w.socket);
    const b = new Mod(w.socket, "b");
    await b.register();
    const sent = await call(w.socket, "send", { as: "a", to: ["b"], text: "reattach", wait: true, waitMs: 60_000 });
    if (!sent.ok) throw new Error(sent.error.message);
    const [r] = await Promise.all([cli(w.socket, ["await", "--as", "a", sent.message.id]), answers(b, "here")]);
    expect(r.code, r.stderr).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^@b answered \(\S+\):\n  here$/m);
    const s = await cli(w.socket, ["status", "--as", "a", sent.message.id]);
    expect(s.code).toBe(EXIT.ok);
    expect(s.stdout).toMatch(/^@b: replied · answered: here$/m);
    expect(s.stdout).toMatch(/^wait: answered 1 of 1/m);
  });
});
