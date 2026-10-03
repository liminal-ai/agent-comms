// T3 restart (stock 13976, through Alder's bin/service), and Reed's check: does T3 dedupe a
// repeated commandId across a restart, i.e. are command receipts persisted?
//
// Before: the shell snapshot must show no active run outside this port's synthetic project.
// 1. An accepted command A (message.dispatch to @v2cat's thread, completed) and a rejected
//    command R (steer into a run that doesn't exist).
// 2. A comms delivery to @v2bob, running when T3 restarts.
// 3. After the restart: A and R sent again with the same commandId and payload. Persisted
//    receipts: A returns its first sequence and adds nothing; R fails "previously rejected".
// Appends to raw/results.jsonl as `t3Restart` and `commandIdAcrossRestart`.
//
//   node validation/v2/restart.ts

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { answers, env, group, ids, log, projection, runsFor, send, sleep, SETTLED, TMP, waitBusy, waitRun, waitState } from "./lib.ts";
import { BASE, connectT3 } from "./t3.ts";

const PROJECT = JSON.parse(readFileSync(`${TMP}/ids.json`, "utf8")).projectId as string;
const CAT = ids.threads.v2cat;
const BOB = ids.threads.v2bob;
const token = readFileSync(`${process.env.HOME}/.config/agent-comms/t3-13976.token`, "utf8").trim();
const ACTIVE = ["preparing", "queued", "starting", "running", "waiting"];

// Nobody else's work on this server.
const shell = (await (await fetch(`${BASE}/api/orchestration/shell`, { headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" } })).json()) as {
  threads: { id: string; projectId: string; status: string }[];
};
const others = shell.threads.filter((t) => t.projectId !== PROJECT && ACTIVE.includes(t.status));
if (others.length) throw new Error(`active runs outside the synthetic project: ${others.map((t) => t.id).join(", ")}`);

let t3 = await connectT3();
const outcome = async (p: Promise<unknown>) => p.then((v) => ({ ok: v }), (e: Error) => ({ error: e.message.slice(0, 200) }));

// 1. A (accepted) and R (rejected).
await waitBusy(CAT, false, 400_000);
const A = { type: "message.dispatch", commandId: `v2-dedupe-${randomUUID()}`, threadId: CAT, messageId: `v2-dedupe-msg-${randomUUID()}`, text: "Dedupe check: without tools, reply with exactly DEDUPE-1", attachments: [], createdBy: "user", creationSource: "mcp", dispatchMode: { type: "start_immediately" } };
const aFirst = await outcome(t3.call("orchestration.dispatchCommand", A));
await waitRun(CAT, A.messageId, ["completed"], 180_000);
const R = { ...A, commandId: `v2-dedupe-rej-${randomUUID()}`, messageId: `v2-dedupe-rej-msg-${randomUUID()}`, dispatchMode: { type: "steer_active", targetRunId: `run:thread:${CAT}:ordinal:9999` } };
const rFirst = await outcome(t3.call("orchestration.dispatchCommand", R));
const aSameBefore = await outcome(t3.call("orchestration.dispatchCommand", A)); // control: dedupe within one server life

// 2. A comms delivery running at the restart.
const g = await group(`v2 t3-restart ${new Date().toISOString().slice(11, 19)}`, ["v2lee", "v2cat", "v2bob"]);
await waitBusy(BOB, false, 400_000);
const s = send(g, "v2bob", "V2 check t3-restart: run the shell command `sleep 20` in the foreground, then reply with exactly V2-T3-RESTART");
await waitRun(BOB, `comms-${s.deliveryId}`, ["running"]);
await sleep(4000);
await t3.close();
const restartAt = new Date().toISOString();
execFileSync("/srv/work/t3code-v2-baseline/bin/service", ["stock", "restart"], { env, stdio: "ignore" });
for (let end = Date.now() + 60_000; Date.now() < end; await sleep(500)) {
  try {
    if ((await fetch(`${BASE}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2000) })).ok) break;
  } catch {}
}
await sleep(2000);
t3 = await connectT3();

// 3. The same commands again.
const aAfter = await outcome(t3.call("orchestration.dispatchCommand", A));
const rAfter = await outcome(t3.call("orchestration.dispatchCommand", R));
await sleep(3000);
const cat = await projection(CAT);
log("results.jsonl", {
  scenario: "commandIdAcrossRestart",
  restartAt,
  accepted: { first: aFirst, againBeforeRestart: aSameBefore, againAfterRestart: aAfter, messagesWithItsId: cat.messages.filter((m) => m.id === A.messageId).length, runsForIt: cat.runs.filter((r) => r.userMessageId === A.messageId).length },
  rejected: { first: rFirst, againAfterRestart: rAfter, messagesWithItsId: cat.messages.filter((m) => m.id === R.messageId).length },
});

const d = await waitState(g, s.messageId, SETTLED, 600_000);
log("results.jsonl", { scenario: "t3Restart", restartAt, delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s), t3: await runsFor(BOB, `comms-${s.deliveryId}`) });
await t3.close();
process.exit(0);
