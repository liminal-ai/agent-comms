import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { call } from "@agent-comms/comms-cli/client";
import { type Delivery, renderDelivery } from "@agent-comms/protocol";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api.js";
import type { HarnessAdapter } from "../src/adapter.ts";
import { claudeCloudHarnessAdapter, type ClaudeCloudOptions } from "../src/claude-cloud.ts";
import { harnessAdapters } from "../src/start.ts";
import { ADMIN, machine, type Running, sleep, startConnector, until, world } from "./harness.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Other connector dependencies may spawn the native Windows pipe helper.
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const target = { participant: "tee", locator: "https://claude.ai/code/session_test" };
const sender = { id: "p_a", name: "a", kind: "agent" as const };
const recipient = { id: "p_tee", name: "tee", kind: "agent" as const };
const delivery: Delivery = {
  id: "d_1", recipient, conversation: { id: "c_1", kind: "dm" },
  message: {
    id: "m_1", conversationId: "c_1", seq: 1, sender, recipients: [recipient],
    kind: "request", text: 'q "quoted" $(no-shell)\nsecond line', attachments: [], createdAt: 1, origin: { via: "cli" },
  },
  history: { messages: [], omitted: 0 }, status: { state: "claimed", at: 1 },
};
const receipt = { code: 0, stdout: '{"ok":true,"session_id":"session_test"}', stderr: "" };
const fakeAdapter = (run: NonNullable<ClaudeCloudOptions["run"]>) => claudeCloudHarnessAdapter({ bin: process.execPath, run });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.mocked(spawn).mockReset();
});

