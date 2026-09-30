// The loopback server: the protocol in @agent-comms/protocol, on the
// owner-only Unix socket. Validates requests, hands them to the handlers, and
// shapes the replies.

import { chmod, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { prepareSocketPath } from "@agent-comms/connector-stub";
import {
  decodeRequest,
  ERROR_STATUS,
  type ErrorCode,
  errorBody,
  isOp,
  LOOPBACK_PATH_PREFIX,
  type Op,
  type Requests,
  type Responses,
} from "@agent-comms/protocol";
import { LoopbackError } from "./loopback-error.ts";

export type Handlers = { [K in Op]: (req: Requests[K], aborted: AbortSignal) => Promise<Responses[K]> | Responses[K] };

export interface Loopback {
  socketPath: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

export async function serveLoopback(socketPath: string, handlers: Handlers, log: (line: string) => void): Promise<Loopback> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const fail = (code: ErrorCode, message: string) => send(ERROR_STATUS[code], errorBody(code, message));

    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method !== "POST" || !path.startsWith(LOOPBACK_PATH_PREFIX)) {
      return fail("unknown_op", `expected POST ${LOOPBACK_PATH_PREFIX}<op>`);
    }
    const op = path.slice(LOOPBACK_PATH_PREFIX.length);
    if (!isOp(op)) return fail("unknown_op", `unknown operation ${op}`);

    let body: unknown = {};
    try {
      const raw = await readBody(req);
      if (raw.length > 0) body = JSON.parse(raw);
    } catch (error) {
      return fail("bad_request", error instanceof Error && error.message.startsWith("body over") ? error.message : "body is not valid JSON");
    }
    const decoded = decodeRequest(op, body);
    if (!decoded.ok) return fail("bad_request", decoded.error);

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      const handler = handlers[op] as (r: unknown, a: AbortSignal) => Promise<object> | object;
      const result = await handler(decoded.value, abort.signal);
      send(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof LoopbackError) return fail(error.code, error.message);
      log(`${op} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return fail("internal", error instanceof Error ? error.message : String(error));
    }
  });
  // Polls are held for up to 25 s; keep the server's own timeouts well above that.
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;

  await prepareSocketPath(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
