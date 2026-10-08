// The MCP server ChatGPT connects to for MCP Events: MCP 2026-07-28 over
// Streamable HTTP (one POST per request, plain JSON answers, no sessions) at
// `<publicBaseUrl>/mcp`, plus the OAuth protected-resource metadata that
// points clients at AuthKit. It listens on loopback; Tailscale Funnel makes
// it public. Every /mcp request needs an allowed AuthKit token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Authenticator } from "./auth.ts";
import { INVALID_PARAMS, RpcError, type EventHub } from "./events.ts";

export const PROTOCOL_VERSION = "2026-07-28";
const SERVER_INFO = { name: "agent-wake-relay", version: "0.1.0" };
const MAX_REQUEST = 1024 * 1024;

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;

export interface McpServerOptions {
  /** Where clients reach this server, e.g. `https://lim-builder.tailb30114.ts.net` (Funnel on :443). The MCP endpoint is `<this>/mcp`. */
  publicBaseUrl: string;
  /** The authorization server's issuer, for protected-resource metadata and the metadata proxy. */
  issuer: string;
  auth: Authenticator;
  hub: EventHub;
  log: (line: string) => void;
  request?: typeof fetch;
}

export function resourceUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/mcp`;
}

export function resourceMetadataUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`;
}

const profileSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { id: { type: "string", minLength: 1, pattern: "\\S", description: "The WorkOS user id of the connected account." } },
  required: ["id"],
  additionalProperties: false,
};

