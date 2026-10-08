import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ConvexLike, convexWebBackend, scrubbed, WEB_FUNCTIONS } from "../src/convex-backend.ts";
import { localWebServer, WEB_MODULES } from "../src/web.ts";

const servers: ReturnType<typeof localWebServer>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function fakeClient(opts: { silent?: boolean } = {}) {
  const calls: { kind: string; name: unknown; args: Record<string, unknown> }[] = [];
  const subs: { args: Record<string, unknown>; push: (v: unknown) => void; stopped: boolean; onError?: (e: Error) => void }[] = [];
  const client: ConvexLike = {
    query: async (ref, args) => (calls.push({ kind: "query", name: ref, args }), { ok: true }),
    mutation: async (ref, args) => (calls.push({ kind: "mutation", name: ref, args }), { done: true }),
    onUpdate: (_ref, args, onValue, onError) => {
      const sub = { args, push: onValue, stopped: false, onError };
      subs.push(sub);
      if (!opts.silent) queueMicrotask(() => onValue({ n: 1 }));
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
/** A request with an explicit Host and headers (fetch won't set Host). Resolves to status and body. */
const raw = (port: number, path: string, headers: Record<string, string | string[]>, method = "GET", body?: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
/** The keys every proxy-mode server must name; development tests use loopback with the dev flag. */
const devProxy: { publicHosts: string[]; allowedClients: string[]; devAllowLoopback: true } = { publicHosts: ["comms.example.test:8461", "lim-builder.tailb30114.ts.net:8461"], allowedClients: ["100.100.0.1"], devAllowLoopback: true };

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
    const { client, subs } = fakeClient({ silent: true }); // values are pushed by hand below
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
    // A second rotation, after the refreshed query delivered a value, gets its own retry.
    subs[1]!.push({ n: 2 });
    writeFileSync(file, "third");
    subs[1]!.onError!(new Error("admin token rejected"));
    await new Promise((r) => setTimeout(r, 10));
    expect(subs[2]!.args.adminToken).toBe("third");
    expect(errors).toEqual(["admin token rejected"]);
  });

  it("a subscription that fails to start reports a scrubbed error instead of an unhandled rejection", async () => {
    const { client } = fakeClient();
    client.onUpdate = () => {
      throw new Error("Field name $bogus starts with a '$', which is reserved. Args: " + JSON.stringify({ adminToken: "leak-me" }));
    };
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("leak-me"), client });
    const errors: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      backend.subscribe("directory:list", { $bogus: 1 }, () => {}, (e) => errors.push(e.message));
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(errors).toEqual(["request failed (details withheld)"]);
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

  it("is exactly what the page calls, and every entry is a public function of a web module", () => {
    const kinds: Record<string, string> = {};
    for (const module of WEB_MODULES) {
      const source = readFileSync(new URL(`../../../convex/${module}.ts`, import.meta.url), "utf8");
      for (const m of source.matchAll(/export const (\w+) = (query|mutation)\(/g)) kinds[`${module}:${m[1]}`] = m[2]!;
    }
    const used = new Set<string>();
    const dir = new URL("../../../apps/web/src/", import.meta.url);
    const walk = (u: URL) => {
      for (const entry of readdirSync(u, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(new URL(`${entry.name}/`, u));
        else if (/\.tsx?$/.test(entry.name)) for (const m of readFileSync(new URL(entry.name, u), "utf8").matchAll(/\bapi\.(\w+)\.(\w+)/g)) used.add(`${m[1]}:${m[2]}`);
      }
    };
    walk(dir);
    expect(Object.keys(WEB_FUNCTIONS).sort()).toEqual([...used].sort());
    for (const [name, kind] of Object.entries(WEB_FUNCTIONS)) expect(kinds[name], name).toBe(kind);
    for (const name of ["directory:registerMachine", "directory:upgrade", "directory:rebind", "connector:work"]) expect(WEB_FUNCTIONS[name]).toBeUndefined();
  });

  it("never echoes a call's arguments in an error", async () => {
    const token = "super-secret-admin-token";
    const { client } = fakeClient();
    client.mutation = async (_ref, args) => {
      throw new Error(`ArgumentValidationError: Object contains extra field \`bogus\` that is not in the validator.\n\nObject: ${JSON.stringify(args)}`);
    };
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile(token), client });
    const port = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", ...devProxy, log: () => {} }));
    const r = await post(port, "/api/call", { kind: "mutation", name: "inbox:markRead", args: { bogus: 1 } });
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual({ error: { message: "request failed (the server refused the call's arguments)" } });
    // Our own server errors keep their {code, message} data.
    const own = Object.assign(new Error("ConvexError"), { data: { code: "conflict", message: "already a member" } });
    expect(scrubbed(own).data).toEqual({ code: "conflict", message: "already a member" });
    expect(scrubbed(new Error(`fetch failed: ${token}`)).message).toBe("request failed (fetch failed)");
  });

  it("a missing or empty token file is reported without its path", async () => {
    const { client } = fakeClient();
    const path = join(mkdtempSync(join(tmpdir(), "comms-proxy-")), "secret-dir", "admin-token");
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: path, client });
    const port = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", ...devProxy, log: () => {} }));
    const r = await post(port, "/api/call", { kind: "query", name: "directory:list", args: {} });
    const text = await r.text();
    expect(text).not.toContain("secret-dir");
    expect(JSON.parse(text)).toEqual({ error: { message: "request failed (the admin token is not available on the server)" } });
    const watch = await post(port, "/api/watch", { queries: [{ id: "q", name: "directory:list", args: {} }] });
    const first = new TextDecoder().decode((await watch.body!.getReader().read()).value);
    expect(first).not.toContain("secret-dir");
    expect(JSON.parse(first.split("\n")[0]!)).toEqual({ id: "q", error: { message: "request failed (the admin token is not available on the server)" } });
  });

  it("with publicHosts, serves only those Host values", async () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    const publicHosts = ["lim-builder.tailb30114.ts.net:8461"];
    const allowedClients = ["100.100.0.1"];
    const port = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", publicHosts, allowedClients, log: () => {} }));
    const dev = await listen(localWebServer({ backend, environment: "dev", mode: "proxy", publicHosts, allowedClients, devAllowLoopback: true, log: () => {} }));
    const withHost = (p: number, host: string) => raw(p, "/runtime-config.json", { host, "x-forwarded-for": "100.100.0.1" }).then((r) => r.status);
    expect(await withHost(port, "lim-builder.tailb30114.ts.net:8461")).toBe(200);
    expect(await withHost(port, "LIM-BUILDER.tailb30114.ts.net:8461")).toBe(200);
    expect(await withHost(port, "attacker.example:8461")).toBe(403);
    expect(await withHost(port, `127.0.0.1:${port}`)).toBe(403); // loopback name refused in prod
    expect(await withHost(dev, `127.0.0.1:${dev}`)).toBe(200); // and allowed in development
    expect(await withHost(dev, "attacker.example")).toBe(403);
  });
});

