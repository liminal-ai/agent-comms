import { EXIT, run as comms } from "@agent-comms/comms-cli";
import { call } from "@agent-comms/comms-cli/client";
import { afterEach, expect, it } from "vitest";
import { Mod, type Running, startConnector, world } from "./harness.ts";
let running: Running[] = [];
afterEach(async () => { for (const r of running) await r.stop().catch(() => {}); running = []; });
async function cli(socket: string, args: string[]) {
  let stdout = "", stderr = "";
  const t0 = Date.now();
  const code = await comms(["--socket", socket, ...args], { env: {}, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), readStdin: async () => "" });
  return { code, stdout, stderr, ms: Date.now() - t0 };
}
it("review: comms await after exit 4 can't wait any longer", async () => {
  const w = await world();
  running.push(await startConnector(w.api, w.socket));
  const b = new Mod(w.socket, "b");
  await b.register();
  const first = await cli(w.socket, ["send", "--as", "a", "--wait", "2s", "@b", "slow one"]);
  console.log("send:", first.code, first.ms, "ms");
  const id = /^sent (\S+)/m.exec(first.stdout)![1]!;
  const again = await cli(w.socket, ["await", "--as", "a", "--wait", "5m", id]);
  console.log("await after exit 4:", again.code, again.ms, "ms", JSON.stringify(again.stdout));
  expect(again.code).toBe(EXIT.pending);
});