/** One harmless, read-only tool: the profile tool OpenAI uses to tell connected accounts apart. */
const TOOLS = [
  {
    name: "get_profile",
    description: "Return the profile represented by this request's authenticated credentials: an opaque, stable account id.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: profileSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: [] }],
    _meta: { "openai/profile": true },
  },
];

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string, data?: unknown): void {
  json(res, status, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

/** `Mcp-Name` may carry a value as `=?base64?...?=`. */
function decodeHeader(value: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(value);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : value;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // keep draining so the 413 can be written and read
      size += c.length;
      if (size > MAX_REQUEST) {
        tooLarge = true;
        chunks.length = 0;
      } else chunks.push(c);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createMcpServer(o: McpServerOptions): Server {
  const refused = { count: 0 };
  const sampler = setInterval(() => {
    refused.count = 0;
  }, 60_000);
  sampler.unref();
  const base = o.publicBaseUrl.replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const resource = resourceUrl(base);
  const request = o.request ?? fetch;
  const metadata = { resource, authorization_servers: [o.issuer], bearer_methods_supported: ["header"] };
  const proxied = new Map<string, { at: number; body: unknown }>();

  /** Older clients look for the authorization server's metadata on the resource's host; hand them AuthKit's. */
  async function proxyMetadata(res: ServerResponse, doc: string): Promise<void> {
    const hit = proxied.get(doc);
    if (hit && Date.now() - hit.at < 10 * 60_000) return json(res, 200, hit.body, { "cache-control": "max-age=600" });
    try {
      const upstream = await request(`${o.issuer.replace(/\/+$/, "")}/.well-known/${doc}`, { signal: AbortSignal.timeout(10_000) });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const body = await upstream.json();
      proxied.set(doc, { at: Date.now(), body });
      json(res, 200, body, { "cache-control": "max-age=600" });
    } catch (error) {
      o.log(`mcp: couldn't fetch the authorization server's ${doc}: ${(error as Error).message}`);
      json(res, 502, { error: "authorization server metadata unavailable" });
    }
  }

  function result(principal: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown> {
    switch (method) {
      case "server/discover":
        return {
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {}, events: {} },
          instructions:
            "agent-comms wake relay. Subscribe to an agent's comms.delivery event to be told when agent-comms has a delivery waiting for that agent; the event carries delivery ids only. Read and answer the delivery through the agent's comms inbox.",
        };
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call": {
        if (params.name !== "get_profile") throw new RpcError(INVALID_PARAMS, `unknown tool: ${String(params.name)}`);
        const profile = { id: principal };
        return { content: [{ type: "text", text: JSON.stringify(profile) }], structuredContent: profile, isError: false };
      }
      case "events/list":
        return { events: o.hub.definitions() };
      case "events/subscribe":
        return o.hub.subscribe(principal, params);
      case "events/unsubscribe":
        return o.hub.unsubscribe(principal, params).then(() => ({}));
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return json(res, 405, { error: "the MCP endpoint takes POST" }, { allow: "POST" });
    // Browsers send Origin; ChatGPT's servers don't. One that names somewhere else is refused (DNS rebinding).
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return json(res, 403, { error: "origin not allowed" });
    const auth = await o.auth.authenticate(req.headers.authorization);
    if (!auth.ok) {
      // Sampled: a flood of strangers mustn't be able to fill the log. The first 20 per minute are logged, then one line per minute.
      refused.count++;
      if (refused.count <= 20) o.log(`mcp: ${auth.status} for a request: ${auth.message}`);
      else if (refused.count === 21) o.log("mcp: further refused requests this minute are not logged");
      return json(res, auth.status, { error: auth.message }, auth.wwwAuthenticate ? { "www-authenticate": auth.wwwAuthenticate } : {});
    }
    const text = await readBody(req);
    if (text === null) return rpcError(res, 413, null, -32600, "request too large");
    let msg: { id?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return rpcError(res, 400, null, -32700, "parse error");
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg) || typeof msg.method !== "string") {
      return rpcError(res, 400, null, -32600, "expected a single JSON-RPC request");
    }
    const { id, method } = msg;
    /** Refuse a malformed request, saying why in the log: these are where a client's dialect would show. */
    const refuse = (status: number, code: number, message: string, data?: unknown) => {
      o.log(`mcp: refused ${method}: ${message}`);
      rpcError(res, status, id, code, message, data);
    };
    if (id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const params = (typeof msg.params === "object" && msg.params !== null && !Array.isArray(msg.params) ? msg.params : {}) as Record<string, unknown>;
    if (method === "initialize") {
      // A client from before 2026-07-28 wants a session handshake; name what's supported so it can say why.
      return refuse(400, UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version; this server speaks MCP ${PROTOCOL_VERSION} only`, {
        supported: [PROTOCOL_VERSION],
        requested: params.protocolVersion ?? null,
      });
    }
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const version = meta["io.modelcontextprotocol/protocolVersion"];
    const caps = meta["io.modelcontextprotocol/clientCapabilities"];
    if (typeof version !== "string" || typeof caps !== "object" || caps === null || Array.isArray(caps)) {
      return refuse(400, INVALID_PARAMS, "params._meta needs io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities");
    }
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    if (header("mcp-protocol-version") !== version) return refuse(400, HEADER_MISMATCH, "MCP-Protocol-Version header is missing or doesn't match the request");
    if (header("mcp-method") !== method) return refuse(400, HEADER_MISMATCH, "Mcp-Method header is missing or doesn't match the request");
    if (method === "tools/call" || method === "prompts/get" || method === "resources/read") {
      const name = header("mcp-name");
      const expected = method === "resources/read" ? params.uri : params.name;
      if (name === undefined || decodeHeader(name) !== expected) return refuse(400, HEADER_MISMATCH, "Mcp-Name header is missing or doesn't match the request");
    }
    if (version !== PROTOCOL_VERSION) {
      return refuse(400, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: [PROTOCOL_VERSION], requested: version });
    }
    try {
      const out = await result(auth.principal, method, params);
      json(res, 200, { jsonrpc: "2.0", id, result: { resultType: "complete", ...out, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } });
    } catch (error) {
      if (error instanceof RpcError) {
        if (method.startsWith("events/")) o.log(`mcp: ${method} refused: ${error.message}`);
        return rpcError(res, error.code === METHOD_NOT_FOUND ? 404 : 200, id, error.code, error.message, error.data);
      }
      o.log(`mcp: ${method} failed: ${(error as Error).message}`);
      rpcError(res, 500, id, -32603, "internal error");
    }
  }

  return createServer((req, res) => {
    const route = async () => {
      // Inside the route, so a malformed target (`GET //[`) is a 400, not an uncaught throw.
      let path: string;
      try {
        path = new URL(req.url ?? "/", "http://x").pathname;
      } catch {
        return json(res, 400, { error: "bad request target" });
      }
      if (path === "/mcp") return mcp(req, res);
      if (req.method !== "GET") return json(res, 404, { error: "not found" });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return json(res, 200, metadata, { "cache-control": "max-age=300" });
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return proxyMetadata(res, path.slice("/.well-known/".length));
      json(res, 404, { error: "not found" });
    };
    route().catch((error) => {
      o.log(`mcp: request failed: ${(error as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });
}
