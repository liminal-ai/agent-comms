// Shared test support: the real connector stub on a Unix socket, and a fake
// Claude Code session standing in for the engine's `$`.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach } from "node:test";
import { type Fixture, StubComms, startStubServer, type StubServer } from "@agent-comms/connector-stub";
import { CommsMod, type Host } from "../hooks/core/mod.ts";

export const fixture: Fixture = {
  machine: "box",
  participants: [{ name: "lee", kind: "human", home: { harness: "web" } }, { name: "mod-a" }, { name: "mod-b" }],
  conversations: [],
  messages: [],
};

export function rawCall(socketPath: string, path: string, body: string, method = "POST"): Promise<{ status: number; text: string }> {
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
export class FakeSession {
  submitted: string[] = [];
  journal: string | null = null;
  journalWritable = true;
  transcript: string[] = [];
  logs: string[] = [];
  calls: { path: string; body: any; at: number }[] = [];
  inFlightPolls = 0;
  maxInFlightPolls = 0;
  dropNext: string | undefined;
  /** Requests to these paths never answer (a wedged connector). */
  hangPaths = new Set<string>();
  clock = 1_000_000;
  socketPath: string;
  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }
  host(): Host {
    return {
      call: async (path, body) => {
        this.calls.push({ path, body: JSON.parse(body), at: this.clock });
        if (this.hangPaths.has(path)) return new Promise(() => {});
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
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => this.logs.push(line),
      loadJournal: async () => this.journal,
      saveJournal: async (text) => {
        if (!this.journalWritable) throw new Error("EACCES: journal not writable");
        this.journal = text;
      },
      transcriptHas: async (needle) => this.transcript.some((t) => t.includes(needle)),
    };
  }
  ops(op: string) {
    return this.calls.filter((c) => c.path === `/v1/${op}`).map((c) => c.body);
  }
}

export interface StubContext {
  server: StubServer;
  comms: StubComms;
  socketPath: string;
}

/** Registers hooks that start a fresh stub before each test; returns a live view of it. */
export function useStub(prefix: string): StubContext & { restart(existing?: StubComms): Promise<void> } {
  const ctx = {} as StubContext & { restart(existing?: StubComms): Promise<void> };
  let root: string;
  let n = 0;
  const start = async (existing?: StubComms) => {
    ctx.comms = existing ?? StubComms.fromFixture(fixture);
    ctx.server = await startStubServer({ socketPath: ctx.socketPath, comms: ctx.comms, pollWaitMs: 300 });
  };
  ctx.restart = async (existing?: StubComms) => {
    await ctx.server.close();
    await start(existing);
  };
  beforeEach(async () => {
    root ??= await mkdtemp(join(tmpdir(), prefix));
    const dir = join(root, `s${++n}`);
    await mkdir(dir, { recursive: true });
    ctx.socketPath = join(dir, "agent-comms", "connector.sock");
    await start();
  });
  afterEach(() => ctx.server.close());
  after(() => (root ? rm(root, { recursive: true, force: true }) : undefined));
  return ctx;
}

export const until = async (test: () => boolean | Promise<boolean>, what: string, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
};

export function makeMod(session: FakeSession, sessionId = "sess-1", participant = "mod-a", extra: { callTimeoutMs?: number; pollGraceMs?: number; startDeadlineMs?: number } = {}) {
  return new CommsMod(session.host(), { participant, sessionId, cwd: "/tmp", pluginName: "agent-comms", pollWaitMs: 200, ...extra });
}

export async function pumpUntil(mod: CommsMod, test: () => boolean | Promise<boolean>, what: string, ms?: number) {
  await until(
    async () => {
      await mod.tick();
      return test();
    },
    what,
    ms,
  );
}

export const wrap = (text: string) =>
  `The agent-comms plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;

export function stubOps(ctx: StubContext) {
  const post = (body: object) => rawCall(ctx.socketPath, "/stub/post", JSON.stringify(body)).then((r) => JSON.parse(r.text));
  const state = () => rawCall(ctx.socketPath, "/stub/state", "", "GET").then((r) => JSON.parse(r.text));
  const deliveryState = async (id: string) => (await state()).record.deliveries.find((d: any) => d.id === id)?.status?.state;
  return { post, state, deliveryState };
}
