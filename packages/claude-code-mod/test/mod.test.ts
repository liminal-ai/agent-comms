// The mod against the real connector stub over a Unix socket: registration,
// polling, submission, reports, restart checks, reconnection, slow polls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { type Fixture, StubComms, startStubServer, type StubServer } from "@agent-comms/connector-stub";
import { CommsMod, type Host } from "../hooks/core/mod.ts";
import { parseDeliveryHeader } from "../hooks/protocol/render.ts";

const fixture: Fixture = {
  machine: "box",
  participants: [{ name: "lee", kind: "human", home: { harness: "web" } }, { name: "mod-a" }, { name: "mod-b" }],
  conversations: [],
  messages: [],
};

const root = await mkdtemp(join(tmpdir(), "comms-mod-test-"));
after(() => rm(root, { recursive: true, force: true }));
let n = 0;

function rawCall(socketPath: string, path: string, body: string, method = "POST"): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A fake Claude Code session: records submissions, lets tests drive turns. */
class FakeSession {
  submitted: string[] = [];
  journal: string | null = null;
  transcript: string[] = [];
  logs: string[] = [];
  calls: { path: string; body: any; at: number }[] = [];
  inFlightPolls = 0;
  maxInFlightPolls = 0;
  dropNext: string | undefined;
  clock = 1_000_000;
  socketPath: string;
  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }
  host(): Host {
    return {
      call: async (path, body) => {
        this.calls.push({ path, body: JSON.parse(body), at: this.clock });
        const isPoll = path === "/v1/poll";
        if (isPoll) this.maxInFlightPolls = Math.max(this.maxInFlightPolls, ++this.inFlightPolls);
        try {
          return await rawCall(this.socketPath, path, body);
        } finally {
          if (isPoll) this.inFlightPolls--;
        }
      },
      submit: async (text) => {
        if (this.dropNext !== undefined) {
          const dropped = this.dropNext;
          this.dropNext = undefined;
          return { dropped };
        }
        this.submitted.push(text);
        this.transcript.push(text);
        return {};
      },
      now: () => this.clock,
      log: (line) => this.logs.push(line),
      loadJournal: async () => this.journal,
      saveJournal: async (text) => {
        this.journal = text;
      },
      transcriptHas: async (needle) => this.transcript.some((t) => t.includes(needle)),
    };
  }
  ops(op: string) {
    return this.calls.filter((c) => c.path === `/v1/${op}`).map((c) => c.body);
  }
}

let server: StubServer;
let comms: StubComms;
let socketPath: string;

async function startStub(existing?: StubComms) {
  comms = existing ?? StubComms.fromFixture(fixture);
  server = await startStubServer({ socketPath, comms, pollWaitMs: 300 });
}

beforeEach(async () => {
  const dir = join(root, `s${++n}`);
  await mkdir(dir, { recursive: true });
  socketPath = join(dir, "agent-comms", "connector.sock");
  await startStub();
});
afterEach(() => server.close());

const post = (body: object) => rawCall(socketPath, "/stub/post", JSON.stringify(body)).then((r) => JSON.parse(r.text));
const state = () => rawCall(socketPath, "/stub/state", "", "GET").then((r) => JSON.parse(r.text));
const until = async (test: () => boolean | Promise<boolean>, what: string, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
};

function makeMod(session: FakeSession, sessionId = "sess-1", participant = "mod-a") {
  return new CommsMod(session.host(), { participant, sessionId, cwd: "/tmp", pluginName: "agent-comms", pollWaitMs: 200 });
}

async function pumpUntil(mod: CommsMod, test: () => boolean | Promise<boolean>, what: string) {
  await until(async () => {
    await mod.tick();
    return test();
  }, what);
}

