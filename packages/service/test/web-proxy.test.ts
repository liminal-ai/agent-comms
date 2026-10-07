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
  const subs: { args: Record<string, unknown>; push: (v: unknown) => void; stopped: boolean }[] = [];
  const client: ConvexLike = {
    query: async (ref, args) => (calls.push({ kind: "query", name: ref, args }), { ok: true }),
    mutation: async (ref, args) => (calls.push({ kind: "mutation", name: ref, args }), { done: true }),
    onUpdate: (_ref, args, onValue) => {
      const sub = { args, push: onValue, stopped: false };
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

  it("local mode still needs its token", () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    expect(() => localWebServer({ backend, environment: "test", log: () => {} })).toThrow(/needs an admin token/);
  });
});
