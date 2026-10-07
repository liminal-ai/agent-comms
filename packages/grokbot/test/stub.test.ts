// Integration: the bridge against the stub connector over the real socket
// protocol (in-process stub, real socket client, real files). Covers the inbox
// write, delivered, answer → replied, timeout → ambiguous → late reply, serial
// delivery, notices, restart checks, re-registration on unknown_session, and
// supersession. Unix sockets only; Grok Bot's box is Linux.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { parseDeliveryHeader } from "@agent-comms/protocol";
import { type Fixture, StubComms, startStubServer, type StubServer } from "@agent-comms/connector-stub";
import { Bridge } from "../src/bridge.ts";
import { run } from "../src/cli.ts";
import { socketClient } from "../src/client.ts";
import { acquireLock } from "../src/lock.ts";
import type { InboxItem } from "../src/store.ts";
import type { WakeEvent } from "../src/webhook.ts";
import { storeIn, tempDir, waitFor } from "./support.ts";

const skip = process.platform === "win32" ? "the bridge runs on Unix sockets (Grok Bot's box is Linux)" : false;

const fixture: Fixture = {
  machine: "grok-box",
  participants: [{ name: "lee", kind: "human", home: { harness: "web" } }, { name: "grok" }, { name: "cedar" }],
  conversations: [{ id: "g1", kind: "group", title: "build", members: ["lee", "grok", "cedar"] }],
};

type Body = Record<string, any>;