describe("the web API in proxy mode", () => {
  it("serves the page and the API without a page token, never exposing the admin token, to any Host", async () => {
    const { client, calls } = fakeClient();
    const token = "super-secret-admin-token";
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile(token), client });
    const port = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", ...devProxy, log: () => {} }));
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
    const allowedClients = ["100.100.0.1", "fd7a:115c:a1e0::1"];
    const publicHosts = ["comms.example.test:8461"];
    const port = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients, publicHosts, log: () => {} }));
    const get = (xff?: string | string[]) => raw(port, "/runtime-config.json", { host: publicHosts[0]!, ...(xff === undefined ? {} : { "x-forwarded-for": xff }) }).then((r) => r.status);
    const post = (p: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
      raw(p, path, { host: publicHosts[0]!, ...headers }, "POST", JSON.stringify(body)).then((r) => ({ status: r.status, json: async () => JSON.parse(r.body) }));
    expect(await get("100.100.0.1")).toBe(200);
    expect(await get("FD7A:115C:A1E0::1")).toBe(200);
    expect(await get("100.100.0.2")).toBe(403); // a sandbox host
    expect(await get("100.100.0.3")).toBe(403); // another sandbox host
    expect(await get()).toBe(403); // no header: didn't come through serve
    expect(await get("100.100.0.1, 100.100.0.2")).toBe(403); // several values: no guessing
    expect(await get(["100.100.0.1", "100.100.0.2"])).toBe(403); // repeated header
    expect(await get("lim-builder")).toBe(403); // not an IP
    expect(await get("")).toBe(403);
    const api = await post(port, "/api/call", { kind: "query", name: "directory:list", args: {} }, { "x-forwarded-for": "100.100.0.2" });
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: { message: "client not allowed" } });
    expect((await post(port, "/api/call", { kind: "query", name: "directory:list", args: {} }, { "x-forwarded-for": "100.100.0.1" })).status).toBe(200);
  });

  it("devAllowLoopback lets header-less loopback requests through, and only when set", async () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    const allowedClients = ["100.100.0.1"];
    const publicHosts = ["comms.example.test:8461"];
    const prod = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients, publicHosts, log: () => {} }));
    const prodOff = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients, publicHosts, devAllowLoopback: false, log: () => {} }));
    const dev = await listen(localWebServer({ backend, environment: "dev", mode: "proxy", allowedClients, publicHosts, devAllowLoopback: true, log: () => {} }));
    expect((await raw(prod, "/healthz", { host: publicHosts[0]! })).status).toBe(403);
    expect((await raw(prodOff, "/healthz", { host: publicHosts[0]! })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${dev}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${dev}/healthz`, { headers: { "x-forwarded-for": "100.100.0.2" } })).status).toBe(403); // a forwarded excluded client is still refused in dev
  });

  it("refuses an allowedClients entry that isn't an IP", () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    expect(() => localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients: ["lim-builder"], publicHosts: ["comms.example.test:8461"], log: () => {} })).toThrow(/not an IP address/);
  });

  it("proxy mode can't be built without publicHosts and allowedClients", () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    expect(() => localWebServer({ backend, environment: "prod", mode: "proxy", log: () => {} })).toThrow(/needs publicHosts and allowedClients/);
    expect(() => localWebServer({ backend, environment: "prod", mode: "proxy", publicHosts: ["h:1"], log: () => {} })).toThrow(/needs publicHosts and allowedClients/);
    expect(() => localWebServer({ backend, environment: "prod", mode: "proxy", allowedClients: ["100.100.0.1"], log: () => {} })).toThrow(/needs publicHosts and allowedClients/);
    expect(() => localWebServer({ backend, environment: "prod", mode: "local", adminToken: "t", trustForwardedHost: true, log: () => {} })).toThrow(/only for proxy mode/);
  });

  it("behind tailscale serve over a unix socket (Host: localhost, X-Forwarded-Host set), the forwarded host is what's checked", async () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    const publicHosts = ["lim-builder.tailb30114.ts.net:8461"];
    const port = await listen(localWebServer({ backend, environment: "prod", mode: "proxy", publicHosts, allowedClients: ["100.100.0.1"], trustForwardedHost: true, log: () => {} }));
    const serve = { host: "localhost", "x-forwarded-host": publicHosts[0]!, "x-forwarded-for": "100.100.0.1", "x-forwarded-proto": "https" };
    expect((await raw(port, "/runtime-config.json", serve)).status).toBe(200);
    expect((await raw(port, "/", serve)).status).not.toBe(403);
    const call = { kind: "query", name: "directory:list", args: {} };
    expect((await raw(port, "/api/call", { ...serve, origin: `https://${publicHosts[0]}` }, "POST", JSON.stringify(call))).status).toBe(200);
    expect((await raw(port, "/api/call", { ...serve, origin: "https://attacker.example" }, "POST", JSON.stringify(call))).status).toBe(403); // cross-origin against the forwarded name
    expect((await raw(port, "/runtime-config.json", { ...serve, "x-forwarded-host": "attacker.example:8461" })).status).toBe(403);
    expect((await raw(port, "/runtime-config.json", { ...serve, "x-forwarded-host": `${publicHosts[0]}, attacker.example` })).status).toBe(403);
    expect((await raw(port, "/runtime-config.json", { ...serve, "x-forwarded-host": [publicHosts[0]!, "attacker.example"] })).status).toBe(403);
    const { "x-forwarded-host": _dropped, ...withoutForwarded } = serve;
    expect((await raw(port, "/runtime-config.json", withoutForwarded)).status).toBe(403); // Host: localhost alone is not a public name
    expect((await raw(port, "/runtime-config.json", { ...withoutForwarded, host: publicHosts[0]! })).status).toBe(403); // the Host header is not consulted in socket mode
  });

  it("local mode still needs its token", () => {
    const { client } = fakeClient();
    const backend = convexWebBackend({ convexUrl: "https://x.convex.cloud", adminTokenFile: tokenFile("t"), client });
    expect(() => localWebServer({ backend, environment: "test", log: () => {} })).toThrow(/needs an admin token/);
  });
});
