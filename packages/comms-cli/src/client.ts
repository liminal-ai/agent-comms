// A loopback client for Node: one request per call, over the connector's
// Unix socket. The mod has its own (`$.http.fetch` with `socketPath`); both
// speak the same protocol through the same `opPath` and `parseResponse`.

import { request } from "node:http";
import { homedir } from "node:os";
import {
  type Op,
  opPath,
  parseResponse,
  type Requests,
  type ResponseBody,
  SOCKET_ENV,
  socketPath,
} from "@agent-comms/protocol";

export class ConnectorUnreachable extends Error {}

export function resolveSocketPath(explicit?: string): string {
  const path =
    explicit ??
    socketPath({
      platform: process.platform,
      override: process.env[SOCKET_ENV],
      xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
      home: homedir(),
      uid: process.getuid?.(),
    });
  if (!path) throw new ConnectorUnreachable(`can't work out the connector socket path; set ${SOCKET_ENV}`);
  return path;
}

export function call<K extends Op>(socket: string, op: K, body: Requests[K]): Promise<ResponseBody<K>> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        socketPath: socket,
        path: opPath(op),
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(parseResponse<K>(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"))));
        res.on("error", reject);
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EACCES") {
        reject(new ConnectorUnreachable(`no connector at ${socket} (${error.code}); is it running?`));
      } else reject(error);
    });
    req.end(payload);
  });
}