function http(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

let root: string;
let cleanupRoot: () => Promise<void>;
let socket: string;
let recordPath: string;
let comms: StubComms;
let server: StubServer;
let home: string;
const bridges: Bridge[] = [];
let releaseLock: (() => Promise<void>) | undefined;

async function startStub(existing?: StubComms) {
  comms = existing ?? StubComms.fromFixture(fixture);
  server = await startStubServer({ socketPath: socket, comms, recordPath, pollWaitMs: 1000 });
}

const stubState = async () => (await http(socket, "GET", "/stub/state")).body;
const deliveryState = async (id: string) => (await stubState()).record.deliveries.find((d: Body) => d.id === id)?.status;
const session = async (id: string) => (await stubState()).sessions.find((s: Body) => s.id === id);
const post = async (input: Body) => {
  const r = await http(socket, "POST", "/stub/post", input);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const records = async () =>
  (await readFile(recordPath, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Body);

function newBridge(options: { answerTimeoutMs?: number; wake?: (e: WakeEvent, item: InboxItem) => void } = {}) {
  const bridge = new Bridge({
    config: { participant: "grok", cwd: home, pollWaitMs: 2000, answerTimeoutMs: options.answerTimeoutMs ?? 60_000, unregisterOnExit: false, home },
    client: socketClient(socket),
    store: storeIn(home),
    log: () => {},
    tickMs: 25,
    backoff: { initialMs: 20, maxMs: 200 },
    ...(options.wake ? { wake: async (e: WakeEvent, item: InboxItem) => options.wake!(e, item) } : {}),
  });
  bridges.push(bridge);
  return bridge;
}

/** The grokbot CLI, in-process, as Grok Bot would run it. */
async function grokbot(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(["--home", home, "--socket", socket, ...args], {
    env: {},
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: async () => "",
  });
  return { code, stdout, stderr };
}

describe("grokbot bridge against the stub connector", { skip }, () => {
  beforeEach(async () => {
    ({ dir: root, cleanup: cleanupRoot } = await tempDir());
    socket = join(root, "agent-comms", "connector.sock");
    recordPath = join(root, "record.jsonl");
    home = join(root, "grok-home");
    await startStub();
    // The CLI waits for the daemon only when one holds the lock; this process plays the daemon.
    const store = storeIn(home);
    await store.init();
    releaseLock = await acquireLock(join(home, "daemon.lock"));
  });
  afterEach(async () => {
    for (const b of bridges.splice(0)) await b.stop();
    await releaseLock?.();
    await server.close();
    await cleanupRoot();
  });
  after(() => {});

  it("writes a request to the inbox, reports delivered at once, and reports the answer as replied", async () => {
    const woken: string[] = [];
    const bridge = newBridge({ wake: (e, item) => woken.push(`${e}:${item.deliveryId}`) });
    await bridge.start();
    await waitFor("registration", () => bridge.isRegistered);
    await post({ sender: "lee", to: ["grok"], conversationId: "g1", text: "grok: what's 2+2?" });

    const file = join(home, "inbox", "d_1.json");
    await waitFor("inbox file", () => existsSync(file));
    const item = JSON.parse(await readFile(file, "utf8")) as InboxItem;
    assert.equal(item.kind, "request");
    assert.equal(item.expectsReply, true);
    assert.equal(item.from.name, "lee");
    assert.equal(item.conversation.id, "g1");
    assert.equal(item.text, "grok: what's 2+2?");
    assert.equal(parseDeliveryHeader(item.rendered)?.deliveryId, "d_1");

    const delivered = await waitFor("delivered", async () => {
      const s = await deliveryState("d_1");
      return s?.state === "delivered" && s;
    });
    assert.equal(delivered.turnId, "grok-d_1");
    await waitFor("busy", async () => (await session(bridge.sessionId))?.status === "busy");
    assert.deepEqual(woken, ["delivery:d_1"]);

    const listed = await grokbot("inbox");
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /PENDING d_1 {2}request {2}awaiting-answer {2}from @lee/);
    const shown = await grokbot("show", "d_1");
    assert.match(shown.stdout, /\[agent-comms v1\] delivery=d_1 message=m_1 kind=request/);
    assert.match(shown.stdout, /Next: grokbot answer d_1/);

    const answered = await grokbot("answer", "d_1", "It's", "4.");
    assert.equal(answered.code, 0, answered.stderr);
    assert.match(answered.stdout, /answered d_1: collected as the reply to @lee \(message m_2\)/);
    assert.equal((await deliveryState("d_1")).state, "replied");
    const answer = (await stubState()).record.messages.find((m: Body) => m.id === "m_2");
    assert.equal(answer.text, "It's 4.");
    assert.equal(answer.kind, "answer");
    assert.equal(answer.collectedFrom, "d_1");
    assert.equal(answer.inReplyTo, "m_1");

    assert.ok(!existsSync(file));
    assert.ok(existsSync(join(home, "inbox", "done", "d_1.json")));
    assert.match((await grokbot("inbox")).stdout, /nothing pending/);
    await waitFor("idle", async () => (await session(bridge.sessionId))?.status === "idle");
    const log = (await readFile(join(home, "log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).event);
    for (const e of ["started", "registered", "received", "command"]) assert.ok(log.includes(e), `log has ${e}`);
    // Answering again is refused.
    const again = await grokbot("answer", "d_1", "5");
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already replied/);
  });

  it("times out an unanswered request as ambiguous, moves the queue on, and posts a late answer with reply", async () => {
    const woken: string[] = [];
    const bridge = newBridge({ answerTimeoutMs: 400, wake: (e, item) => woken.push(`${e}:${item.deliveryId}`) });
    await bridge.start();
    await waitFor("registration", () => bridge.isRegistered);
    await post({ sender: "lee", to: ["grok"], conversationId: "g1", text: "first, slow" });
    await post({ sender: "cedar", to: ["grok"], text: "second, a DM" });

    // Serial: the second isn't handed out while the first is in flight.
    await waitFor("d_1 delivered", async () => (await deliveryState("d_1"))?.state === "delivered");
    assert.equal((await deliveryState("d_2")).state, "pending");

    const ambiguous = await waitFor("ambiguous", async () => {
      const s = await deliveryState("d_1");
      return s?.state === "ambiguous" && s;
    });
    assert.match(ambiguous.detail, /grokbot-answer-timeout/);
    // The queue moved on: the second request arrives.
    await waitFor("d_2 in the inbox", () => existsSync(join(home, "inbox", "d_2.json")));
    const flagged = JSON.parse(await readFile(join(home, "inbox", "d_1.json"), "utf8")) as InboxItem;
    assert.equal(flagged.state, "timed-out");
    assert.match(flagged.notice!, /comms reply --as grok m_1/);
    const listed = await grokbot("inbox");
    assert.match(listed.stdout, /PENDING d_1 {2}request {2}timed-out/);
    assert.match((await grokbot("show", "d_1")).stdout, /notice=unmatched delivery=d_1 message=m_1/);
    assert.ok(woken.includes("timeout:d_1"));

    const late = await grokbot("answer", "d_1", "sorry, it's done now");
    assert.equal(late.code, 0, late.stderr);
    assert.match(late.stdout, /answered d_1 late: posted with comms reply/);
    const s = await deliveryState("d_1");
    assert.equal(s.state, "replied");
    assert.match(s.detail, /completed by comms reply/);
    assert.ok(existsSync(join(home, "inbox", "done", "d_1.json")));

    const second = await grokbot("answer", "d_2", "on it");
    assert.equal(second.code, 0, second.stderr);
    assert.equal((await deliveryState("d_2")).state, "replied");
  });

  it("registers again after a connector restart (unknown_session) and answers the restart check from the inbox", async () => {
    const bridge = newBridge();
    await bridge.start();
    await waitFor("registration", () => bridge.isRegistered);
    await post({ sender: "lee", to: ["grok"], conversationId: "g1", text: "survive a restart" });
    await waitFor("delivered", async () => (await deliveryState("d_1"))?.state === "delivered");

    // Restart: same record, no sessions (as a restarted connector).
    await server.close();
    await startStub(new StubComms(comms.record));
    await waitFor("registered again", () => bridge.stats.registrations === 2);
    await waitFor("check answered", async () => (await records()).some((r) => r.path === "/v1/check-result" && r.status === 200));

    const log = await records();
    assert.ok(log.some((r) => r.path === "/v1/poll" && r.response?.error?.code === "unknown_session"), "a poll answered unknown_session");
    const check = log.find((r) => r.path === "/v1/check-result")!;
    assert.deepEqual(
      { found: check.request.found, turn: check.request.turn, turnId: check.request.turnId },
      { found: "yes", turn: "running", turnId: "grok-d_1" },
    );
    assert.equal((await deliveryState("d_1")).state, "delivered");

    const answered = await grokbot("answer", "d_1", "still here");
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal((await deliveryState("d_1")).state, "replied");
  });

  it("answers a check for a claimed delivery another session took with unknown, so it isn't run twice", async () => {
    // Start once so the inbox's history begins before the message exists.
    const first = newBridge();
    await first.start();
    await waitFor("registration", () => first.isRegistered);
    await first.stop();

    await post({ sender: "lee", to: ["grok"], conversationId: "g1", text: "claimed elsewhere" });
    // Another session of @grok takes it and vanishes before it reaches Grok Bot.
    await http(socket, "POST", "/v1/register", { participant: "grok", harness: "claude-code", sessionId: "lost", cwd: "/", status: "idle" });
    const polled = await http(socket, "POST", "/v1/poll", { sessionId: "lost", waitMs: 100 });
    assert.equal(polled.body.items[0].delivery.id, "d_1");
    assert.equal((await deliveryState("d_1")).state, "claimed");

    const bridge = newBridge();
    await bridge.start();
    // The lost session may have run it: grokbot can't rule that out, so it's not offered again.
    await waitFor("check answered", async () => (await records()).some((r) => r.path === "/v1/check-result"));
    const check = (await records()).find((r) => r.path === "/v1/check-result");
    assert.equal(check?.request.found, "unknown");
    await waitFor("surfaced as uncertain", async () => (await deliveryState("d_1"))?.state === "uncertain");
    assert.equal(existsSync(join(home, "inbox", "d_1.json")), false);
  });

  it("delivers notices without collecting anything, and ack marks them read", async () => {
    const bridge = newBridge();
    await bridge.start();
    await waitFor("registration", () => bridge.isRegistered);
    await post({ sender: "lee", to: ["grok"], conversationId: "g1", text: "FYI: deploy at 5", kind: "notice" });
    await post({ sender: "lee", to: ["grok"], conversationId: "g1", text: "and a question" });
    await waitFor("notice delivered", async () => (await deliveryState("d_1"))?.state === "delivered");
    // A notice ends at delivered, so the request behind it comes straight away.
    await waitFor("request in the inbox", () => existsSync(join(home, "inbox", "d_2.json")));
    const notice = JSON.parse(await readFile(join(home, "inbox", "d_1.json"), "utf8")) as InboxItem;
    assert.equal(notice.state, "unread");
    assert.equal(notice.expectsReply, false);
    assert.ok(!(await records()).some((r) => r.path === "/v1/outcome" && r.request.deliveryId === "d_1"));

    const refused = await grokbot("answer", "d_1", "thanks");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /no reply is expected/);
    const acked = await grokbot("ack", "d_1");
    assert.equal(acked.code, 0, acked.stderr);
    assert.match(acked.stdout, /d_1: acknowledged/);
    await waitFor("moved to done", () => existsSync(join(home, "inbox", "done", "d_1.json")));
    assert.equal((await grokbot("ack", "d_2")).code, 1);
  });

  it("stops cleanly when a newer session supersedes it", async () => {
    const bridge = newBridge();
    await bridge.start();
    await waitFor("registration", () => bridge.isRegistered);
    await http(socket, "POST", "/v1/register", { participant: "grok", harness: "claude-code", sessionId: "newer", cwd: "/", status: "idle" });
    assert.equal(await bridge.done, "superseded");
  });

  it("keeps retrying registration while the participant isn't homed here", async () => {
    await server.close();
    const elsewhere = fixture.participants.map((p) => (p.name === "grok" ? { name: "grok", home: { machine: "another-box" } } : p));
    await startStub(StubComms.fromFixture({ ...fixture, participants: elsewhere }));
    const bridge = newBridge();
    await bridge.start();
    await waitFor("refused", async () => (await records()).some((r) => r.path === "/v1/register" && r.response?.error?.code === "not_homed_here"));
    assert.equal(bridge.isRegistered, false);
    assert.match(bridge.snapshot().lastError ?? "", /must be promoted/);
  });
});