describe("claude-cloud adapter", () => {
  it("confirms immediately before sending exact CLI args with the shared header and explicit reply instructions", async () => {
    const order: string[] = [];
    const run = vi.fn(async () => { order.push("spawn"); return receipt; });
    const confirm = vi.fn(async () => { order.push("confirm"); return true; });
    const adapter = fakeAdapter(run);
    const result = await Effect.runPromise(adapter.handOff(target, delivery, { confirm }));
    expect(order).toEqual(["confirm", "spawn"]);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(undefined);
    const [args, signal, stdin] = run.mock.calls[0]! as unknown as [string[], AbortSignal, string];
    expect(args).toEqual(["-p", "--cloud", target.locator, "--output-format", "json"]);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(stdin).toContain("[agent-comms v1] delivery=d_1 message=m_1 kind=request");
    expect(stdin).toContain('comms reply --as tee m_1 "<your answer>"');
    expect(stdin).toContain("Nothing you write in this cloud session is sent or collected automatically.");
    expect(stdin).not.toContain("Reply normally");
    // Only the answer framing differs from T3's rendering.
    expect(stdin).toBe(renderDelivery(delivery, { harnessLabelsSource: false, answerInstructions: () => [stdin.split("\n").find((line) => line.startsWith("An answer is expected."))!] }));
    expect(result).toMatchObject({ _tag: "accepted", turnId: expect.stringMatching(/^cloud-d_1-\d+$/), steered: true });
    expect(adapter.steersIntoRunningTurn).toBe(false);
    expect(await Effect.runPromise(adapter.awaitOutcome(target, delivery, "cloud-turn"))).toEqual({ _tag: "ambiguous", entered: [{ origin: "claude-cloud" }] });
    expect(await Effect.runPromise(adapter.check(target, delivery, undefined))).toEqual({ _tag: "unknown", detail: "claude-cloud: no way to ask the session" });
  });

  it("the spawn transport pipes a long, shell-sensitive prompt on stdin and never enables a shell", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    const body = '" & whoami | echo %COMSPEC% $(no-shell)\n' + "x".repeat(35_000);
    const adapter = claudeCloudHarnessAdapter({ bin: process.execPath });
    const handing = Effect.runPromise(adapter.handOff(target, { ...delivery, message: { ...delivery.message, text: body } }, { confirm: async () => true }));
    await until("fake subprocess spawned", async () => vi.mocked(spawn).mock.calls.length === 1);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, ["-p", "--cloud", target.locator, "--output-format", "json"], {
      stdio: ["pipe", "pipe", "pipe"], shell: false, signal: expect.any(AbortSignal), timeout: 120_000, killSignal: "SIGKILL",
    });
    const prompt = Buffer.concat(chunks).toString();
    expect(prompt.length).toBeGreaterThan(32_767);
    expect(prompt.includes(body.replaceAll("\n", "\n> "))).toBe(true);
    expect(stdin.writableEnded).toBe(true);
    child.emit("spawn");
    stdout.end(receipt.stdout);
    child.emit("close", 0);
    expect((await handing)._tag).toBe("accepted");
  });

  it.each([
    { code: "ENOENT", spawned: false, tag: "rejected" },
    { code: "EACCES", spawned: false, tag: "rejected" },
    { code: "ENOENT", spawned: true, tag: "lost" },
    { code: "EACCES", spawned: true, tag: "lost" },
  ])("$code is $tag when spawned=$spawned", async ({ code, spawned, tag }) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const handing = Effect.runPromise(claudeCloudHarnessAdapter({ bin: process.execPath }).handOff(target, delivery, { confirm: async () => true }));
    await until("fake subprocess attempted", async () => vi.mocked(spawn).mock.calls.length === 1);
    if (spawned) child.emit("spawn");
    child.emit("error", Object.assign(new Error("fake subprocess failure"), { code }));
    expect((await handing)._tag).toBe(tag);
  });

  it("truncated stdout capture stays lost even when the remaining tail looks like an explicit refusal", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const handing = Effect.runPromise(claudeCloudHarnessAdapter({ bin: process.execPath }).handOff(target, delivery, { confirm: async () => true }));
    await until("fake subprocess attempted", async () => vi.mocked(spawn).mock.calls.length === 1);
    child.emit("spawn");
    child.stdout.write("not JSON" + " ".repeat(1_000_000));
    child.stdout.end('{"ok":false}');
    child.emit("close", 0);
    expect((await handing)._tag).toBe("lost");
  });

  it.each(["session_ABC123", "https://claude.ai/code/session_ABC123?from=cli&m=0"])("accepts valid cloud locator %s", async (locator) => {
    const run = vi.fn(async () => receipt);
    expect((await Effect.runPromise(fakeAdapter(run).handOff({ ...target, locator }, delivery, { confirm: async () => true })))._tag).toBe("accepted");
    expect(run).toHaveBeenCalledWith(["-p", "--cloud", locator, "--output-format", "json"], expect.any(AbortSignal), expect.any(String));
  });

  it.each(["", "session_abc_def", "session_abc\n", "--option", "https://evil.test/code/session_abc", "https://claude.ai/code/session_abc/extra"])("rejects invalid locator %s before confirming or spawning", async (locator) => {
    const run = vi.fn(async () => receipt);
    const confirm = vi.fn(async () => true);
    const result = await Effect.runPromise(fakeAdapter(run).handOff({ ...target, locator }, delivery, { confirm }));
    expect(result).toMatchObject({ _tag: "rejected", detail: expect.stringContaining("locator must be") });
    expect(confirm).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("presence rechecks binary availability: offline, then idle, then offline after removal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-cloud-presence-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "fake-claude");
    const adapter = claudeCloudHarnessAdapter({ bin, run: async () => receipt });
    expect(await Effect.runPromise(adapter.presence!(target))).toBe("offline");
    await writeFile(bin, "fake CLI, never executed", { mode: 0o700 });
    expect(await Effect.runPromise(adapter.ready(target))).toBe(true);
    expect(await Effect.runPromise(adapter.presence!(target))).toBe("idle");
    await rm(bin);
    expect(await Effect.runPromise(adapter.presence!(target))).toBe("offline");
    expect(await Effect.runPromise(adapter.ready(target))).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("Windows batch shims are unavailable and refused before spawning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-cloud-shim-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "fake-claude.cmd");
    await writeFile(bin, "fake shim, never executed");
    const run = vi.fn(async () => receipt);
    const adapter = claudeCloudHarnessAdapter({ bin, run });
    expect(await Effect.runPromise(adapter.ready(target))).toBe(false);
    expect(await Effect.runPromise(adapter.presence!(target))).toBe("offline");
    expect(await Effect.runPromise(adapter.handOff(target, delivery, { confirm: async () => true }))).toMatchObject({ _tag: "rejected", detail: expect.stringContaining("native executable") });
    expect(run).not.toHaveBeenCalled();
  });

  it("a false gate confirmation spawns nothing", async () => {
    const run = vi.fn(async () => receipt);
    const result = await Effect.runPromise(fakeAdapter(run).handOff(target, delivery, { confirm: async () => false }));
    expect(result._tag).toBe("aborted");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["before", "during-confirm"])("cancellation %s sending spawns nothing", async (when) => {
    const controller = new AbortController();
    if (when === "before") controller.abort();
    const run = vi.fn(async () => receipt);
    const confirm = async () => { controller.abort(); return true; };
    const result = await Effect.runPromise(fakeAdapter(run).handOff(target, delivery, { confirm, signal: controller.signal }));
    expect(result._tag).toBe("aborted");
    expect(run).not.toHaveBeenCalled();
  });

  it("cancellation after spawn is lost, even if stdout reports success", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (_args: string[], signal: AbortSignal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      return receipt;
    });
    const result = await Effect.runPromise(fakeAdapter(run).handOff(target, delivery, { confirm: async () => true, signal: controller.signal }));
    expect(result._tag).toBe("lost");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: null, stdout: "", stderr: "CLI timed out or was signalled" },
    new DOMException("timeout", "TimeoutError"),
  ])("a timeout or signal after spawn is lost", async (result) => {
    const run = async () => { if (result instanceof Error) throw result; return result; };
    expect((await Effect.runPromise(fakeAdapter(run).handOff(target, delivery, { confirm: async () => true })))._tag).toBe("lost");
  });

  it("caches binary lookup, invalidates it on failure, and discovers a binary that appears later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-cloud-bin-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "fake-claude");
    const adapter = claudeCloudHarnessAdapter({ bin, run: async () => { throw Object.assign(new Error("missing binary"), { code: "ENOENT" }); } });
    expect(await Effect.runPromise(adapter.ready(target))).toBe(false);
    await writeFile(bin, "fake CLI, never executed", { mode: 0o700 });
    expect(await Effect.runPromise(adapter.ready(target))).toBe(true);
    await rm(bin);
    expect(await Effect.runPromise(adapter.ready(target))).toBe(true);
    expect((await Effect.runPromise(adapter.handOff(target, delivery, { confirm: async () => true })))._tag).toBe("rejected");
    expect(await Effect.runPromise(adapter.ready(target))).toBe(false);
    await writeFile(bin, "fake CLI, never executed", { mode: 0o700 });
    expect(await Effect.runPromise(adapter.ready(target))).toBe(true);
  });

  it("loads only when configured and respects the optional binary", async () => {
    const base = { machine: "test", socket: "unused" };
    expect(await harnessAdapters(base, () => {})).toEqual([]);
    const [adapter] = await harnessAdapters({ ...base, adapters: ["claude-cloud"], claudeCloud: { bin: process.execPath } }, () => {});
    expect(adapter?.harness).toBe("claude-cloud");
    expect(await Effect.runPromise(adapter!.ready(target))).toBe(true);
  });
});

