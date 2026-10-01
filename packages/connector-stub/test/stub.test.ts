import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { parseDeliveryHeader, renderDelivery, type Delivery, type PollItem } from "@agent-comms/protocol";
import { type Fixture, prepareSocketPath, StubComms, startStubServer, type StubServer } from "../src/index.ts";

const fixture: Fixture = {
  machine: "box",
  participants: [
    { name: "lee", kind: "human", home: { harness: "web" } },
    { name: "mod-a" },
    { name: "mod-b" },
    { name: "reed", home: { harness: "t3", locator: "thread-1" } },
    { name: "far", home: { machine: "elsewhere" } },
    { name: "old", state: "retired" },
    { name: "napper", state: "paused" },
  ],
  conversations: [
    { id: "g1", kind: "group", title: "build", members: ["lee", "mod-a", "mod-b", "reed", "old", "napper"] },
  ],
  messages: [
    { sender: "lee", to: [], conversationId: "g1", text: "hello all" },
    { sender: "lee", to: ["mod-a"], conversationId: "g1", text: "mod-a, say OK" },
  ],
};

const root = await mkdtemp(join(tmpdir(), "comms-stub-test-"));
after(() => rm(root, { recursive: true, force: true }));
let n = 0;

type Body = Record<string, any>;

function post(socketPath: string, path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: Body }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({ socketPath, path, method: path === "/stub/state" ? "GET" : "POST", signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

let server: StubServer;
let comms: StubComms;
let sock: string;
let recordPath: string;
const op = (name: string, body: unknown = {}) => post(sock, `/v1/${name}`, body);
const ok = async (name: string, body: unknown = {}) => {
  const r = await op(name, body);
  assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const register = (participant: string, sessionId = `s-${participant}`) =>
  ok("register", { participant, harness: "claude-code", sessionId, cwd: "/work", status: "idle" });
const poll = async (sessionId: string, waitMs = 50): Promise<PollItem[]> => (await ok("poll", { sessionId, waitMs })).items;
const onlyDelivery = (items: PollItem[]): Delivery => {
  assert.equal(items.length, 1);
  assert.equal(items[0]!.type, "deliver");
  return (items[0] as { delivery: Delivery }).delivery;
};

async function start(existing?: StubComms) {
  const dir = join(root, `run-${++n}`);
  await mkdir(dir);
  sock = join(dir, "agent-comms", "connector.sock");
  recordPath = join(dir, "record.jsonl");
  comms = existing ?? StubComms.fromFixture(fixture);
  server = await startStubServer({ socketPath: sock, comms, recordPath, pollWaitMs: 100 });
}

describe("stub connector", () => {
  beforeEach(() => start());
  afterEach(() => server.close());

  it("reports itself and who is homed here", async () => {
    const r = await ok("status");
    assert.equal(r.implementation, "stub");
    assert.equal(r.machine, "box");
    const names = r.participants.map((p: Body) => p.participant.name);
    assert.ok(names.includes("mod-a") && names.includes("reed") && !names.includes("far"));
  });

  it("delivers a fixture request with bounded history, and collects the answer once", async () => {
    await register("mod-a");
    const d = onlyDelivery(await poll("s-mod-a"));
    assert.equal(d.recipient.name, "mod-a");
    assert.equal(d.message.text, "mod-a, say OK");
    assert.deepEqual(d.history.messages.map((m) => m.text), ["hello all"]);
    assert.equal(d.status.state, "claimed");
    const rendered = renderDelivery(d, { harnessLabelsSource: true });
    assert.equal(parseDeliveryHeader(rendered)?.deliveryId, d.id);

    const delivered = await ok("delivered", { sessionId: "s-mod-a", deliveryId: d.id, turnId: "t1" });
    assert.equal(delivered.delivery.state, "delivered");
    // Idempotent for the same turn, a conflict for another.
    await ok("delivered", { sessionId: "s-mod-a", deliveryId: d.id, turnId: "t1" });
    assert.equal((await op("delivered", { sessionId: "s-mod-a", deliveryId: d.id, turnId: "t2" })).status, 409);

    const first = await ok("outcome", { sessionId: "s-mod-a", deliveryId: d.id, turnId: "t1", outcome: "replied", answer: "OK" });
    assert.equal(first.delivery.state, "replied");
    assert.equal(first.duplicate, false);
    const again = await ok("outcome", { sessionId: "s-mod-a", deliveryId: d.id, turnId: "t1", outcome: "replied", answer: "OK!" });
    assert.equal(again.duplicate, true);
    assert.equal(again.answerMessageId, first.answerMessageId);

    const read = await ok("read", { as: "mod-a", conversationId: "g1" });
    const answer = read.messages.at(-1);
    assert.equal(answer.kind, "answer");
    assert.equal(answer.inReplyTo, d.message.id);
    assert.equal(answer.collectedFrom, d.id);
    assert.equal(answer.text, "OK");
    // Lee is human: he reads the answer in the web view; no delivery for him.
    const state = (await post(sock, "/stub/state", undefined)).body;
    assert.equal(state.record.deliveries.filter((x: Body) => x.recipientId === "p_lee").length, 0);
  });

  it("holds a poll until a delivery arrives", async () => {
    await register("mod-b");
    const started = Date.now();
    const waiting = ok("poll", { sessionId: "s-mod-b", waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    await ok("send", { as: "mod-a", to: ["mod-b"], text: "ping" });
    const items = (await waiting).items;
    assert.equal(onlyDelivery(items).message.text, "ping");
    assert.ok(Date.now() - started < 2000);
  });

  it("answers an idle poll with no items after the wait", async () => {
    await register("mod-b");
    const started = Date.now();
    assert.deepEqual(await poll("s-mod-b", 150), []);
    assert.ok(Date.now() - started >= 140);
  });

  it("rejects a second concurrent poll from the same session", async () => {
    await register("mod-b");
    const first = op("poll", { sessionId: "s-mod-b", waitMs: 300 });
    await new Promise((r) => setTimeout(r, 30));
    const second = await op("poll", { sessionId: "s-mod-b" });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "poll_in_progress");
    assert.equal((await first).status, 200);
    // And the session can poll again afterwards.
    assert.equal((await op("poll", { sessionId: "s-mod-b", waitMs: 10 })).status, 200);
  });

  it("delivers serially per participant", async () => {
    await register("mod-b");
    await ok("send", { as: "mod-a", to: ["mod-b"], text: "one" });
    await ok("send", { as: "mod-a", to: ["mod-b"], text: "two" });
    const d1 = onlyDelivery(await poll("s-mod-b"));
    assert.equal(d1.message.text, "one");
    assert.deepEqual(await poll("s-mod-b"), []);
    await ok("delivered", { sessionId: "s-mod-b", deliveryId: d1.id, turnId: "t1" });
    assert.deepEqual(await poll("s-mod-b"), [], "still running: nothing new");
    await ok("outcome", { sessionId: "s-mod-b", deliveryId: d1.id, turnId: "t1", outcome: "failed", reason: "aborted" });
    assert.equal(onlyDelivery(await poll("s-mod-b")).message.text, "two");
  });

  it("delivers an answer to the requester and never collects from it", async () => {
    await register("mod-a");
    await register("mod-b");
    // Clear mod-a's fixture delivery first.
    const fx = onlyDelivery(await poll("s-mod-a"));
    await ok("delivered", { sessionId: "s-mod-a", deliveryId: fx.id, turnId: "ta0" });
    await ok("outcome", { sessionId: "s-mod-a", deliveryId: fx.id, turnId: "ta0", outcome: "replied", answer: "OK" });

    const sent = await ok("send", { as: "mod-a", to: ["mod-b"], text: "what's 2+2?" });
    const req = onlyDelivery(await poll("s-mod-b"));
    await ok("delivered", { sessionId: "s-mod-b", deliveryId: req.id, turnId: "tb1" });
    await ok("outcome", { sessionId: "s-mod-b", deliveryId: req.id, turnId: "tb1", outcome: "replied", answer: "4" });

    const ans = onlyDelivery(await poll("s-mod-a"));
    assert.equal(ans.message.kind, "answer");
    assert.equal(ans.message.inReplyTo, sent.message.id);
    assert.equal(ans.inReplyTo?.text, "what's 2+2?");
    await ok("delivered", { sessionId: "s-mod-a", deliveryId: ans.id, turnId: "ta1" });
    const collect = await op("outcome", { sessionId: "s-mod-a", deliveryId: ans.id, turnId: "ta1", outcome: "replied", answer: "thanks" });
    assert.equal(collect.status, 409);
    // A delivered answer isn't in flight: the next request flows.
    await ok("send", { as: "mod-b", to: ["mod-a"], text: "next" });
    assert.equal(onlyDelivery(await poll("s-mod-a")).message.text, "next");
  });

  it("completes an ambiguous delivery with comms reply, and allows follow-ups", async () => {
    await register("mod-b");
    const sent = await ok("send", { as: "mod-a", to: ["mod-b"], text: "review this" });
    const d = onlyDelivery(await poll("s-mod-b"));
    await ok("delivered", { sessionId: "s-mod-b", deliveryId: d.id, turnId: "t1" });
    const amb = await ok("outcome", {
      sessionId: "s-mod-b", deliveryId: d.id, turnId: "t1", outcome: "ambiguous", entered: [{ origin: "composer" }],
    });
    assert.equal(amb.delivery.state, "ambiguous");
    const r1 = await ok("reply", { as: "mod-b", messageId: sent.message.id, text: "looks good" });
    assert.equal(r1.completed, d.id);
    assert.equal(r1.message.inReplyTo, sent.message.id);
    const r2 = await ok("reply", { as: "mod-b", messageId: sent.message.id, text: "one more thing" });
    assert.equal(r2.completed, undefined);
    assert.equal(r2.message.inReplyTo, sent.message.id);
    assert.notEqual(r2.message.id, r1.message.id);
  });

  it("supersedes an older session of the same participant", async () => {
    await register("mod-b", "old-session");
    await register("mod-b", "new-session");
    const r = await op("poll", { sessionId: "old-session" });
    assert.equal(r.body.error.code, "session_superseded");
    assert.equal((await op("poll", { sessionId: "nobody" })).body.error.code, "unknown_session");
  });

  it("enforces homes: --as must be homed here; only Claude Code homes register", async () => {
    assert.equal((await op("send", { as: "far", to: ["mod-a"], text: "x" })).body.error.code, "not_homed_here");
    assert.equal((await op("register", { participant: "reed", harness: "claude-code", sessionId: "s", cwd: "/", status: "idle" })).body.error.code, "not_homed_here");
    assert.equal((await op("send", { as: "nobody", to: ["mod-a"], text: "x" })).body.error.code, "unknown_participant");
  });

  it("skips retired recipients and holds paused ones", async () => {
    const r = await ok("send", { as: "mod-a", to: ["old", "napper", "reed"], conversationId: "g1", text: "all" });
    assert.deepEqual(r.skipped, [{ name: "old", reason: "retired" }]);
    assert.deepEqual(r.deliveries.map((d: Body) => [d.recipient, d.state]), [["napper", "pending"], ["reed", "pending"]]);
    await register("napper");
    assert.deepEqual(await poll("s-napper"), []);
  });

  it("validates requests and addressing", async () => {
    assert.equal((await op("send", { as: "mod-a", to: [], text: "x" })).body.error.code, "bad_request");
    assert.equal((await op("send", { as: "mod-a", to: ["mod-a"], text: "x" })).body.error.code, "bad_request");
    assert.equal((await op("send", { as: "mod-a", to: ["far"], conversationId: "g1", text: "x" })).body.error.code, "not_member");
    assert.equal((await op("read", { as: "far", conversationId: "g1" })).body.error.code, "not_homed_here");
    assert.equal((await op("nope")).body.error.code, "unknown_op");
    assert.equal((await post(sock, "/v1/send", "not json")).status, 400);
  });

  it("doesn't hand out a delivery on a poll whose client went away", async () => {
    await register("mod-b");
    const abort = new AbortController();
    const gone = post(sock, "/v1/poll", { sessionId: "s-mod-b", waitMs: 5000 }, abort.signal).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));
    abort.abort();
    await gone;
    await new Promise((r) => setTimeout(r, 30));
    await ok("send", { as: "mod-a", to: ["mod-b"], text: "still here?" });
    assert.equal(onlyDelivery(await poll("s-mod-b")).message.text, "still here?");
  });

  it("reads pages and moves the read position only for the newest page", async () => {
    for (let i = 0; i < 5; i++) await ok("send", { as: "mod-a", to: ["mod-b"], text: `m${i}` });
    const newest = await ok("read", { as: "mod-b", conversationId: "c_1", limit: 2 });
    assert.deepEqual(newest.messages.map((m: Body) => m.text), ["m3", "m4"]);
    assert.equal(newest.hasMore, true);
    const older = await ok("read", { as: "mod-b", conversationId: "c_1", before: 4, limit: 10 });
    assert.deepEqual(older.messages.map((m: Body) => m.seq), [1, 2, 3]);
    assert.equal(older.hasMore, false);
    const list = await ok("list", { as: "mod-b" });
    assert.equal(list.conversations[0].id, "c_1");
    assert.equal(list.conversations[0].unread, 0);
  });

  it("records every request and response", async () => {
    await ok("status");
    const lines = (await readFile(recordPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].event, "listening");
    assert.equal(lines.at(-1).path, "/v1/status");
    assert.equal(lines.at(-1).status, 200);
  });
});

describe("stub restart", () => {
  afterEach(() => server.close());

  it("asks the session about unfinished deliveries instead of re-running them", async () => {
    await start();
    await register("mod-a");
    const d = onlyDelivery(await poll("s-mod-a"));
    await ok("send", { as: "mod-b", to: ["mod-a"], text: "second" });
    const second = comms.record.deliveries.find((x) => x.status.state === "pending")!;

    // Restart: same record, sessions gone.
    await server.close();
    await start(new StubComms(comms.record));
    assert.equal((await op("poll", { sessionId: "s-mod-a" })).body.error.code, "unknown_session");
    await register("mod-a");
    const items = await poll("s-mod-a");
    assert.deepEqual(items, [{ type: "check", check: { deliveryId: d.id, messageId: d.message.id, state: "claimed", createdAt: d.message.createdAt } }]);

    // Found and still running: delivered, and nothing new while it runs.
    await ok("check-result", { sessionId: "s-mod-a", deliveryId: d.id, found: "yes", turnId: "t9", turn: "running" });
    assert.deepEqual(await poll("s-mod-a"), []);

    // Restart again mid-turn: now it's asked about the delivered turn.
    await server.close();
    await start(new StubComms(comms.record));
    await register("mod-a");
    assert.deepEqual(await poll("s-mod-a"), [
      { type: "check", check: { deliveryId: d.id, messageId: d.message.id, state: "delivered", turnId: "t9", createdAt: d.message.createdAt } },
    ]);
    const done = await ok("check-result", {
      sessionId: "s-mod-a", deliveryId: d.id, found: "yes", turnId: "t9", turn: "completed", outcome: "replied", answer: "OK",
    });
    assert.equal(done.delivery.state, "replied");
    assert.equal(onlyDelivery(await poll("s-mod-a")).id, second.id);
  });

  it("re-offers a delivery the session clearly doesn't have, and marks unknowns uncertain", async () => {
    await start();
    await register("mod-a");
    const d = onlyDelivery(await poll("s-mod-a"));
    await ok("presence", { sessionId: "s-mod-a", status: "busy" });
    await post(sock, "/stub/check", { deliveryId: d.id });
    const items = await poll("s-mod-a");
    assert.equal(items[0]?.type, "check");
    await ok("check-result", { sessionId: "s-mod-a", deliveryId: d.id, found: "no" });
    const again = onlyDelivery(await poll("s-mod-a"));
    assert.equal(again.id, d.id);

    await post(sock, "/stub/check", { deliveryId: d.id });
    await poll("s-mod-a");
    const r = await ok("check-result", { sessionId: "s-mod-a", deliveryId: d.id, found: "unknown" });
    assert.equal(r.delivery.state, "uncertain");
  });
});

describe("socket directory", () => {
  it("creates an owner-only directory and refuses a wider one", async () => {
    const base = await mkdtemp(join(root, "sock-"));
    await prepareSocketPath(join(base, "fresh", "c.sock"));
    const wide = join(base, "wide");
    await mkdir(wide);
    await chmod(wide, 0o755);
    await assert.rejects(prepareSocketPath(join(wide, "c.sock")), /mode 0755; it must be 0700/);
  });

  it("refuses to start when something already listens on the socket", async () => {
    const base = await mkdtemp(join(root, "busy-"));
    const dir = join(base, "d");
    await mkdir(dir, { mode: 0o700 });
    const path = join(dir, "c.sock");
    const other = createServer().listen(path);
    await new Promise((r) => other.once("listening", r));
    await assert.rejects(prepareSocketPath(path), /already listening/);
    other.close();
  });
});

describe("fix pass 3.7", () => {
  afterEach(() => server.close());
  it("3.7 a delivery is handed out with its attachments", async () => {
    await start();
    await register("mod-b");
    const waiting = ok("poll", { sessionId: "s-mod-b", waitMs: 3000 });
    await ok("send", { as: "mod-a", to: ["mod-b"], text: "see file", attachments: [{ name: "a.txt", url: "file:///tmp/a.txt" }] });
    const items = (await waiting).items;
    assert.deepEqual(onlyDelivery(items).message.attachments, [{ name: "a.txt", url: "file:///tmp/a.txt" }]);
  });
});

describe("capabilities R0", () => {
  beforeEach(() => start());
  afterEach(() => server.close());

  it("answers the capabilities operations unsupported (501) until they're built, never silently", async () => {
    const cases: [string, unknown][] = [
      ["await", { as: "mod-a", messageId: "m_1" }],
      ["ack", { as: "mod-a", messageId: "m_1" }],
      ["message-status", { as: "mod-a", messageId: "m_1" }],
      ["remind", { as: "mod-a", target: "reed", text: "x", everyMs: 60_000 }],
      ["reminders", { as: "mod-a" }],
      ["reminder", { as: "mod-a", id: "r_1" }],
      ["reminder-update", { as: "mod-a", id: "r_1", action: "pause" }],
      ["send", { as: "mod-a", to: ["reed"], text: "x", wait: true }],
    ];
    for (const [name, body] of cases) {
      const r = await op(name, body);
      assert.equal(r.status, 501, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, "unsupported");
    }
  });
});

describe("capabilities R1", () => {
  beforeEach(() => start());
  afterEach(() => server.close());

  it("lists the registry, shows one with its home, and lets an agent set only its own entry", async () => {
    const all = await ok("agents", { as: "mod-a" });
    const names = all.agents.map((e: Body) => e.participant.name);
    assert.ok(names.includes("mod-a") && names.includes("reed"));
    assert.equal(all.agents.find((e: Body) => e.participant.name === "mod-a").home, undefined);
    const set = await ok("agents-set", { as: "mod-a", name: "mod-a", description: "a mod", duties: ["poll"] });
    assert.deepEqual([set.agent.description, set.agent.duties], ["a mod", ["poll"]]);
    const one = await ok("agents", { as: "mod-a", name: "mod-a", long: true });
    assert.equal(one.agents.length, 1);
    assert.deepEqual([one.agents[0].description, one.agents[0].home.machine], ["a mod", "box"]);
    const other = await op("agents-set", { as: "mod-a", name: "reed", description: "x" });
    assert.equal(other.body.error.code, "conflict");
    const long = await op("agents-set", { as: "mod-a", name: "mod-a", description: "x".repeat(201) });
    assert.equal(long.body.error.code, "bad_request");
  });
});
