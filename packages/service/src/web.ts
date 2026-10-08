// The local service's web listener on 127.0.0.1: the built web view, and the
// API it and the admin commands use. The API is the public Convex functions
// of the web-facing modules only (never connector:* or internal functions),
// behind Host/Origin checks and the admin token as a bearer header.

import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { FunctionInfo, LocalBackend } from "@agent-comms/local-backend";

/** What the web API needs from a backend: the local SQLite one, or a proxy to a Convex deployment. */
export type WebBackend = Pick<LocalBackend, "info" | "call" | "subscribe">;
export type { FunctionInfo };

/** Modules whose public functions the web view and admin commands may call. */
export const WEB_MODULES = new Set(["alerts", "conversations", "directory", "inbox", "registry", "reminders"]);
const MAX_CALL_BODY = 256 * 1024;
const MAX_WATCH_BODY = 64 * 1024;
const MAX_QUERIES = 64;
const MAX_STREAMS = 16;
const HEARTBEAT_MS = 20_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

export interface WebOptions {
  backend: WebBackend;
  /**
   * `local`: the page sends this token as a bearer header and only loopback Hosts are served.
   * `proxy`: no page token and any Host; the backend holds the real admin token and the network
   * (a tailnet-only listener, a firewall) decides who may reach the page. The token never reaches a browser.
   */
  mode?: "local" | "proxy";
  adminToken?: string;
  /**
   * Proxy mode: the only client addresses served, as `tailscale serve` reports them in the single
   * `X-Forwarded-For` value it sets (it overwrites the header with the real peer). With this set, a
   * request whose header is missing, multi-valued, unparsable, or not listed gets 403, including
   * loopback requests that bypassed serve, unless `devAllowLoopback` is on.
   */
  allowedClients?: string[];
  /** Development only: with `allowedClients`, accept header-less requests from loopback. Off in prod. */
  devAllowLoopback?: boolean;
  /** Proxy mode: the Host values the page is published under (e.g. `lim-builder.tailb30114.ts.net:8461`). Any other Host is refused, as in local mode; DNS rebinding can't reach the API. Required in proxy mode. */
  publicHosts?: string[];
  /**
   * Proxy mode over a unix socket: `tailscale serve` rewrites `Host` to `localhost` for unix targets and
   * carries the public name in a single `X-Forwarded-Host`, so that header is what the Host and Origin
   * checks compare against. Only safe when the hop is authenticated (the mode-600 socket); never over TCP.
   */
  trustForwardedHost?: boolean;
  environment: string;
  /** The built web view; absent serves only the API. */
  root?: string;
  log: (line: string) => void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function localWebServer(options: WebOptions): Server & { streams(): number } {
  const mode = options.mode ?? "local";
  if (mode === "local" && !options.adminToken) throw new Error("local mode needs an admin token");
  // An admin proxy that admits any client or any Host would hand the page's power to the network; no caller may build one.
  if (mode === "proxy" && (!options.publicHosts?.length || !options.allowedClients?.length)) throw new Error("proxy mode needs publicHosts and allowedClients");
  if (options.trustForwardedHost && mode !== "proxy") throw new Error("trustForwardedHost is only for proxy mode");
  const expected = options.adminToken ? digest(options.adminToken) : undefined;
  const clients = options.allowedClients ? allowlist(options.allowedClients) : undefined;
  let streams = 0;

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const host = options.trustForwardedHost ? forwardedHost(req) : (req.headers.host ?? "");
      if (mode === "local") checkHost(req, server);
      else checkPublicHost(host, options.publicHosts!, options.devAllowLoopback === true, server);
      if (clients) checkClient(req, clients, options.devAllowLoopback === true);
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname.startsWith("/api/")) {
        if (req.method !== "POST") throw new HttpError(405, "POST only");
        checkOrigin(req, host);
        if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json");
        if (expected) {
          const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
          if (!auth || !timingSafeEqual(digest(auth), expected)) throw new HttpError(401, "admin token rejected");
        }
        if (pathname === "/api/call") return await call(req, res);
        if (pathname === "/api/watch") return await watch(req, res);
        throw new HttpError(404, "no such endpoint");
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "GET only");
      if (pathname === "/runtime-config.json") return json(res, 200, { environment: options.environment, mode });
      if (pathname === "/healthz") return json(res, 200, { environment: options.environment, mode, status: "ok" });
      if (!options.root) throw new HttpError(404, "not found");
      const root = resolve(options.root);
      const path = resolve(root, "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
      if (!path.startsWith(root + sep)) throw new HttpError(403, "forbidden");
      const body = await readFile(path).catch((e: NodeJS.ErrnoException) => {
        throw e.code === "ENOENT" || e.code === "EISDIR" ? new HttpError(404, "not found") : e;
      });
      res.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
      res.writeHead(200);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) return json(res, error.status, { error: { message: error.message } });
      options.log(`web: request failed: ${(error as Error).name}`);
      json(res, 500, { error: { message: "request failed" } });
    }
  });

  function resolveFunction(kind: unknown, name: unknown) {
    if (kind !== "query" && kind !== "mutation") throw new HttpError(400, `"kind" must be query or mutation`);
    if (typeof name !== "string" || name.length > 200) throw new HttpError(400, `"name" must be a function name`);
    const info = options.backend.info(name);
    const module = name.split(":")[0]!;
    if (!info || info.visibility !== "public" || !WEB_MODULES.has(module)) throw new HttpError(404, `no function ${name}`);
    if (info.kind !== kind) throw new HttpError(400, `${name} is a ${info.kind}`);
    return info;
  }

  async function call(req: IncomingMessage, res: ServerResponse) {
    const body = (await readJson(req, MAX_CALL_BODY)) as { kind?: unknown; name?: unknown; args?: unknown };
    const info = resolveFunction(body.kind, body.name);
    try {
      const value = await options.backend.call(info.kind, info.name, body.args ?? {});
      json(res, 200, { value });
    } catch (error) {
      json(res, 400, { error: describe(error) });
    }
  }

  async function watch(req: IncomingMessage, res: ServerResponse) {
    const body = (await readJson(req, MAX_WATCH_BODY)) as { queries?: unknown };
    if (!Array.isArray(body.queries) || body.queries.length === 0 || body.queries.length > MAX_QUERIES) {
      throw new HttpError(400, `"queries" must list 1-${MAX_QUERIES} queries`);
    }
    const queries = body.queries.map((q: { id?: unknown; name?: unknown; args?: unknown }) => {
      if (typeof q?.id !== "string" || q.id.length > 512) throw new HttpError(400, "each query needs a string id");
      return { id: q.id, info: resolveFunction("query", q.name), args: q.args ?? {} };
    });
    if (streams >= MAX_STREAMS) throw new HttpError(503, "too many open streams");
    streams++;
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    const stops: (() => void)[] = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      streams--;
      clearInterval(heartbeat);
      for (const stop of stops) stop();
      res.end();
    };
    // A client that falls behind gets each query's latest value when it catches up: while the
    // response is backed up, at most one frame per query waits (a newer value replaces it).
    // A single frame may be large (an inbox page of long messages); it's never cut or dropped.
    const waiting = new Map<string, string>();
    let blocked = false;
    const write = (frame: string) => {
      if (!res.write(frame)) blocked = true;
    };
    const send = (key: string, line: unknown) => {
      if (closed) return;
      const frame = JSON.stringify(line) + "\n";
      if (blocked) waiting.set(key, frame);
      else write(frame);
    };
    res.on("drain", () => {
      blocked = false;
      for (const [key, frame] of waiting) {
        waiting.delete(key);
        write(frame);
        if (blocked) break;
      }
    });
    const heartbeat = setInterval(() => blocked || send("", {}), HEARTBEAT_MS);
    req.on("close", close);
    res.on("close", close);
    for (const q of queries) {
      try {
        stops.push(options.backend.subscribe(q.info.name, q.args, (value: unknown) => send(q.id, { id: q.id, value }), (error: Error) => send(q.id, { id: q.id, error: describe(error) })));
      } catch (error) {
        send(q.id, { id: q.id, error: describe(error) });
      }
    }
  }

  return Object.assign(server, { streams: () => streams });
}

