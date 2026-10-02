import { createServer } from "node:http";
import { run } from "../packages/comms-cli/src/cli.ts";
const sock = `/tmp/review-x-cap/scratch/fake-${process.pid}.sock`;
let mode = "";
const seen: any[] = [];
const wait = (state: string) => ({ id: "w1", messageId: "m1", waiter: { id: "pa", name: "a", kind: "agent" }, until: Date.now() + 100000, active: true, createdAt: Date.now(), inInbox: [], results: [{ recipient: { id: "pb", name: "b", kind: "agent" }, state, delivery: { id: "d1", state: "delivered" }, at: 0 }] });
const msg = { id: "m1", conversationId: "c1", seq: 1, sender: { id: "pa", name: "a", kind: "agent" }, recipients: [], kind: "request", text: "x", attachments: [], createdAt: 0, origin: { via: "cli" } };
const srv = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = JSON.parse(b || "{}"); seen.push({ path: req.url, body });
    if (mode === "drop") { req.socket.destroy(); return; }
    if (mode === "awaitConflict") {
      if (req.url === "/v1/send") { res.end(JSON.stringify({ ok: true, message: msg, deliveries: [], skipped: [], wait: wait("open") })); return; }
      res.writeHead(409); res.end(JSON.stringify({ ok: false, error: { code: "not_homed_here", message: "nope" } })); return;
    }
    res.writeHead(501); res.end(JSON.stringify({ ok: false, error: { code: "unsupported", message: "x" } }));
  });
});
await new Promise<void>((r) => srv.listen(sock, () => r()));
async function cli(args: string[]) {
  let out = "", err = "";
  const code = await run(["--socket", sock, ...args], { env: {}, stdout: (t) => (out += t), stderr: (t) => (err += t), readStdin: async () => "" });
  return { code, out, err };
}
mode = "unsup"; seen.length = 0;
let r = await cli(["send", "--as", "a", "@b", "--", "@carol said hi"]);
console.log("A) text after -- starting with @:", r.code, JSON.stringify(seen.map((s) => s.body.to)), r.err.split("\n")[0]);
mode = "drop"; seen.length = 0;
r = await cli(["send", "--as", "a", "@b", "hello"]);
console.log("B) connection dropped on send:", r.code, JSON.stringify(r.err), "attempts:", seen.length, "key printed:", seen[0] && r.err.includes(seen[0].body.key));
mode = "awaitConflict"; seen.length = 0;
r = await cli(["send", "--as", "a", "@b", "hello"]);
console.log("C) await refused (non-unavailable):", r.code, JSON.stringify(r.err), JSON.stringify(r.out));
mode = "unsup"; seen.length = 0;
r = await cli(["send", "--as", "a", "@b", "hello"]);
console.log("D) unsupported fallback:", r.code, "sends:", seen.length, "keys same:", seen[0]?.body.key === seen[1]?.body.key, "2nd has wait:", "wait" in (seen[1]?.body ?? {}));
r = await cli(["send", "--as", "a", "@b", "please", "--continue", "or", "not"]);
console.log("E) word --continue inside unquoted text:", JSON.stringify(seen.at(-1).body));
r = await cli(["send", "--as", "a", "@b", "--wait", "0s", "x"]);
console.log("F) --wait 0s:", r.code);
srv.close();
process.exit(0);
