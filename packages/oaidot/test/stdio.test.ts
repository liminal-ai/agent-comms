import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { OaidotClient, type Transport } from "../src/client.ts";
import { MAX_STDIO_LINE_BYTES, serveStdio } from "../src/stdio.ts";

type Wire = { id: string | number | null; result?: any; error?: { code: string; message: string } };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = fileURLToPath(new URL("./fixtures/stdio-host.ts", import.meta.url));

function host(t: TestContext, delay = 0, text = "stdio-event-proof") {
  const child = spawn(process.execPath, [fixture, "--delay-ms", String(delay), "--text", text], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  }) as ChildProcessWithoutNullStreams;
  const waiting = new Map<Wire["id"], Array<(response: Wire) => void>>();
  const received = new Map<Wire["id"], Wire[]>();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    stdout += text;
    let newline: number;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const response = JSON.parse(stdout.slice(0, newline)) as Wire;
      stdout = stdout.slice(newline + 1);
      const waiter = waiting.get(response.id)?.shift();
      if (waiter) waiter(response);
      else received.set(response.id, [...received.get(response.id) ?? [], response]);
    }
  });
  child.stderr.on("data", (text: string) => { stderr += text; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const wait = (id: Wire["id"], timeout = 4_000): Promise<Wire> => {
    const queued = received.get(id)?.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const done = (response: Wire) => { clearTimeout(timer); resolve(response); };
      const timer = setTimeout(() => {
        waiting.set(id, (waiting.get(id) ?? []).filter((w) => w !== done));
        reject(new Error(`No stdio response for ${id}. ${stderr}`));
      }, timeout);
      waiting.set(id, [...waiting.get(id) ?? [], done]);
    });
  };
  const send = (id: string | number, method: string, input: object = {}) => { child.stdin.write(JSON.stringify({ id, method, input }) + "\n"); };
  const call = async (id: string | number, method: string, input: object = {}) => { send(id, method, input); return wait(id); };
  const finish = async () => {
    const result = await Promise.race([exited, sleep(2_000).then(() => { throw new Error(`Fixture did not exit after close/cancellation. ${stderr}`); })]);
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null, stderr);
    assert.equal(stdout, "");
    assert.doesNotMatch(stderr, /fixture-do-not-leak/);
    return JSON.parse(stderr.trim().split("\n").at(-1)!);
  };
  const close = () => { child.stdin.end(); return finish(); };
  const cancelHost = async () => {
    await new Promise<void>((resolve, reject) => {
      child.send({ type: "fixture-abort-host" }, (error) => error ? reject(error) : resolve());
    });
    return finish();
  };
  const terminate = () => { child.kill("SIGTERM"); return finish(); };
  return { child, send, call, wait, close, cancelHost, terminate };
}

