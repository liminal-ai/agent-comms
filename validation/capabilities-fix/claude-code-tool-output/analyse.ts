import { readdirSync, readFileSync } from "node:fs";
import { findAnswerProofs } from "/srv/agents/hazel/agent-comms/packages/protocol/src/proof.ts";
const dir = process.argv[2]!;
for (const f of readdirSync(dir).sort()) {
  const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const text: string = r.text ?? "";
  const proofs = findAnswerProofs(text).map((p) => p.waitId);
  const trunc = /truncated/i.exec(text);
  console.log(`${r.tool} agentId=${r.agentId ?? "-"} bg=${r.background} len=${r.textLength} proofs=[${proofs.join(",")}] ${trunc ? "| contains: " + text.slice(Math.max(0, trunc.index - 40), trunc.index + 30).replace(/\n/g, "⏎") : ""}`);
  console.log(`    first: ${text.split("\n")[0]!.slice(0, 100)}`);
}
