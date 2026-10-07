// End to end, as it runs on Grok Bot's box: the stub connector's own binary,
// the grokbot daemon and the grokbot CLI as separate processes. Injects
// deliveries through the stub's controls, answers one, lets one time out,
// restarts the connector (the daemon registers again), and stops the daemon
// with SIGTERM.

import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDir, waitFor } from "./support.ts";

const skip = process.platform === "win32" ? "the bridge runs on Unix sockets (Grok Bot's box is Linux)" : false;
const stubMain = fileURLToPath(new URL("../../connector-stub/src/main.ts", import.meta.url));
const grokbotMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const run = promisify(execFile);

type Body = Record<string, any>;

function http(socketPath: string, method: string, path: string, body?: unknown): Promise<Body> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("grokbot end to end (processes)", { skip }, () => {
  const children: ChildProcess[] = [];
  let cleanup: (() => Promise<void>) | undefined;
  after(async () => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    await cleanup?.();
  });

  it("delivers, answers, times out, survives a connector restart, and stops on SIGTERM", async () => {
    const t = await tempDir("grokbot-e2e-");
    cleanup = t.cleanup;
    const socket = join(t.dir, "agent-comms", "connector.sock");
    const home = join(t.dir, "grok-home");
    const fixture = join(t.dir, "fixture.json");
    const state = join(t.dir, "stub-state.json");
    await writeFile(
      fixture,
      JSON.stringify({
        machine: "grok-box",
        participants: [{ name: "lee", kind: "human", home: { harness: "web" } }, { name: "grok" }],
        conversations: [{ id: "g1", kind: "group", title: "build", members: ["lee", "grok"] }],
      }),
    );
    const env = { ...process.env, AGENT_COMMS_SOCKET: socket, GROKBOT_HOME: home, GROKBOT_ANSWER_TIMEOUT: "4000", GROKBOT_POLL_WAIT_MS: "2000" };
    const startStub = async () => {
      const stub = spawn(process.execPath, [stubMain, "--fixture", fixture, "--state", state, "--socket", socket, "--poll-wait", "1000"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(stub);
      let err = "";
      stub.stderr!.on("data", (c) => (err += c));
      await waitFor("stub listening", () => /listening/.test(err));
      return stub;
    };
    const grokbot = (...args: string[]) => run(process.execPath, [grokbotMain, ...args], { env }).then(
      (r) => ({ code: 0, ...r }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
    );
    const deliveryState = async (id: string) => ((await http(socket, "GET", "/stub/state")).record.deliveries as Body[]).find((d) => d.id === id)?.status;

    let stub = await startStub();
    const daemon = spawn(process.execPath, [grokbotMain, "run"], { env, stdio: ["ignore", "ignore", "pipe"] });
    children.push(daemon);
    let daemonLog = "";
    daemon.stderr!.on("data", (c) => (daemonLog += c));
    await waitFor("daemon registered", () => /registered as @grok/.test(daemonLog));

    // 1. A request, answered with the CLI.
    await http(socket, "POST", "/stub/post", { sender: "lee", to: ["grok"], conversationId: "g1", text: "grok: ping?" });
    await waitFor("d_1 in the inbox", () => existsSync(join(home, "inbox", "d_1.json")));
    await waitFor("d_1 delivered", async () => (await deliveryState("d_1"))?.turnId === "grok-d_1");
    const answered = await grokbot("answer", "d_1", "pong");
    assert.equal(answered.code, 0, answered.stderr);
    assert.match(answered.stdout, /collected as the reply/);
    assert.equal((await deliveryState("d_1")).state, "replied");

    // 2. A request left alone: ambiguous after the timeout, still pending in the inbox.
    await http(socket, "POST", "/stub/post", { sender: "lee", to: ["grok"], conversationId: "g1", text: "grok: slow one" });
    await waitFor("d_2 ambiguous", async () => (await deliveryState("d_2"))?.state === "ambiguous", 15_000);
    const inbox = await grokbot("inbox");
    assert.match(inbox.stdout, /PENDING d_2 {2}request {2}timed-out/);

    // 3. The connector restarts: the daemon's session is unknown, it registers again.
    stub.kill("SIGTERM");
    await new Promise((r) => stub.once("exit", r));
    stub = await startStub();
    await waitFor("registered again", () => (daemonLog.match(/registered as @grok/g) ?? []).length >= 2, 15_000);
    await http(socket, "POST", "/stub/post", { sender: "lee", to: ["grok"], conversationId: "g1", text: "grok: after the restart?" });
    await waitFor("d_3 in the inbox", () => existsSync(join(home, "inbox", "d_3.json")));
    assert.equal((await grokbot("answer", "d_3", "yes")).code, 0);
    assert.equal((await deliveryState("d_3")).state, "replied");
    // The timed-out one, answered late after the restart.
    const late = await grokbot("answer", "d_2", "done now");
    assert.equal(late.code, 0, late.stderr);
    assert.equal((await deliveryState("d_2")).state, "replied");

    const status = JSON.parse((await grokbot("status", "--json")).stdout);
    assert.equal(status.daemon.running, true);
    assert.equal(status.connector.implementation, "stub");
    assert.equal(status.inbox.pending, 0);

    // 4. SIGTERM: a clean exit, lock released.
    daemon.kill("SIGTERM");
    const code = await new Promise((r) => daemon.once("exit", r));
    assert.equal(code, 0, daemonLog);
    assert.ok(!existsSync(join(home, "daemon.lock")));
    const events = (await readFile(join(home, "log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).event);
    assert.ok(events.includes("timed-out") && events.includes("stopped"));
    stub.kill("SIGTERM");
  });
});
