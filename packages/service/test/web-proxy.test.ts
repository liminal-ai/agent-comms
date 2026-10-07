import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ConvexLike, convexWebBackend, WEB_FUNCTIONS } from "../src/convex-backend.ts";
import { localWebServer, WEB_MODULES } from "../src/web.ts";

const servers: ReturnType<typeof localWebServer>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function fakeClient() {
  const calls: { kind: string; name: unknown; args: Record<string, unknown> }[] = [];
  const subs: { args: Record<string, unknown>; push: (v: unknown) => void; stopped: boolean; onError?: (e: Error) => void }[] = [];
  const client: ConvexLike = {
    query: async (ref, args) => (calls.push({ kind: "query", name: ref, args }), { ok: true }),
    mutation: async (ref, args) => (calls.push({ kind: "mutation", name: ref, args }), { done: true }),
    onUpdate: (_ref, args, onValue, onError) => {
      const sub = { args, push: onValue, stopped: false, onError };
      subs.push(sub);
      queueMicrotask(() => onValue({ n: 1 }));
      return () => (sub.stopped = true);
    },
    close: async () => {},
  };
  return { client, calls, subs };
}

function tokenFile(value: string) {
  const path = join(mkdtempSync(join(tmpdir(), "comms-proxy-")), "admin-token");
  writeFileSync(path, `${value}\n`);
  return path;
}

async function listen(server: ReturnType<typeof localWebServer>) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the Convex proxy backend", () => {
  it("adds the admin token from its file to every call, replacing whatever the page sent, and re-reads it", async () => {
    const { client, calls, subs } = fakeClient();
    const file = tokenFile("secret-one");
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: file, client });
    expect(await backend.call("query", "directory:list", { adminToken: "placeholder" })).toEqual({ ok: true });
    expect(calls[0]!.args).toEqual({ adminToken: "secret-one" });
    writeFileSync(file, "secret-two");
    await backend.call("mutation", "inbox:markRead", { human: "lee", all: true });
    expect(calls[1]!.args).toEqual({ human: "lee", all: true, adminToken: "secret-two" });
    const seen: unknown[] = [];
    const stop = backend.subscribe("conversations:list", {}, (v) => seen.push(v), () => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(subs[0]!.args).toEqual({ adminToken: "secret-two" });
    expect(seen).toEqual([{ n: 1 }]);
    stop();
    expect(subs[0]!.stopped).toBe(true);
  });

  it("re-subscribes a live query with the file's current token after a rotation refuses the old one", async () => {
    const { client, subs } = fakeClient();
    const file = tokenFile("before");
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: file, client });
    const errors: string[] = [];
    backend.subscribe("conversations:list", {}, () => {}, (e) => errors.push(e.message));
    await new Promise((r) => setTimeout(r, 10));
    expect(subs[0]!.args.adminToken).toBe("before");
    writeFileSync(file, "after");
    subs[0]!.onError!(new Error("admin token rejected"));
    await new Promise((r) => setTimeout(r, 10));
    expect(subs[0]!.stopped).toBe(true);
    expect(subs[1]!.args.adminToken).toBe("after");
    expect(errors).toEqual([]);
    // Refused again with the current token: a real error, reported once, no loop.
    subs[1]!.onError!(new Error("admin token rejected"));
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual(["admin token rejected"]);
    expect(subs.length).toBe(2);
  });

  it("exposes only the web modules' public functions", async () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    expect(backend.info("connector:work")).toBeUndefined();
    expect(backend.info("reminders:tick")).toBeUndefined();
    expect(backend.info("directory:list")?.kind).toBe("query");
    await expect(backend.call("query", "connector:work", {})).rejects.toThrow(/Could not find public function/);
    await expect(backend.call("mutation", "directory:list", {})).rejects.toThrow(/Could not find public function/);
    for (const name of Object.keys(WEB_FUNCTIONS)) expect(WEB_MODULES.has(name.split(":")[0]!)).toBe(true);
  });

  it("matches the public functions of the web modules in convex/", () => {
    const expected: Record<string, string> = {};
    for (const module of WEB_MODULES) {
      const source = readFileSync(new URL(`../../../convex/${module}.ts`, import.meta.url), "utf8");
      for (const m of source.matchAll(/export const (\w+) = (query|mutation)\(/g)) expected[`${module}:${m[1]}`] = m[2]!;
    }
    expect(WEB_FUNCTIONS).toEqual(expected);
  });
});