const wrap = (text: string) => `The agent-comms plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;

async function deliveryState(id: string) {
  const s = await state();
  return s.record.deliveries.find((d: any) => d.id === id)?.status?.state;
}

describe("CommsMod against the stub", () => {
  it("registers, submits a delivery, reports delivered and the collected answer", async () => {
    const session = new FakeSession(socketPath);
    const mod = makeMod(session);
    await mod.start();
    assert.equal(session.ops("register")[0].participant, "mod-a");
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "what's 2+2?" });
    const deliveryId = sent.deliveries[0].id;
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    const header = parseDeliveryHeader(session.submitted[0]!)!;
    assert.equal(header.deliveryId, deliveryId);

    mod.onTurnStart("turn-1", wrap(session.submitted[0]!));
    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "4" });
    await pumpUntil(mod, () => session.ops("outcome").length === 1, "the outcome");
    assert.equal(await deliveryState(deliveryId), "replied");
    assert.deepEqual(session.ops("delivered")[0], { sessionId: "sess-1", deliveryId, turnId: "turn-1" });
    assert.deepEqual(session.ops("presence").map((p) => p.status), ["busy", "idle"]);
  });

  it("reports other input in our turn as ambiguous and tells the agent to comms reply", async () => {
    const session = new FakeSession(socketPath);
    const mod = makeMod(session);
    await mod.start();
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "run the tests" });
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    mod.onTurnStart("turn-1", wrap(session.submitted[0]!));
    mod.onPromptSubmit({ turnId: "turn-1", origin: { kind: "composer" }, text: "also 2+2?" });
    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "tests pass; 4" });
    session.clock += 5_000;
    await pumpUntil(mod, () => session.ops("outcome").length === 1 && session.submitted.length === 2, "outcome and notice");
    assert.equal(session.ops("outcome")[0].outcome, "ambiguous");
    assert.equal(await deliveryState(sent.deliveries[0].id), "ambiguous");
    const notice = session.submitted[1]!;
    assert.match(notice, /comms reply --as mod-a m_\d+ /);
    assert.equal(parseDeliveryHeader(notice), null);
    // The notice's own turn is never reported.
    mod.onTurnStart("turn-2", wrap(notice));
    mod.onTurnComplete({ turnId: "turn-2", reason: "answer", answer: "replied with comms" });
    await mod.tick();
    assert.equal(session.ops("outcome").length, 1);
  });

  it("an answer delivery is delivered and nothing its turn does is collected", async () => {
    const session = new FakeSession(socketPath);
    const mod = makeMod(session);
    await mod.start();
    const req = await post({ sender: "mod-a", to: ["mod-b"], text: "ping" });
    await post({ sender: "mod-b", to: ["mod-a"], kind: "answer", inReplyTo: req.message.id, text: "pong" });
    await pumpUntil(mod, () => session.submitted.length === 1, "the answer delivery");
    mod.onTurnStart("turn-1", wrap(session.submitted[0]!));
    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "got pong, sending another ping" });
    await pumpUntil(mod, () => session.ops("delivered").length === 1, "delivered");
    await mod.tick();
    assert.equal(session.ops("outcome").length, 0);
  });

  it("dedupes a delivery handed out twice", async () => {
    const session = new FakeSession(socketPath);
    const mod = makeMod(session);
    await mod.start();
    await post({ sender: "mod-b", to: ["mod-a"], text: "once" });
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    // The same delivery handed out again (a replayed poll) is not submitted twice.
    const d = comms.record.deliveries[0]!;
    await (mod as any).handle({ type: "deliver", delivery: (comms as any).render(d) });
    await mod.tick();
    assert.equal(session.submitted.length, 1);
  });

  it("never overlaps polls when the connector is slow", async () => {
    const session = new FakeSession(socketPath);
    const mod = new CommsMod(session.host(), { participant: "mod-a", sessionId: "sess-1", cwd: "/tmp", pluginName: "agent-comms", pollWaitMs: 1_000 });
    await mod.start();
    for (let i = 0; i < 10; i++) {
      await mod.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(session.maxInFlightPolls, 1);
    const pollErrors = session.logs.filter((l) => l.includes("poll_in_progress"));
    assert.deepEqual(pollErrors, []);
  });

  it("re-registers after the connector restarts and answers the restart check without re-running", async () => {
    const session = new FakeSession(socketPath);
    const mod = makeMod(session);
    await mod.start();
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "long job" });
    const deliveryId = sent.deliveries[0].id;
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    mod.onTurnStart("turn-1", wrap(session.submitted[0]!));
    await pumpUntil(mod, () => session.ops("delivered").length === 1, "delivered");

    // Restart: same record, sessions gone. The delivery comes back as a check.
    await server.close();
    await startStub(new StubComms(comms.record));

    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "finished" });
    await pumpUntil(mod, () => session.ops("register").length >= 2 || session.ops("outcome").length >= 1, "re-registration or outcome");
    await pumpUntil(mod, async () => (await deliveryState(deliveryId)) === "replied", "replied");
    assert.equal(session.submitted.length, 1, "never submitted twice");
  });

  it("answers a check for something it never saw with no, and for a transcript-only one with unknown", async () => {
    const session = new FakeSession(socketPath);
    const mod = makeMod(session);
    await mod.start();
    await (mod as any).check({ deliveryId: "d_x", messageId: "m_x", state: "claimed" });
    session.transcript.push("[agent-comms v1] delivery=d_y message=m_y kind=request");
    await (mod as any).check({ deliveryId: "d_y", messageId: "m_y", state: "claimed" });
    await until(() => session.ops("check-result").length === 2, "both check results");
    const results = session.ops("check-result").map((c) => [c.deliveryId, c.found]);
    assert.deepEqual(results, [
      ["d_x", "no"],
      ["d_y", "unknown"],
    ]);
  });

  it("a later session of the same participant knows what an earlier one submitted", async () => {
    await server.close();
    await startStub();
    const first = new FakeSession(socketPath);
    const mod1 = makeMod(first, "sess-1");
    await mod1.start();
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "before a crash" });
    await pumpUntil(mod1, () => first.submitted.length === 1, "the submission");
    mod1.onTurnStart("turn-1", wrap(first.submitted[0]!));
    await pumpUntil(mod1, () => first.ops("delivered").length === 1, "delivered");

    const second = new FakeSession(socketPath);
    second.journal = first.journal;
    const mod2 = makeMod(second, "sess-2");
    await mod2.start();
    await pumpUntil(mod2, () => second.ops("check-result").length === 1, "the check result");
    assert.equal(second.ops("check-result")[0].found, "unknown");
    assert.equal(second.submitted.length, 0);
    assert.equal(await deliveryState(sent.deliveries[0].id), "uncertain");
  });

  it("stops polling when a newer session supersedes it", async () => {
    const a = new FakeSession(socketPath);
    const mod1 = makeMod(a, "sess-1");
    await mod1.start();
    const b = new FakeSession(socketPath);
    const mod2 = makeMod(b, "sess-2");
    await mod2.start();
    await mod1.tick();
    await until(() => mod1.isStopped, "mod1 stops");
  });

  it("reports a prompt a hook dropped as failed", async () => {
    const session = new FakeSession(socketPath);
    session.dropNext = "blocked by policy";
    const mod = makeMod(session);
    await mod.start();
    await post({ sender: "mod-b", to: ["mod-a"], text: "please" });
    await pumpUntil(mod, () => session.ops("outcome").length === 1, "the failure report");
    assert.equal(session.ops("outcome")[0].reason, "rejected");
  });
});