async function cloudWorld() {
  const w = await world();
  await w.t.mutation(api.directory.rebind, { adminToken: ADMIN, name: "tee", home: { machine: machine.id, harness: "claude-cloud", locator: target.locator } });
  return w;
}

async function send(w: Awaited<ReturnType<typeof world>>, text: string) {
  const sent = await call(w.socket, "send", { as: "a", to: ["tee"], text });
  if (!sent.ok) throw new Error(sent.error.message);
  const row = async () => {
    const view = await w.t.query(api.conversations.view, { adminToken: ADMIN, conversationId: sent.message.conversationId });
    return view.messages.find((m) => m.message.id === sent.message.id)?.deliveries[0];
  };
  return { sent, row };
}

function track(running: Running) { cleanups.push(() => running.stop()); }

describe("claude-cloud dispatch", () => {
  it("receipt-only requests become ambiguous, release the next delivery, and settle with comms reply", async () => {
    const w = await cloudWorld();
    const run = vi.fn(async () => receipt);
    track(await startConnector(w.api, w.socket, 1_500, [fakeAdapter(run)]));
    const first = await send(w, "first");
    const row = await until("ambiguous", async () => { const d = await first.row(); return d?.state === "ambiguous" && d; });
    expect(row.detail).toContain("claude-cloud");
    const second = await send(w, "second");
    await until("second ambiguous without first reply", async () => (await second.row())?.state === "ambiguous");
    expect(run).toHaveBeenCalledTimes(2);
    const reply = await call(w.socket, "reply", { as: "tee", messageId: first.sent.message.id, text: "done" });
    expect(reply.ok).toBe(true);
    await until("replied", async () => (await first.row())?.state === "replied");
    const read = await call(w.socket, "read", { as: "a", conversationId: first.sent.message.conversationId });
    expect(read.ok && read.messages.some((m) => m.inReplyTo === first.sent.message.id && m.text === "done")).toBe(true);
  });

  it.each([
    { code: 0, stdout: '{"ok":false}', stderr: "refused" },
    { code: 1, stdout: '{"ok":false}', stderr: "refused with non-zero exit" },
  ])("an explicit refusal fails without retrying: $stderr", async (result) => {
    const w = await cloudWorld();
    const run = vi.fn(async () => ({ ...result, stderr: "x".repeat(3_000) + result.stderr }));
    track(await startConnector(w.api, w.socket, 1_500, [fakeAdapter(run)]));
    const request = await send(w, "q");
    const row = await until("failed", async () => { const d = await request.row(); return d?.state === "failed" && d; });
    expect(row.detail).toHaveLength("rejected: ".length + 2_000);
    expect(row.detail).toMatch(new RegExp(`${result.stderr}$`));
    await sleep(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 1, stdout: "", stderr: "transport failed after posting" },
    { code: 1, stdout: '{"ok":true}', stderr: "CLI failed after receipt" },
    { code: 0, stdout: "not JSON", stderr: "bad receipt" },
    { code: 0, stdout: '{"ok":true', stderr: "truncated receipt" },
    { code: 0, stdout: "null", stderr: "missing receipt" },
  ])("an indeterminate post-spawn result becomes uncertain without resending and can be replied to: $stderr", async (result) => {
    const w = await cloudWorld();
    const run = vi.fn(async () => result);
    const base = fakeAdapter(run);
    let handed: string | undefined;
    const adapter: HarnessAdapter = {
      ...base,
      handOff: (target, delivery, gate) => base.handOff(target, delivery, gate).pipe(Effect.tap((result) => Effect.sync(() => { handed = result._tag; }))),
    };
    track(await startConnector(w.api, w.socket, 1_500, [adapter]));
    const request = await send(w, "q");
    await until("uncertain", async () => (await request.row())?.state === "uncertain");
    expect(handed).toBe("lost");
    await sleep(200);
    expect(run).toHaveBeenCalledTimes(1);
    const reply = await call(w.socket, "reply", { as: "tee", messageId: request.sent.message.id, text: "answer after transport failure" });
    expect(reply.ok).toBe(true);
    await until("replied after uncertainty", async () => (await request.row())?.state === "replied");
  });

  it("connector polling reports an available cloud participant as idle in the registry", async () => {
    const w = await cloudWorld();
    const run = vi.fn(async () => receipt);
    track(await startConnector(w.api, w.socket, 1_500, [fakeAdapter(run)]));
    await until("cloud presence idle", async () => {
      const registry = await w.t.query(api.registry.list, { adminToken: ADMIN });
      return registry.agents.find((entry) => entry.participant.name === "tee")?.presence?.status === "idle";
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("a lost handoff becomes uncertain and is not resent on recovery or connector restart", async () => {
    const w = await cloudWorld();
    const run = vi.fn(async () => ({ code: null, stdout: "", stderr: "timeout after spawn" }));
    const adapter = fakeAdapter(run);
    const first = await startConnector(w.api, w.socket, 1_500, [adapter]);
    track(first);
    const request = await send(w, "q");
    await until("uncertain", async () => (await request.row())?.state === "uncertain");
    expect((await request.row())?.detail).toBe("claude-cloud: no way to ask the session");
    expect(run).toHaveBeenCalledTimes(1);
    await first.stop();
    track(await startConnector(w.api, w.socket, 1_500, [adapter]));
    const next = await send(w, "next");
    await until("next uncertain", async () => (await next.row())?.state === "uncertain");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["claimed", "delivered"] as const)("a restart with an expired %s delivery records uncertain without resending", async (state) => {
    const w = await cloudWorld();
    // Queue it with no cloud adapter, then simulate a connector that crashed
    // after preparing the send (and, for delivered, after recording receipt).
    const initial = await startConnector(w.api, w.socket);
    track(initial);
    const request = await send(w, "before crash");
    await initial.stop();
    const id = request.sent.deliveries[0]!.id;
    const claimed = await Effect.runPromise(w.api.claim(id, 1_500));
    await Effect.runPromise(w.api.prepare(id, claimed.claim.claimId, undefined));
    if (state === "delivered") await Effect.runPromise(w.api.delivered(id, claimed.claim.claimId, "cloud-before-crash"));
    await w.t.run(async (ctx) => {
      const deliveryId = ctx.db.normalizeId("deliveries", id)!;
      const row = (await ctx.db.get(deliveryId))!;
      await ctx.db.patch(deliveryId, { claim: { ...row.claim!, leaseExpiresAt: Date.now() - 1 } });
    });
    const run = vi.fn(async () => receipt);
    track(await startConnector(w.api, w.socket, 1_500, [fakeAdapter(run)]));
    await until("recovered uncertain", async () => (await request.row())?.state === "uncertain");
    expect(run).not.toHaveBeenCalled();
    const next = await send(w, "after restart");
    await until("next handed over", async () => (await next.row())?.state === "ambiguous");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
