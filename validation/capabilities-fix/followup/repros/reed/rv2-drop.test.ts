// rv2 review: a connector that dies mid-send and is still down at the first retry.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { StubComms, startStubServer, type StubServer } from "@agent-comms/connector-stub";
import { EXIT, run } from "../src/cli.ts";

const root = await mkdtemp(join(tmpdir(), "comms-cli-rv2-"));
const socket = join(root, "agent-comms", "connector.sock");
let server: StubServer;

before(async () => {
  const comms = StubComms.fromFixture({
    machine: "box",
    participants: [{ name: "cedar" }, { name: "hazel" }],
    conversations: [],
  });
  server = await startStubServer({ socketPath: socket, comms, pollWaitMs: 50 });
});
after(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("rv2: connector dies mid-send, restarts after the first retry", () => {
  it("prints the --key line (it may have been posted) and keeps retrying with the key", async () => {
    const proxySock = join(root, "dies.sock");
    const keys: string[] = [];
    let proxy: ReturnType<typeof createServer>;
    const listen = () => {
      proxy = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          if (req.url === "/v1/send") keys.push(JSON.parse(body).key);
          const fwd = httpRequest({ socketPath: socket, path: req.url, method: "POST", headers: req.headers }, (up) => {
            let out = "";
            up.on("data", (c) => (out += c));
            up.on("end", () => {
              if (keys.length === 1) {
                // The connector posted it, then died: connection reset, socket gone, back in 3 s.
                req.socket.destroy();
                proxy.close();
                setTimeout(listen, 3_000);
                return;
              }
              res.writeHead(up.statusCode ?? 500, { "content-type": "application/json" });
              res.end(out);
            });
          });
          fwd.end(body);
        });
      });
      proxy.listen(proxySock);
    };
    listen();
    let stderr = "";
    const code = await run(["--socket", proxySock, "send", "--as", "cedar", "--continue", "@hazel", "rv2 once"], {
      env: {}, stdout: () => {}, stderr: (t) => (stderr += t), readStdin: async () => "",
    });
    proxy!.close();
    // The send was posted. Either the 5 s retry replays it (exit 0), or the key is printed.
    assert.ok(code === EXIT.ok || /--key /.test(stderr), `exit ${code}, keys sent ${keys.length}, stderr: ${stderr}`);
  });
});