describe("the web API in proxy mode", () => {
  it("serves the page and the API without a page token, never exposing the admin token, to any Host", async () => {
    const { client, calls } = fakeClient();
    const token = "super-secret-admin-token";
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile(token), client });
    const port = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", log: () => {} }));
    const config = await (await fetch(`http://127.0.0.1:${port}/runtime-config.json`)).json();
    expect(config).toEqual({ environment: "prod", mode: "proxy" });
    expect(JSON.stringify(config)).not.toContain(token);
    const r = await post(port, "/api/call", { kind: "query", name: "directory:list", args: { adminToken: "placeholder" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ value: { ok: true } });
    expect(calls[0]!.args.adminToken).toBe(token);
    // Behind tailscale serve the browser's Origin is https while this hop is http.
    expect((await post(port, "/api/call", { kind: "query", name: "directory:list", args: {} }, { origin: `https://127.0.0.1:${port}` })).status).toBe(200);
    expect((await post(port, "/api/call", { kind: "query", name: "directory:list", args: {} }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(port, "/api/call", { kind: "query", name: "connector:work", args: {} })).status).toBe(404);
    const viaTailnetHost = await new Promise<number>((resolve, reject) =>
      request({ host: "127.0.0.1", port, path: "/runtime-config.json", headers: { host: "lim-builder.tailb30114.ts.net:8461" } }, (res) => resolve(res.statusCode!)).on("error", reject).end(),
    );
    expect(viaTailnetHost).toBe(200);
    const watch = await post(port, "/api/watch", { queries: [{ id: "q1", name: "conversations:list", args: {} }] });
    expect(watch.status).toBe(200);
    const first = await watch.body!.getReader().read();
    expect(JSON.parse(new TextDecoder().decode(first.value).split("\n")[0]!)).toEqual({ id: "q1", value: { n: 1 } });
  });

  it("with allowedClients, serves only the single X-Forwarded-For address tailscale serve sets", async () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    const allowedClients = ["100.119.218.24", "fd7a:115c:a1e0::6c38:da19"];
    const port = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients, log: () => {} }));
    const get = (xff?: string | string[]) => {
      const headers: Record<string, string> = {};
      if (typeof xff === "string") headers["x-forwarded-for"] = xff;
      return fetch(`http://127.0.0.1:${port}/runtime-config.json`, { headers: xff === undefined ? {} : Array.isArray(xff) ? [["x-forwarded-for", xff[0]!], ["x-forwarded-for", xff[1]!]] : headers }).then((r) => r.status);
    };
    expect(await get("100.119.218.24")).toBe(200);
    expect(await get("FD7A:115C:A1E0::6C38:DA19")).toBe(200);
    expect(await get("100.76.79.5")).toBe(403); // grok-box
    expect(await get("100.97.89.116")).toBe(403); // muse
    expect(await get()).toBe(403); // no header: didn't come through serve
    expect(await get("100.119.218.24, 100.76.79.5")).toBe(403); // several values: no guessing
    expect(await get(["100.119.218.24", "100.76.79.5"])).toBe(403); // repeated header
    expect(await get("lim-builder")).toBe(403); // not an IP
    expect(await get("")).toBe(403);
    const api = await post(port, "/api/call", { kind: "query", name: "directory:list", args: {} }, { "x-forwarded-for": "100.76.79.5" });
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: { message: "client not allowed" } });
    expect((await post(port, "/api/call", { kind: "query", name: "directory:list", args: {} }, { "x-forwarded-for": "100.119.218.24" })).status).toBe(200);
  });

  it("devAllowLoopback lets header-less loopback requests through, and only when set", async () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    const allowedClients = ["100.119.218.24"];
    const prod = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients, log: () => {} }));
    const prodOff = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients, devAllowLoopback: false, log: () => {} }));
    const dev = await listen(localWebServer({ backend, environment: "dev", mode: "proxy", allowedClients, devAllowLoopback: true, log: () => {} }));
    expect((await fetch(`http://127.0.0.1:${prod}/healthz`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${prodOff}/healthz`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${dev}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${dev}/healthz`, { headers: { "x-forwarded-for": "100.76.79.5" } })).status).toBe(403); // a forwarded excluded client is still refused in dev
  });

  it("refuses an allowedClients entry that isn't an IP", () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    expect(() => localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients: ["lim-builder"], log: () => {} })).toThrow(/not an IP address/);
  });

  it("local mode still needs its token", () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    expect(() => localWebServer({ backend, environment: "test", log: () => {} })).toThrow(/needs an admin token/);
  });
});