function allowlist(addresses: string[]): BlockList {
  const list = new BlockList();
  for (const a of addresses) {
    const family = isIP(a);
    if (!family) throw new Error(`allowedClients: "${a}" is not an IP address`);
    list.addAddress(a, family === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

/**
 * The client as `tailscale serve` reports it: exactly one `X-Forwarded-For` value that is an IP on the
 * list. Anything else is refused, with no guessing among several values. A request with no header came
 * from somewhere other than serve (loopback), which only development may allow.
 */
function checkClient(req: IncomingMessage, clients: BlockList, devAllowLoopback: boolean): void {
  const raw = req.headers["x-forwarded-for"];
  if (raw === undefined) {
    const peer = req.socket.remoteAddress ?? "";
    if (devAllowLoopback && (peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1")) return;
    throw new HttpError(403, "client not allowed");
  }
  if (Array.isArray(raw) || raw.includes(",")) throw new HttpError(403, "client not allowed");
  const value = raw.trim();
  const family = isIP(value);
  if (!family || !clients.check(value, family === 6 ? "ipv6" : "ipv4")) throw new HttpError(403, "client not allowed");
}

/** Over an authenticated socket hop: the single public name `tailscale serve` forwards. Missing, repeated or comma-joined is refused. */
function forwardedHost(req: IncomingMessage): string {
  const raw = req.headers["x-forwarded-host"];
  if (raw === undefined || Array.isArray(raw) || raw.includes(",")) throw new HttpError(403, "unexpected Host");
  return raw.trim();
}

/** Proxy mode: only the published names (plus loopback in development). */
function checkPublicHost(hostValue: string, hosts: string[], devAllowLoopback: boolean, server: Server): void {
  const host = hostValue.toLowerCase();
  if (hosts.some((h) => h.toLowerCase() === host)) return;
  const port = (server.address() as { port: number } | null)?.port;
  if (devAllowLoopback && allowedHosts(port ?? -1).has(host)) return;
  throw new HttpError(403, "unexpected Host");
}

/** Only this listener's own loopback names: a page from elsewhere (DNS rebinding included) can't reach the API. */
function checkHost(req: IncomingMessage, server: Server): void {
  const port = (server.address() as { port: number } | null)?.port;
  const allowed = allowedHosts(port ?? -1);
  if (!allowed.has(req.headers.host ?? "")) throw new HttpError(403, "unexpected Host");
}

/** This listener's loopback Host values. Browsers leave the default port out of Host. */
export function allowedHosts(port: number): Set<string> {
  return new Set(["127.0.0.1", "localhost", "[::1]"].flatMap((n) => (port === 80 ? [n, `${n}:80`] : [`${n}:${port}`])));
}

/** The page's own origin only. Behind a TLS proxy (tailscale serve) the browser's Origin is https while the hop here is http, so the scheme isn't compared. */
function checkOrigin(req: IncomingMessage, host: string): void {
  const origin = req.headers.origin;
  if (origin !== undefined && originHost(origin) !== host) throw new HttpError(403, "cross-origin requests are refused");
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"] as string)) {
    throw new HttpError(403, "cross-site requests are refused");
  }
}

function originHost(origin: string): string | undefined {
  try {
    const u = new URL(origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "the body must be a JSON object");
  }
}

/** A function's error for the client: a ConvexError's data, or the error's own message (which never holds args). */
function describe(error: unknown): { message: string; data?: unknown } {
  const data = (error as { data?: unknown }).data;
  if (data !== undefined) {
    const message = typeof data === "object" && data && typeof (data as { message?: unknown }).message === "string" ? (data as { message: string }).message : JSON.stringify(data);
    return { message: message.slice(0, 1_000), data };
  }
  return { message: String((error as Error).message ?? error).slice(0, 1_000) };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const digest = (s: string) => createHash("sha256").update(s).digest();