describe("oaidot socket-free stdio host", () => {
  it("exits a one-shot subprocess immediately after a delayed offer without stdin or ACK", async (t) => {
    const started = Date.now();
    const child = spawn(process.execPath, [fixture, "--once", "--delay-ms", "150", "--text", "one-shot-proof"], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => { stdout += text; });
    child.stderr.on("data", (text: string) => { stderr += text; });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exit.code, 0, stderr);
    assert.equal(exit.signal, null);
    assert.ok(Date.now() - started >= 150);
    assert.equal(stdout.trim().split("\n").length, 1);
    const offer = JSON.parse(stdout);
    assert.equal(offer.type, "delivery-offer");
    assert.match(offer.text, /one-shot-proof/);
    const ended = JSON.parse(stderr.trim());
    assert.equal(ended.receives, 1);
    assert.equal(ended.acknowledgements, 0);
    assert.equal(ended.replies, 0);
    assert.equal(ended.subscriptions, 1);
    assert.equal(ended.unsubscribes, 1);
  });

  it("wakes a real subprocess, never auto-ACKs, and only applies explicit fenced ACK/reply", async (t) => {
    const h = host(t, 250, "self-authored-proof-nonce");
    h.send("offer", "listen");
    const idle = await h.call("idle", "list");
    // The scoped fiber may not have begun the asynchronous source callback
    // before this independent list finishes. The offer and final stats prove
    // there is exactly one subscription, without assuming scheduler timing.
    assert.ok(idle.result.fixture.subscriptions <= 1);
    assert.equal(idle.result.fixture.receives, 0);
    assert.equal(idle.result.fixture.state, "empty");
    const event = (await h.wait("offer")).result;
    assert.equal(event.type, "delivery-offer");
    assert.equal(event.locator, "fixture-parent");
    assert.equal(event.requiresAcknowledgement, true);
    assert.match(event.text, /self-authored-proof-nonce/);
    let stats = (await h.call("offered", "list")).result.fixture;
    assert.equal(stats.state, "claimed");
    assert.equal(stats.acknowledgements, 0);
    assert.equal(stats.replies, 0);
    assert.equal(stats.presence, 0);
    const ack = { deliveryId: event.deliveryId, claimId: event.claimId };
    assert.equal((await h.call("stale", "ack", { ...ack, claimId: "stale_claim" })).error?.code, "conflict");
    assert.equal((await h.call("ack", "ack", ack)).result.delivery.state, "delivered");
    assert.equal((await h.call("ack-again", "ack", ack)).result.delivery.state, "delivered");
    const recovered = (await h.call("recover", "recover")).result;
    assert.equal(recovered.requests[0].deliveryId, event.deliveryId);
    assert.match(recovered.requests[0].text, /An explicit answer is expected/);
    assert.equal(recovered.deliveries, undefined);
    const reply = { messageId: event.messageId, text: "Explicit parent response", key: "parent_reply_1" };
    const answered = await h.call("reply", "reply", reply);
    assert.equal(answered.result.completed, event.deliveryId);
    assert.deepEqual((await h.call("reply-again", "reply", reply)).result, answered.result);
    assert.equal((await h.call("key-conflict", "reply", { ...reply, text: "Changed" })).error?.code, "conflict");
    assert.deepEqual((await h.call("recovered", "recover")).result.requests, []);
    stats = (await h.call("settled", "list")).result.fixture;
    assert.equal(stats.acknowledgements, 1);
    assert.equal(stats.replies, 1);
    assert.equal(stats.subscriptions, 1);
    const ended = await h.close();
    assert.equal(ended.unsubscribes, 1);
    assert.equal(ended.presence, 0);
  });

  it("reoffers the same delivery after expiry and rejects the stale receipt", async (t) => {
    const h = host(t, 30);
    const first = (await h.call("first", "listen", { leaseMs: 1_000 })).result;
    const second = (await h.call("second", "listen", { leaseMs: 1_000 })).result;
    assert.equal(second.deliveryId, first.deliveryId);
    assert.notEqual(second.claimId, first.claimId);
    assert.equal((await h.call("old", "ack", { deliveryId: first.deliveryId, claimId: first.claimId })).error?.code, "conflict");
    assert.equal((await h.call("current", "ack", { deliveryId: second.deliveryId, claimId: second.claimId })).result.delivery.state, "delivered");
    const ended = await h.close();
    assert.equal(ended.receives, 2);
    assert.equal(ended.acknowledgements, 1);
  });

  it("multiplexes blocked listeners, bounds their count, cancels, and exits cleanly on EOF", async (t) => {
    const h = host(t);
    for (let i = 0; i < 4; i++) h.send(`listen${i}`, "listen");
    assert.equal((await h.call("too-many", "listen")).error?.code, "busy");
    const stats = (await h.call("independent", "list")).result.fixture;
    assert.equal(stats.receives, 0);
    assert.equal(stats.subscriptions, 1);
    h.send("listen0", "list");
    assert.equal((await h.wait("listen0")).error?.code, "conflict");
    assert.equal((await h.call("cancel", "cancel", { id: "listen0" })).result.cancelled, true);
    assert.equal((await h.wait("listen0")).error?.code, "cancelled");
    assert.equal((await h.call("cancel-missing", "cancel", { id: "missing" })).result.cancelled, false);
    const ended = await h.close();
    assert.equal(ended.unsubscribes, 1);
    assert.equal(ended.receives, 0);
  });

  it("bounds JSON input, rejects spoofed identities and unsafe methods, and sanitizes errors", async (t) => {
    const h = host(t);
    h.child.stdin.write("{" + "x".repeat(MAX_STDIO_LINE_BYTES) + "\n");
    assert.equal((await h.wait(null)).error?.code, "bad_request");
    h.child.stdin.write("not-json\n");
    assert.equal((await h.wait(null)).error?.code, "bad_request");
    assert.equal((await h.call("unsafe", "collect", {})).error?.code, "unsupported");
    assert.equal((await h.call("spoof", "ack", { as: "reed", deliveryId: "d_1", claimId: "x" })).error?.code, "bad_request");
    assert.equal((await h.call("spoof-locator", "listen", { locator: "other-parent" })).error?.code, "bad_request");
    assert.equal((await h.call("unkeyed", "send", { to: ["reed"], text: "Test" })).error?.code, "bad_request");
    const failure = await h.call("failure", "read", { conversationId: "explode" });
    assert.equal(failure.error?.code, "unavailable");
    assert.doesNotMatch(JSON.stringify(failure), /fixture-do-not-leak/);
    const send = { to: ["reed"], text: "Explicit send", key: "parent_send_1" };
    const sent = await h.call("send", "send", send);
    assert.equal(sent.result.message.text, send.text);
    assert.deepEqual((await h.call("send-again", "send", send)).result, sent.result);
    h.child.stdin.write(JSON.stringify({ id: "partial", method: "send", input: { ...send, key: "parent_partial" } }));
    const ended = await h.close();
    assert.equal(ended.sends, 1);
    assert.equal(ended.acknowledgements, 0);
  });

  it("closes a real subprocess on host cancellation while stdin remains open", async (t) => {
    const h = host(t, 60_000);
    h.send("waiting", "listen");
    await h.call("ready", "list");
    assert.equal(h.child.stdin.writableEnded, false);
    // Windows subprocess.kill("SIGTERM") forcibly terminates the child and
    // cannot exercise graceful AbortSignal cleanup. IPC triggers that same
    // host cancellation path portably, while preserving all exit assertions.
    const ended = await h.cancelHost();
    assert.equal(ended.subscriptions, 1);
    assert.equal(ended.receives, 0);
    assert.equal(ended.acknowledgements, 0);
    assert.equal(ended.unsubscribes, ended.subscriptions);
  });

  it("handles POSIX SIGTERM with graceful host cleanup", { skip: process.platform === "win32" }, async (t) => {
    const h = host(t, 60_000);
    h.send("waiting", "listen");
    await h.call("ready", "list");
    const ended = await h.terminate();
    assert.equal(ended.acknowledgements, 0);
    assert.equal(ended.unsubscribes, ended.subscriptions);
  });

  it("keeps stalled output bounded instead of accumulating request promises", async () => {
    const input = new PassThrough();
    let calls = 0;
    const transport = (async () => { calls++; return { ok: true, conversations: [] }; }) as Transport;
    const client = new OaidotClient({ participant: "cedar", locator: "fixture-parent", socketPath: "/unused", transport });
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const lines: Wire[] = [];
    let writes = 0;
    const running = serveStdio(client, { input, maxInFlight: 2, write: async (line) => {
      writes++;
      if (writes === 1) await stalled;
      lines.push(JSON.parse(line));
    } });
    for (let id = 0; id < 100; id++) input.write(JSON.stringify({ id, method: "list" }) + "\n");
    await sleep(30);
    assert.equal(calls, 2);
    assert.equal(writes, 1);
    release();
    await sleep(30);
    input.end();
    await running;
    assert.ok(lines.some((line) => line.error?.code === "busy"));
    assert.ok(calls <= 100);
  });

  it("cancels a stalled output and blocked input when the host closes", async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const transport = (async () => ({ ok: true, conversations: [] })) as Transport;
    const client = new OaidotClient({ participant: "cedar", locator: "fixture-parent", socketPath: "/unused", transport });
    let closed = 0;
    let wrote: () => void = () => {};
    const writing = new Promise<void>((resolve) => { wrote = resolve; });
    const running = serveStdio(client, {
      input, signal: controller.signal,
      write: () => { wrote(); return new Promise(() => {}); },
      close: async () => { closed++; },
    });
    input.write(JSON.stringify({ id: "stalled", method: "list" }) + "\n");
    await writing;
    controller.abort();
    await running;
    assert.equal(closed, 1);
    input.destroy();
  });
});
