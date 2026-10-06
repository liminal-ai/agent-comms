// The local service end to end in process: the real SQLite store, functions,
// crons, connector socket and web API. Restart durability, the startup
// refusals, and the web API's protections.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call as rawCall } from "@agent-comms/comms-cli/client";
import type { Op, Requests, Responses } from "@agent-comms/protocol";
import { loadConfig } from "@agent-comms/connector/config";
import { afterEach, describe, expect, it } from "vitest";
import { windowsEndpoint } from "../../windows-pipe/src/index.mjs";
import { type LocalConfig, loadServiceConfig } from "../src/config.ts";
import { ADMIN_TOKEN_FILE, credential } from "../src/data.ts";
import { type RunningLocal, startLocal } from "../src/local.ts";

const quiet = () => {};
// The CLI client's answer, as the success body (a refusal throws in these tests).
const call = async <K extends Op & keyof Responses>(socket: string, op: K, body: Requests[K]) => (await rawCall(socket, op, body)) as unknown as Responses[K];
const running: RunningLocal[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

function fixture(): LocalConfig {
  const dir = mkdtempSync(join(tmpdir(), "comms-service-"));
  chmodSync(dir, 0o700);
  const socket = process.platform === "win32" ? windowsEndpoint(`service-test-${Date.now()}-${Math.random()}`) : join(dir, "run", "connector.sock");
  return { mode: "local", environment: "test", dataDir: join(dir, "data"), owner: "lee", machine: "box", socket, web: { port: 0 } };
}

async function start(config: LocalConfig) {
  const r = await startLocal(config, { log: quiet });
  running.push(r);
  return r;
}

async function stop(r: RunningLocal) {
  running.splice(running.indexOf(r), 1);
  await r.stop();
}

function api(r: RunningLocal, config: LocalConfig, path: string, body: unknown, headers: Record<string, string> = {}) {
  const token = credential(config.dataDir, ADMIN_TOKEN_FILE);
  return fetch(`http://127.0.0.1:${r.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function register(r: RunningLocal, config: LocalConfig, name: string) {
  const adminToken = credential(config.dataDir, ADMIN_TOKEN_FILE);
  const res = await api(r, config, "/api/call", {
    kind: "mutation",
    name: "directory:promote",
    args: { adminToken, name, kind: "agent", owner: "lee", home: { machine: config.machine, harness: "claude-code", locator: name } },
  });
  expect(res.status).toBe(200);
}

describe("a local service", () => {
  it("delivers through its own connector, and pending work survives a restart", async () => {
    const config = fixture();
    let r = await start(config);
    await register(r, config, "alpha");
    await register(r, config, "beta");
    const status = await call(config.socket, "status", {});
    expect(JSON.stringify(status.participants)).toMatch(/alpha.*beta|beta.*alpha/);
    const sent = await call(config.socket, "send", { as: "alpha", to: ["beta"], text: "survive a restart" });
    await stop(r);

    r = await start(config);
    const pending = await r.backend.run(async (ctx: any) => (await ctx.db.query("deliveries").collect()).map((d: { state: string }) => d.state));
    expect(pending).toEqual(["pending"]);
    const read = await call(config.socket, "read", { as: "alpha", conversationId: sent.message.conversationId });
    expect(JSON.stringify(read)).toContain("survive a restart");
  });

  it("refuses a second service on the same store, leaving the first one's socket alone", async () => {
    const config = fixture();
    const r = await start(config);
    const other = { ...config, socket: process.platform === "win32" ? windowsEndpoint(`other-${Date.now()}`) : `${config.socket}.2`, web: { port: 0 } };
    await expect(startLocal(other, { log: quiet })).rejects.toThrow(/in use by another comms service/);
    expect((await call(config.socket, "status", {})).machine).toBe("box");
    expect(r.port).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("refuses a socket another process is serving, and doesn't unlink it", async () => {
    const config = fixture();
    mkdirSync(join(config.socket, ".."), { recursive: true, mode: 0o700 });
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(config.socket, resolve));
    try {
      await expect(startLocal(config, { log: quiet })).rejects.toThrow(/already listening/);
      expect(existsSync(config.socket)).toBe(true);
    } finally {
      squatter.close();
    }
  });

  it.skipIf(process.platform === "win32")("refuses unsafe data: an open directory, stray or missing credentials", async () => {
    const open = fixture();
    mkdirSync(open.dataDir, { mode: 0o755 });
    chmodSync(open.dataDir, 0o755);
    await expect(startLocal(open, { log: quiet })).rejects.toThrow(/must be owner-only/);

    const stray = fixture();
    mkdirSync(stray.dataDir, { mode: 0o700 });
    writeFileSync(join(stray.dataDir, ADMIN_TOKEN_FILE), "x".repeat(40), { mode: 0o600 });
    await expect(startLocal(stray, { log: quiet })).rejects.toThrow(/refusing to adopt a credential/);
    expect(existsSync(join(stray.dataDir, "comms.sqlite"))).toBe(false);

    const missing = fixture();
    await stop(await start(missing));
    const { rmSync } = await import("node:fs");
    rmSync(join(missing.dataDir, ADMIN_TOKEN_FILE));
    await expect(startLocal(missing, { log: quiet })).rejects.toThrow(/is missing/);
    expect(existsSync(join(missing.dataDir, "comms.sqlite"))).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("first start, interrupted", () => {
  it("before the store committed: leftovers are replaced, an empty database file is initialized", async () => {
    const config = fixture();
    mkdirSync(config.dataDir, { mode: 0o700 });
    writeFileSync(join(config.dataDir, ".admin.token.init"), "x".repeat(40), { mode: 0o600 });
    writeFileSync(join(config.dataDir, "comms.sqlite"), "");
    const r = await start(config);
    const token = credential(config.dataDir, ADMIN_TOKEN_FILE);
    expect(token).not.toBe("x".repeat(40));
    expect(existsSync(join(config.dataDir, ".admin.token.init"))).toBe(false);
    expect((await api(r, config, "/api/call", { kind: "query", name: "directory:list", args: { adminToken: token } })).status).toBe(200);
  });

  it("after the store committed: the credentials it recorded are finished, anything else is refused", async () => {
    const config = fixture();
    await stop(await start(config));
    const { renameSync, readFileSync } = await import("node:fs");
    const token = readFileSync(join(config.dataDir, ADMIN_TOKEN_FILE), "utf8");
    renameSync(join(config.dataDir, ADMIN_TOKEN_FILE), join(config.dataDir, ".admin.token.init"));
    await stop(await start(config));
    expect(readFileSync(join(config.dataDir, ADMIN_TOKEN_FILE), "utf8")).toBe(token);

    writeFileSync(join(config.dataDir, ADMIN_TOKEN_FILE), "y".repeat(43) + "\n", { mode: 0o600 });
    await expect(startLocal(config, { log: quiet })).rejects.toThrow(/doesn't belong to this store/);
  });
});

describe("the web API", () => {
  it("serves only the web modules' public functions, to its own origin, with the token", async () => {
    const config = fixture();
    const r = await start(config);
    const adminToken = credential(config.dataDir, ADMIN_TOKEN_FILE);
    const list = { kind: "query", name: "directory:list", args: { adminToken } };
    expect((await api(r, config, "/api/call", list)).status).toBe(200);
    expect((await api(r, config, "/api/call", list, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await api(r, config, "/api/call", list, { authorization: "" })).status).toBe(401);
    expect((await api(r, config, "/api/call", list, { origin: "http://evil.example" })).status).toBe(403);
    expect((await api(r, config, "/api/call", list, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await api(r, config, "/api/call", list, { "content-type": "text/plain" })).status).toBe(415);
    expect((await api(r, config, "/api/call", { kind: "query", name: "connector:homed", args: {} })).status).toBe(404);
    expect((await api(r, config, "/api/call", { kind: "mutation", name: "waits:sweep", args: {} })).status).toBe(404);
    expect((await api(r, config, "/api/call", { kind: "mutation", name: "directory:list", args: { adminToken } })).status).toBe(400);
    expect((await api(r, config, "/api/call", "x".repeat(300 * 1024))).status).toBe(413);
    // fetch can't set Host; a raw request can, as a DNS-rebinding page's would arrive.
    const { request } = await import("node:http");
    const wrongHost = await new Promise<number>((resolve, reject) =>
      request({ host: "127.0.0.1", port: r.port, path: "/runtime-config.json", headers: { host: `attacker.example:${r.port}` } }, (res) => resolve(res.statusCode!)).on("error", reject).end(),
    );
    expect(wrongHost).toBe(403);
    const config2 = await (await fetch(`http://127.0.0.1:${r.port}/runtime-config.json`)).json();
    expect(config2).toEqual({ environment: "test", mode: "local" });
    expect(JSON.stringify(config2)).not.toContain(adminToken);
    const refused = await api(r, config, "/api/call", { kind: "query", name: "directory:list", args: { adminToken: "nope" } });
    expect(await refused.json()).toEqual({ error: { message: "admin token rejected" } });
  });

  it("streams a live query, updates it on change, and stops watching when the client goes", async () => {
    const config = fixture();
    const r = await start(config);
    const adminToken = credential(config.dataDir, ADMIN_TOKEN_FILE);
    const abort = new AbortController();
    // The connector's own work subscription starts asynchronously; count from after it.
    for (let i = 0; i < 100 && r.backend.subscriptionCount < 1; i++) await new Promise((x) => setTimeout(x, 20));
    const before = r.backend.subscriptionCount;
    const res = await api(r, config, "/api/watch", { queries: [{ id: "dir", name: "directory:list", args: { adminToken } }] }, {});
    expect(res.status).toBe(200);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const next = async () => {
      for (;;) {
        const { value } = await reader.read();
        const line = value!.split("\n").find((l) => l.includes('"dir"'));
        if (line) return JSON.parse(line) as { id: string; value: { participants: { name: string }[] } };
      }
    };
    const first = await next();
    expect(first.value.participants.map((p) => p.name)).not.toContain("gamma");
    expect(r.backend.subscriptionCount).toBe(before + 1);
    await register(r, config, "gamma");
    const second = await next();
    expect(second.value.participants.map((p) => p.name)).toContain("gamma");
    await reader.cancel();
    abort.abort();
    for (let i = 0; i < 100 && r.backend.subscriptionCount > before; i++) await new Promise((x) => setTimeout(x, 20));
    expect(r.backend.subscriptionCount).toBe(before);
  });
});

describe("configs", () => {
  const write = (body: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "comms-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  it("need an explicit mode, and refuse the other mode's fields", () => {
    expect(() => loadServiceConfig(write({ dataDir: "/tmp/x", owner: "lee", web: { port: 1 } }))).toThrow(/"mode" must be/);
    expect(() => loadServiceConfig(write({ mode: "local", dataDir: "/tmp/x", owner: "lee", web: { port: 1 }, convexUrl: "https://x.convex.cloud" }))).toThrow(/doesn't use "convexUrl"/);
    expect(() => loadServiceConfig(write({ mode: "local", dataDir: "/tmp/x", owner: "lee", web: { port: 1 }, adapters: ["t3"], t3: { baseUrl: "ws://127.0.0.1:1", authFile: "/x" } }))).toThrow(/environmentId/);
    expect(() => loadServiceConfig(write({ mode: "convex", connector: "/c.json", dataDir: "/tmp/x" }))).toThrow(/doesn't use "dataDir"/);
  });

  it("a local config given to the Convex connector is refused", () => {
    expect(() => loadConfig(write({ mode: "local", dataDir: "/tmp/x", owner: "lee", web: { port: 1 } }))).toThrow(/run it with service\.mjs/);
  });
});
