// Unit tests: configuration, the pure item rules, the store, the lock, the
// webhook, and the bridge's reporting logic against a scripted connector.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { errorBody, type Op, parseDeliveryHeader, type PollItem, type Requests, type ResponseBody } from "@agent-comms/protocol";
import { Bridge } from "../src/bridge.ts";
import { type CallOptions, type ConnectorClient, TransportError } from "../src/client.ts";
import { ConfigError, DEFAULT_ANSWER_TIMEOUT_MS, loadConfig } from "../src/config.ts";
import { checkAnswer, newItem, planAck, planAnswer, TIMEOUT_ORIGIN, timeOut, turnIdFor } from "../src/items.ts";
import { acquireLock, LockHeld, lockOwner } from "../src/lock.ts";
import { isSettled } from "../src/store.ts";
import { wakePayload, webhookWake } from "../src/webhook.ts";
import { delivery, storeIn, tempDir, waitFor } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});
async function home(): Promise<string> {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

describe("config", () => {
  it("has defaults: @grok, 20 minutes, 25 s polls, no webhook", async () => {
    const h = await home();
    const c = loadConfig({ GROKBOT_HOME: h, AGENT_COMMS_SOCKET: "/tmp/x.sock" });
    assert.equal(c.participant, "grok");
    assert.equal(c.answerTimeoutMs, DEFAULT_ANSWER_TIMEOUT_MS);
    assert.equal(c.answerTimeoutMs, 20 * 60_000);
    assert.equal(c.pollWaitMs, 25_000);
    assert.equal(c.socket, "/tmp/x.sock");
    assert.equal(c.inboxDir, join(h, "inbox"));
    assert.equal(c.wakeWebhook, undefined);
    assert.equal(c.unregisterOnExit, false);
  });

  it("reads the file, and the environment overrides it, and flags override both", async () => {
    const h = await home();
    await writeFile(
      join(h, "config.json"),
      JSON.stringify({ participant: "grokker", socket: "/from/file.sock", answerTimeout: "5m", pollWaitMs: 10000, wakeWebhook: "http://127.0.0.1:9/hook" }),
    );
    const fromFile = loadConfig({ GROKBOT_HOME: h });
    assert.equal(fromFile.participant, "grokker");
    assert.equal(fromFile.socket, "/from/file.sock");
    assert.equal(fromFile.answerTimeoutMs, 5 * 60_000);
    assert.equal(fromFile.pollWaitMs, 10_000);
    assert.deepEqual(fromFile.wakeWebhook, { url: "http://127.0.0.1:9/hook", includeText: false, timeoutMs: 5000 });
    assert.equal(fromFile.configFile, join(h, "config.json"));

    const env = loadConfig({ GROKBOT_HOME: h, AGENT_COMMS_SOCKET: "/env.sock", GROKBOT_PARTICIPANT: "g2", GROKBOT_ANSWER_TIMEOUT: "90000", GROKBOT_WAKE_INCLUDE_TEXT: "1" });
    assert.equal(env.socket, "/env.sock");
    assert.equal(env.participant, "g2");
    assert.equal(env.answerTimeoutMs, 90_000);
    assert.equal(env.wakeWebhook?.includeText, true);

    const flags = loadConfig({ GROKBOT_HOME: h, AGENT_COMMS_SOCKET: "/env.sock" }, { socket: "/flag.sock", participant: "g3" });
    assert.equal(flags.socket, "/flag.sock");
    assert.equal(flags.participant, "g3");
  });

  it("refuses bad values", async () => {
    const h = await home();
    const base = { GROKBOT_HOME: h, AGENT_COMMS_SOCKET: "/s" };
    assert.throws(() => loadConfig({ ...base, GROKBOT_PARTICIPANT: "Grok!" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, GROKBOT_ANSWER_TIMEOUT: "soon" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, GROKBOT_POLL_WAIT_MS: "60000" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, GROKBOT_WAKE_WEBHOOK_URL: "file:///etc/passwd" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, GROKBOT_CONFIG: join(h, "missing.json") }), ConfigError);
  });
});

describe("items", () => {
  it("makes a request item: rendered with the protocol header, answer expected, deadline set", () => {
    const item = newItem(delivery(), { now: 10_000, answerTimeoutMs: 60_000 });
    assert.equal(item.state, "awaiting-answer");
    assert.equal(item.expectsReply, true);
    assert.equal(item.turnId, "grok-d_1");
    assert.equal(item.turnId, turnIdFor("d_1"));
    assert.equal(item.deadlineAt, new Date(70_000).toISOString());
    assert.equal(item.from.name, "lee");
    assert.equal(item.conversation.id, "g_build");
    assert.equal(parseDeliveryHeader(item.rendered)?.deliveryId, "d_1");
    assert.match(item.rendered, /^Source: agent-comms/m);
    assert.match(item.rendered, /An answer is expected/);
    assert.equal(item.deliveredReported, false);
  });

  it("makes answer and notice items unread, with no deadline and no reply expected", () => {
    for (const kind of ["answer", "notice"] as const) {
      const item = newItem(delivery({ kind }), { now: 0, answerTimeoutMs: 1 });
      assert.equal(item.state, "unread");
      assert.equal(item.expectsReply, false);
      assert.equal(item.deadlineAt, undefined);
      assert.match(item.rendered, /No reply is expected/);
    }
  });

  it("times a request out as ambiguous, keeping it pending with the unmatched notice", () => {
    const item = newItem(delivery(), { now: 0, answerTimeoutMs: 1 });
    timeOut(item, 5);
    assert.equal(item.state, "timed-out");
    assert.deepEqual(item.outcome, { outcome: "ambiguous", entered: [{ origin: TIMEOUT_ORIGIN, at: 5 }] });
    assert.equal(item.outcomeReported, false);
    assert.match(item.notice!, /notice=unmatched delivery=d_1/);
    assert.match(item.notice!, /comms reply --as grok m_d_1/);
    assert.equal(isSettled(item), false);
  });

  it("answers restart checks from the inbox", () => {
    const check = (state: "claimed" | "delivered", createdAt = 500) => ({ deliveryId: "d_1", messageId: "m_d_1", state, createdAt });
    // Not in the inbox: `no` only for a claimed delivery younger than the inbox.
    assert.deepEqual(checkAnswer(check("claimed", 500), null, 100), { deliveryId: "d_1", found: "no" });
    assert.equal(checkAnswer(check("claimed", 50), null, 100).found, "unknown");
    assert.equal(checkAnswer(check("delivered", 500), null, 100).found, "unknown");
    const item = newItem(delivery(), { now: 0, answerTimeoutMs: 1000 });
    assert.deepEqual(checkAnswer(check("claimed"), item, 0), { deliveryId: "d_1", found: "yes", turnId: "grok-d_1", turn: "running" });
    item.outcome = { outcome: "replied", answer: "4" };
    // Flat outcome fields, as on the wire.
    assert.deepEqual(checkAnswer(check("delivered"), item, 0), { deliveryId: "d_1", found: "yes", turnId: "grok-d_1", turn: "completed", outcome: "replied", answer: "4" });
    const notice = newItem(delivery({ kind: "notice" }), { now: 0, answerTimeoutMs: 1 });
    assert.deepEqual(checkAnswer(check("delivered"), notice, 0), { deliveryId: "d_1", found: "yes", turnId: "grok-d_1", turn: "completed" });
  });

  it("plans answers and acks by state", () => {
    const req = newItem(delivery(), { now: 0, answerTimeoutMs: 1 });
    assert.deepEqual(planAnswer(req, "4"), { ok: true, kind: "outcome", outcome: { outcome: "replied", answer: "4" } });
    assert.equal(planAnswer(req, "  ").ok, false);
    assert.equal(planAck(req).ok, false);
    timeOut(req, 1);
    assert.deepEqual(planAnswer(req, "late"), { ok: true, kind: "reply" });
    assert.equal(planAnswer(req, "x".repeat(32_001)).ok, false);
    assert.deepEqual(planAck(req).ok && planAck(req), { ok: true, state: "acknowledged", note: "closed without an answer; the request stays unanswered in comms" });
    req.state = "replied";
    assert.equal(planAnswer(req, "again").ok, false);
    const notice = newItem(delivery({ kind: "notice" }), { now: 0, answerTimeoutMs: 1 });
    assert.equal(planAnswer(notice, "hi").ok, false);
    assert.deepEqual(planAck(notice), { ok: true, state: "acknowledged" });
  });
});

describe("store", () => {
  it("writes atomically, lists pending, and moves settled items to done/", async () => {
    const h = await home();
    const store = storeIn(h);
    await store.init();
    const item = newItem(delivery(), { now: 0, answerTimeoutMs: 1000 });
    await store.put(item);
    assert.deepEqual((await readdir(join(h, "inbox"))).sort(), ["d_1.json", "done"]);
    assert.equal((await store.get("d_1"))?.state, "awaiting-answer");
    assert.equal((await store.list()).length, 1);

    item.state = "replied";
    item.deliveredReported = true;
    item.outcome = { outcome: "replied", answer: "4" };
    item.outcomeReported = true;
    await store.put(item);
    assert.deepEqual(await readdir(join(h, "inbox")), ["done"]);
    assert.deepEqual(await readdir(join(h, "inbox", "done")), ["d_1.json"]);
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.list({ all: true })).length, 1);
    assert.equal((await store.get("d_1"))?.state, "replied");
    // Path traversal is refused.
    assert.equal(await store.get("../state"), null);
    await assert.rejects(store.put({ ...item, deliveryId: "../x" }));
  });

  it("round-trips commands and results, and appends to the log", async () => {
    const h = await home();
    const store = storeIn(h);
    await store.init();
    const file = await store.writeCommand({ id: "c1", action: "ack", deliveryId: "d_1", at: "now" });
    const commands = await store.readCommands();
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.file, file);
    assert.equal(commands[0]!.command?.action, "ack");
    await store.removeCommand(file);
    assert.equal((await store.readCommands()).length, 0);
    await store.writeResult({ id: "c1", ok: true, message: "done" });
    assert.equal((await store.readResult("c1"))?.ok, true);
    await store.log("x", { a: 1 });
    await store.log("y");
    const lines = (await readFile(join(h, "log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event), ["x", "y"]);
  });
});

describe("lock", () => {
  it("allows one holder, and takes over a lock whose process is gone", async () => {
    const h = await home();
    const path = join(h, "daemon.lock");
    const release = await acquireLock(path);
    assert.equal(await lockOwner(path), process.pid);
    // Same pid re-acquiring is treated as stale (only one daemon per process), so use a live other pid.
    const sleeper = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    const deadPid = Number(sleeper.stdout.trim());
    await release();
    assert.equal(await lockOwner(path), null);
    await writeFile(path, `${deadPid}\n`);
    const release2 = await acquireLock(path);
    assert.equal(await lockOwner(path), process.pid);
    await release2();
    await writeFile(path, `${process.ppid}\n`);
    await assert.rejects(acquireLock(path), LockHeld);
  });
});

describe("webhook", () => {
  it("leaves the text out unless asked, and POSTs the event", async () => {
    const item = newItem(delivery(), { now: 0, answerTimeoutMs: 1000 });
    const bare = wakePayload("delivery", item, { includeText: false, inboxFile: "/x/d_1.json" });
    assert.equal("text" in bare, false);
    assert.equal(bare.expectsReply, true);
    assert.equal(bare.from, "lee");
    assert.equal(wakePayload("delivery", item, { includeText: true, inboxFile: "/x" }).text, item.text);

    const got: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push(JSON.parse(body));
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await webhookWake({ url: `http://127.0.0.1:${port}/wake`, includeText: false, timeoutMs: 2000 })("timeout", item, "/x/d_1.json");
      assert.equal((got[0] as { event: string }).event, "timeout");
      assert.equal((got[0] as { deliveryId: string }).deliveryId, "d_1");
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The bridge against a scripted connector

type Handler = (op: Op, body: any) => ResponseBody<Op> | Promise<ResponseBody<Op>> | "transport";

class ScriptedClient implements ConnectorClient {
  calls: { op: Op; body: any }[] = [];
  handler: Handler;
  private queue: PollItem[][] = [];
  constructor(handler: Handler) {
    this.handler = handler;
  }
  push(items: PollItem[]) {
    this.queue.push(items);
  }
  async call<K extends Op>(op: K, body: Requests[K], options: CallOptions = {}): Promise<ResponseBody<K>> {
    this.calls.push({ op, body });
    if (op === "poll") {
      const next = this.queue.shift();
      if (next) return { ok: true, items: next } as unknown as ResponseBody<K>;
      // Held until aborted or a short while passes.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 30);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (options.signal?.aborted) throw new TransportError("aborted");
    }
    const r = await this.handler(op, body);
    if (r === "transport") throw new TransportError(`${op}: ENOENT`);
    return r as ResponseBody<K>;
  }
  ops(name: Op) {
    return this.calls.filter((c) => c.op === name);
  }
}

const okFor = (op: Op, body: any): ResponseBody<Op> => {
  switch (op) {
    case "register":
      return { ok: true, participant: { id: "p_grok", name: "grok", kind: "agent" }, pollWaitMs: 20000 } as ResponseBody<Op>;
    case "poll":
      return { ok: true, items: [] } as ResponseBody<Op>;
    case "delivered":
      return { ok: true, delivery: { id: body.deliveryId, recipient: "grok", state: "delivered" } } as ResponseBody<Op>;
    case "outcome":
      return { ok: true, delivery: { id: body.deliveryId, recipient: "grok", state: body.outcome }, answerMessageId: "m_ans", duplicate: false } as ResponseBody<Op>;
    case "reply":
      return { ok: true, message: { id: "m_reply" }, deliveries: [], skipped: [], completed: body.messageId } as unknown as ResponseBody<Op>;
    default:
      return { ok: true } as ResponseBody<Op>;
  }
};

async function bridgeWith(client: ScriptedClient, opts: { answerTimeoutMs?: number } = {}) {
  const h = await home();
  const store = storeIn(h);
  const logs: string[] = [];
  const bridge = new Bridge({
    config: { participant: "grok", cwd: h, pollWaitMs: 1000, answerTimeoutMs: opts.answerTimeoutMs ?? 60_000, unregisterOnExit: false, home: h },
    client,
    store,
    log: (l) => logs.push(l),
    tickMs: 20,
    backoff: { initialMs: 10, maxMs: 40 },
    watchOutbox: false,
  });
  await bridge.start();
  cleanups.unshift(() => bridge.stop().then(() => {}));
  return { bridge, store, logs, home: h };
}

describe("bridge (scripted connector)", () => {
  it("backs off through socket errors, then registers and polls", async () => {
    let failures = 3;
    const client = new ScriptedClient((op, body) => (op === "register" && failures-- > 0 ? "transport" : okFor(op, body)));
    const { bridge, logs } = await bridgeWith(client);
    await waitFor("registration", () => bridge.isRegistered);
    assert.equal(client.ops("register").length, 4);
    assert.ok(logs.some((l) => /register: register: ENOENT/.test(l)));
    await waitFor("a poll", () => client.ops("poll").length > 0);
    assert.equal(client.ops("register")[0]!.body.harness, "claude-code");
    assert.equal(client.ops("register")[0]!.body.status, "idle");
  });

  it("persists before reporting delivered, goes busy, and registers again on unknown_session from a report", async () => {
    let lose = true;
    const client = new ScriptedClient((op, body) => {
      if (op === "delivered" && lose) {
        lose = false;
        return errorBody("unknown_session", "register again");
      }
      return okFor(op, body);
    });
    const { bridge, store } = await bridgeWith(client);
    await waitFor("registration", () => bridge.isRegistered);
    client.push([{ type: "deliver", delivery: delivery() }]);
    await waitFor("delivered", () => client.ops("delivered").length === 2);
    assert.ok((await store.get("d_1"))?.deliveredReported);
    assert.equal(client.ops("register").length, 2);
    assert.deepEqual(client.ops("delivered")[1]!.body, { sessionId: bridge.sessionId, deliveryId: "d_1", turnId: "grok-d_1" });
    await waitFor("presence busy", () => client.ops("presence").some((c) => c.body.status === "busy") || client.ops("register")[1]!.body.status === "busy");
  });

  it("falls back to reply when the connector refuses the replied outcome", async () => {
    const client = new ScriptedClient((op, body) => (op === "outcome" ? errorBody("conflict", "delivery d_1 is already uncertain") : okFor(op, body)));
    const { bridge, store } = await bridgeWith(client);
    await waitFor("registration", () => bridge.isRegistered);
    client.push([{ type: "deliver", delivery: delivery() }]);
    await waitFor("inbox", () => store.get("d_1").then((i) => i?.deliveredReported));
    await store.writeCommand({ id: "c1", action: "answer", deliveryId: "d_1", text: "4", at: "now" });
    await bridge.tick();
    const done = await waitFor("replied-late", () => store.get("d_1").then((i) => i?.state === "replied-late" && i));
    assert.equal(done.answerMessageId, "m_reply");
    const reply = client.ops("reply")[0]!.body;
    assert.equal(reply.as, "grok");
    assert.equal(reply.messageId, "m_d_1");
    assert.equal(reply.text, "4");
    assert.match(reply.key, /^grokbot-fallback-d_1$/);
    assert.equal((await store.readResult("c1"))?.ok, true);
  });

  it("reports ambiguous on timeout, then posts a late answer with reply", async () => {
    const client = new ScriptedClient(okFor);
    const { bridge, store } = await bridgeWith(client, { answerTimeoutMs: 100 });
    await waitFor("registration", () => bridge.isRegistered);
    client.push([{ type: "deliver", delivery: delivery() }]);
    await waitFor("ambiguous", () => client.ops("outcome").length === 1);
    assert.deepEqual(client.ops("outcome")[0]!.body.entered.map((e: { origin: string }) => e.origin), [TIMEOUT_ORIGIN]);
    assert.equal(client.ops("outcome")[0]!.body.outcome, "ambiguous");
    assert.equal((await store.get("d_1"))?.state, "timed-out");
    await waitFor("idle again", () => client.ops("presence").at(-1)?.body.status === "idle");
    await store.writeCommand({ id: "c2", action: "answer", deliveryId: "d_1", text: "late", at: "now" });
    await waitFor("replied-late", () => store.get("d_1").then((i) => i?.state === "replied-late"));
    assert.equal(client.ops("outcome").length, 1);
    assert.equal(client.ops("reply")[0]!.body.text, "late");
  });

  it("stops when a report says session_superseded", async () => {
    const client = new ScriptedClient((op, body) => (op === "delivered" ? errorBody("session_superseded", "newer session") : okFor(op, body)));
    const { bridge } = await bridgeWith(client);
    await waitFor("registration", () => bridge.isRegistered);
    client.push([{ type: "deliver", delivery: delivery() }]);
    assert.equal(await bridge.done, "superseded");
  });
});
