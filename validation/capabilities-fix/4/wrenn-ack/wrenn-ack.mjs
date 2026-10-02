// Wrenn's live T3 send-and-wait (from /scratch/wrenn/cap-retest/ack-test.mjs), kept as a regression
// check for the fix pass. A T3 agent (fp1-native) runs `comms send` as the very first action of its
// turn. Before the fix the result was acknowledged (wrongly: T3 can't show the agent saw it). Now
// T3 never confirms, so the result must end `fell-back`, with exactly one fallback copy of the
// answer in fp1-native's thread.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { convex, adminToken, typeIn, waitBusy, thread, sleep } from "/srv/work/agent-comms/validation/fix-pass-1/5/lib.mjs";
const NATIVE = "thr-fp1-native-83810a09", CODEX = "thr-fp1-codex-0bf722a1";
const LOG = new URL("./wrenn-ack.jsonl", import.meta.url).pathname;
const out = (rec) => { const l = JSON.stringify({ at: new Date().toISOString(), ...rec }); appendFileSync(LOG, l + "\n"); console.log(l); };
const marker = `WRENN-ACK-${Date.now().toString(36)}`;
await waitBusy(NATIVE, false, 240_000); await waitBusy(CODEX, false, 240_000);
const t0 = Date.now();
await typeIn(NATIVE, `As your very first action, run this exact shell command and then reply with just its output: comms send --as fp1-native @fp1-codex "${marker}: without tools reply with exactly ACK-PONG"`);
out({ step: "typed", marker });
let mid = null;
for (let i = 0; i < 60 && !mid; i++) {
  await sleep(2000);
  for (const c of (await convex.query("conversations:list", { adminToken })).conversations) {
    const v = await convex.query("conversations:view", { adminToken, conversationId: c.id, limit: 20 });
    const m = v.messages.find((x) => (x.message.text || "").includes(marker) && x.message.kind === "request");
    if (m) { mid = m.message.id; break; }
  }
}
out({ step: "request", mid, afterMs: Date.now() - t0 });
if (!mid) process.exit(1);
const status = () => JSON.parse(execFileSync(`${process.env.HOME}/.local/bin/comms`, ["status", mid, "--as", "fp1-native", "--json"], { encoding: "utf8" }));
let last = null, states = [];
for (let i = 0; i < 100; i++) {
  await sleep(5000);
  try { last = status(); } catch (e) { out({ step: "status-error", err: String(e).slice(0, 200) }); continue; }
  const w = last.wait ?? {};
  const now = (w.results ?? []).map((r) => r.state);
  if (now.join() !== states.join()) out({ step: "state", states: now, waiterTurnId: w.waiterTurnId ?? null, endedAt: w.endedAt ?? null });
  states = now;
  if (states.some((s) => s === "acknowledged" || s === "fell-back" || s === "expired" || s === "ended")) break;
}
await sleep(20_000); // let the fallback land in the thread
const answerId = last?.wait?.results?.[0]?.answer?.id;
const t = await thread(NATIVE);
const fallbacks = (t.messages ?? []).filter((m) => m.role === "user" && (m.text || "").includes("may already have been returned") && (!answerId || (m.text || "").includes(answerId)));
out({ step: "final", states, answer: last?.wait?.results?.[0]?.answer?.text ?? null, fallbackMessagesInThread: fallbacks.length });
console.log(states[0] === "fell-back" && fallbacks.length === 1 ? "PASS: fell back once" : "FAIL");
