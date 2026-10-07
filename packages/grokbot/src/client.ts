// A loopback client for the bridge: one HTTP request per call over the
// connector's Unix socket (a protected named pipe on Windows), like the comms
// CLI's, plus an abort signal and a timeout so a daemon can never hang on a
// connector that stopped answering.

import { request } from "node:http";
import { homedir } from "node:os";
import { type Op, opPath, parseResponse, type Requests, type ResponseBody, SOCKET_ENV, socketPath } from "@agent-comms/protocol";
import { createWindowsAgent } from "../../windows-pipe/src/agent.mjs";
import { windowsEndpoint } from "../../windows-pipe/src/index.mjs";

/** The socket couldn't be reached, the connection dropped, the call timed out or was aborted. Retry later. */
export class TransportError extends Error {}

export interface CallOptions {
  signal?: AbortSignal;
  /** Fail with a TransportError if the connection is idle this long. Default 15 s. */
  timeoutMs?: number;
}

export interface ConnectorClient {
  call<K extends Op>(op: K, body: Requests[K], options?: CallOptions): Promise<ResponseBody<K>>;
}

export const DEFAULT_CALL_TIMEOUT_MS = 15_000;

/** The connector's socket, as every other client finds it: `$AGENT_COMMS_SOCKET`, else the per-user default. */
export function defaultSocketPath(env: Record<string, string | undefined>): string | null {
  if (process.platform === "win32") return env[SOCKET_ENV] || windowsEndpoint();
  return socketPath({
    platform: process.platform,
    override: env[SOCKET_ENV],
    xdgRuntimeDir: env.XDG_RUNTIME_DIR,
    home: homedir(),
    uid: process.getuid?.(),
  });
}

export function socketClient(socket: string): ConnectorClient {
  return {
    call<K extends Op>(op: K, body: Requests[K], options: CallOptions = {}): Promise<ResponseBody<K>> {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const agent = process.platform === "win32" ? createWindowsAgent(socket) : undefined;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const req = request(
          {
            socketPath: socket,
            ...(agent ? { agent } : {}),
            path: opPath(op),
            method: "POST",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
            ...(options.signal ? { signal: options.signal } : {}),
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              if (settled) return;
              settled = true;
              resolve(parseResponse<K>(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
            });
            res.on("aborted", () => fail(new TransportError(`${op}: the connection to ${socket} dropped mid-response`)));
            res.on("error", (error) => fail(new TransportError(`${op}: ${error.message}`)));
          },
        );
        req.setTimeout(options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, () => {
          req.destroy(new TransportError(`${op}: no answer from ${socket} within ${options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS} ms`));
        });
        req.on("error", (error: NodeJS.ErrnoException) => {
          if (error instanceof TransportError) return fail(error);
          if (error.name === "AbortError") return fail(new TransportError(`${op}: aborted`));
          fail(new TransportError(`${op}: ${socket}: ${error.code ?? error.message}`));
        });
        req.end(payload);
      });
    },
  };
}
