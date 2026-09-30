// Serves the loopback protocol on the Unix socket, backed by StubComms.
// Records every request and response as JSON lines when asked to.

import { appendFileSync } from "node:fs";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  DEFAULT_POLL_WAIT_MS,
  decodeRequest,
  ERROR_STATUS,
  type ErrorCode,
  errorBody,
  isOp,
  LOOPBACK_PATH_PREFIX,
  MAX_POLL_WAIT_MS,
  type Op,
  type Requests,
} from "@agent-comms/protocol";
import { prepareSocketPath } from "./socket.ts";
import { type PostInput, StubComms, StubError } from "./state.ts";

const MAX_BODY_BYTES = 1_000_000;

export interface StubServerOptions {
  socketPath: string;
  comms: StubComms;
  /** Append every request and response here as JSON lines. */
  recordPath?: string;
  /** How long a poll is held when the client doesn't say. */
  pollWaitMs?: number;
}

export interface StubServer {
  socketPath: string;
  close(): Promise<void>;
}

export async function startStubServer(options: StubServerOptions): Promise<StubServer> {
  const { comms, socketPath } = options;
  const pollWaitMs = Math.min(options.pollWaitMs ?? DEFAULT_POLL_WAIT_MS, MAX_POLL_WAIT_MS);

  const record = (entry: Record<string, unknown>) => {
    if (options.recordPath) appendFileSync(options.recordPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  };

  const reply = (res: ServerResponse, path: string, request: unknown, status: number, body: unknown) => {
    record({ path, request, status, response: body });
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const fail = (res: ServerResponse, path: string, request: unknown, code: ErrorCode, message: string) =>
    reply(res, path, request, ERROR_STATUS[code], errorBody(code, message));

  const handleOp = async (op: Op, body: unknown, res: ServerResponse, path: string) => {
    const decoded = decodeRequest(op, body);
    if (!decoded.ok) return fail(res, path, body, "bad_request", decoded.error);
    const ok = (result: object) => reply(res, path, body, 200, { ok: true, ...result });

    switch (op) {
      case "poll":
        return poll(decoded.value as Requests["poll"], res, path, body);
      case "status":
        return ok(comms.status());
      case "register":
        return ok(comms.register(decoded.value as Requests["register"], pollWaitMs));
      case "unregister":
        return ok(comms.unregister(decoded.value as Requests["unregister"]));
      case "delivered":
        return ok(comms.delivered(decoded.value as Requests["delivered"]));
      case "outcome":
        return ok(comms.outcome(decoded.value as Requests["outcome"]));
      case "check-result":
        return ok(comms.checkResult(decoded.value as Requests["check-result"]));
      case "presence":
        return ok(comms.presence(decoded.value as Requests["presence"]));
      case "send":
        return ok(comms.send(decoded.value as Requests["send"]));
      case "reply":
        return ok(comms.reply(decoded.value as Requests["reply"]));
      case "read":
        return ok(comms.read(decoded.value as Requests["read"]));
      case "list":
        return ok(comms.list(decoded.value as Requests["list"]));
    }
  };

  const poll = (req: Requests["poll"], res: ServerResponse, path: string, body: unknown) => {
    comms.beginPoll(req.sessionId);
    const wait = Math.min(req.waitMs ?? pollWaitMs, MAX_POLL_WAIT_MS);
    let done = false;
    const finish = (send: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      try {
        if (send) reply(res, path, body, 200, { ok: true, items: comms.takeItems(req.sessionId) });
      } catch (error) {
        if (error instanceof StubError) fail(res, path, body, error.code, error.message);
        else fail(res, path, body, "internal", String(error));
      } finally {
        comms.endPoll(req.sessionId);
      }
    };
    const unsubscribe = comms.subscribe(() => {
      if (comms.hasItems(req.sessionId)) finish(true);
    });
    const timer = setTimeout(() => finish(true), wait);
    // The client went away: don't hand anything out on a dead connection.
    res.on("close", () => {
      if (!res.writableFinished) finish(false);
    });
    if (comms.hasItems(req.sessionId)) finish(true);
  };

  const handleStub = (req: IncomingMessage, body: unknown, res: ServerResponse, path: string) => {
    const ok = (result: object) => reply(res, path, body, 200, { ok: true, ...result });
    if (path === "/stub/state" && req.method === "GET") {
      return ok({ record: comms.record, sessions: comms.sessionsView() });
    }
    if (path === "/stub/post" && req.method === "POST") return ok(comms.post(body as PostInput));
    if (path === "/stub/check" && req.method === "POST") {
      return ok({ check: comms.queueCheck(String((body as { deliveryId?: unknown }).deliveryId)) });
    }
    return fail(res, path, body, "unknown_op", `no stub control ${req.method} ${path}`);
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    let body: unknown = {};
    try {
      const raw = await readBody(req);
      if (raw.length > 0) body = JSON.parse(raw);
    } catch (error) {
      return fail(res, path, null, "bad_request", error instanceof BodyTooLarge ? error.message : "body is not valid JSON");
    }
    try {
      if (path.startsWith("/stub/")) return handleStub(req, body, res, path);
      if (req.method !== "POST" || !path.startsWith(LOOPBACK_PATH_PREFIX)) {
        return fail(res, path, body, "unknown_op", `expected POST ${LOOPBACK_PATH_PREFIX}<op>`);
      }
      const op = path.slice(LOOPBACK_PATH_PREFIX.length);
      if (!isOp(op)) return fail(res, path, body, "unknown_op", `unknown operation ${op}`);
      await handleOp(op, body, res, path);
    } catch (error) {
      if (error instanceof StubError) return fail(res, path, body, error.code, error.message);
      return fail(res, path, body, "internal", error instanceof Error ? error.message : String(error));
    }
  });
  // Polls are held up to MAX_POLL_WAIT_MS; keep the server's own timeouts well above that.
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;

  await prepareSocketPath(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);
  record({ event: "listening", socketPath, machine: comms.record.machine });

  return {
    socketPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    },
  };
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge(`body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
