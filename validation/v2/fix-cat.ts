// Clears @v2cat's queue: interrupts each run stuck on an approval prompt (never approves), until idle.
import { projection, sleep, ids, t3 } from "./lib.ts";
import { randomUUID } from "node:crypto";
const CAT = ids.threads.v2cat;
const end = Date.now() + 300_000;
while (Date.now() < end) {
  const p = (await t3.snapshot(CAT)).projection as unknown as { runs: { id: string; status: string }[]; runtimeRequests?: { status: string }[] };
  const active = p.runs.find((r) => ["starting", "running", "waiting"].includes(r.status));
  const blocking = p.runs.some((r) => ["preparing", "queued", "starting", "running", "waiting"].includes(r.status));
  if (!blocking) break;
  if (active && (p.runtimeRequests ?? []).some((r) => r.status === "pending")) {
    await t3.call("orchestration.dispatchCommand", { type: "run.interrupt", commandId: randomUUID(), threadId: CAT, runId: active.id, reason: "synthetic sender: no tools" });
    console.log("interrupted", active.id.split(":").pop());
  }
  await sleep(3000);
}
console.log(JSON.stringify((await projection(CAT)).runs.map((r) => [r.ordinal, r.status])));
await t3.close();
process.exit(0);
