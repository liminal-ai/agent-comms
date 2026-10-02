import { run as comms } from "@agent-comms/comms-cli";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("a send whose connection drops after the connector read it exits 3 without the key to retry with", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rw-"));
  const sock = join(dir, "c.sock");
  let got = "";
  const server = createServer((s) => s.on("data", (d) => { got += d; s.destroy(); })); // the connector read the send, then died
  await new Promise<void>((r) => server.listen(sock, r));
  let out = "", err = "";
  const code = await comms(["--socket", sock, "send", "--as", "a", "@b", "q"], { env: {}, stdout: (s) => (out += s), stderr: (s) => (err += s), readStdin: async () => "" });
  server.close();
  expect(got).toMatch(/"key":"/);
  expect(code).toBe(3);
  expect(err).not.toMatch(/--key/);
  console.log(JSON.stringify(err));
});
