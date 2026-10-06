// The local service's web listener on 127.0.0.1: the built web view, and the
// API it and the admin commands use. The API is the public Convex functions
// of the web-facing modules only (never connector:* or internal functions),
// behind Host/Origin checks and the admin token as a bearer header.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { LocalBackend } from "@agent-comms/local-backend";

/** Modules whose public functions the web view and admin commands may call. */
export const WEB_MODULES = new Set(["alerts", "conversations", "directory", "inbox", "registry", "reminders"]);
const MAX_CALL_BODY = 256 * 1024;
const MAX_WATCH_BODY = 64 * 1024;
const MAX_QUERIES = 64;
const MAX_STREAMS = 16;
const MAX_BUFFERED = 4 * 1024 * 1024;
const HEARTBEAT_MS = 20_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

export interface WebOptions {
  backend: LocalBackend;
  adminToken: string;
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
  const expected = digest(options.adminToken);
  let streams = 0;

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      checkHost(req, server);
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname.startsWith("/api/")) {
        if (req.method !== "POST") throw new HttpError(405, "POST only");
        checkOrigin(req);
        if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json");
        const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
        if (!auth || !timingSafeEqual(digest(auth), expected)) throw new HttpError(401, "admin token rejected");
        if (pathname === "/api/call") return await call(req, res);
        if (pathname === "/api/watch") return await watch(req, res);
        throw new HttpError(404, "no such endpoint");
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "GET only");
      if (pathname === "/runtime-config.json") return json(res, 200, { environment: options.environment, mode: "local" });
      if (pathname === "/healthz") return json(res, 200, { environment: options.environment, mode: "local", status: "ok" });
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
    const send = (line: unknown) => {
      if (closed) return;
      res.write(JSON.stringify(line) + "\n");
      // A client that stops reading is dropped; it reconnects and starts from current values.
      if (res.writableLength > MAX_BUFFERED) {
        close();
        res.destroy();
      }
    };
    const heartbeat = setInterval(() => send({}), HEARTBEAT_MS);
    req.on("close", close);
    res.on("close", close);
    for (const q of queries) {
      try {
        stops.push(options.backend.subscribe(q.info.name, q.args, (value: unknown) => send({ id: q.id, value }), (error: Error) => send({ id: q.id, error: describe(error) })));
      } catch (error) {
        send({ id: q.id, error: describe(error) });
      }
    }
  }

  return Object.assign(server, { streams: () => streams });
}

/** Only this listener's own loopback names: a page from elsewhere (DNS rebinding included) can't reach the API. */
function checkHost(req: IncomingMessage, server: Server): void {
  const port = (server.address() as { port: number } | null)?.port;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!allowed.has(req.headers.host ?? "")) throw new HttpError(403, "unexpected Host");
}

function checkOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}`) throw new HttpError(403, "cross-origin requests are refused");
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"] as string)) {
    throw new HttpError(403, "cross-site requests are refused");
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
