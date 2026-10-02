// Fix pass 4: a live T3 turn changing under a waiting command. fp1-native (Claude in T3) runs
// `comms send --wait 5m` to fp1-codex, which takes ~150 s to answer. Claude moves the waiting
// command to the background at 120 s, the turn ends, and the command's completion starts a new
// turn. The answer must still reach the thread exactly once (fallback): T3 never confirms.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { convex, adminToken, typeIn, waitBusy, thread, sleep } from "/srv/work/agent-comms/validation/fix-pass-1/5/lib.mjs";
const NATIVE = "thr-fp1-native-83810a09", CODEX = "thr-fp1-codex-0bf722a1";
const LOG = new URL("./t3-turn-change.jsonl", import.meta.url).pathname;
const out = (rec) => { const l = JSON.stringify({ at: new Date().toISOString(), ...rec }); appendFileSync(LOG, l + "\n"); console.log(l); };
const marker = `TURN-CHANGE-${Date.now().toString(36)}`;
await waitBusy(NATIVE, false, 240_000); await waitBusy(CODEX, false, 240_000);
await typeIn(NATIVE, `Run this exact shell command once, in the foreground, with your shell tool's default timeout, and nothing else: comms send --as fp1-native --wait 5m @fp1-codex "${marker}: first run the shell command 'sleep 150' and wait for it to finish (keep checking it until it exits), then reply with exactly SLOW-PONG"`);
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
out({ step: "request", mid });
if (!mid) process.exit(1);
const status = () => JSON.parse(execFileSync(`${process.env.HOME}/.local/bin/comms`, ["status", mid, "--as", "fp1-native", "--json"], { encoding: "utf8" }));
let lastTurn = null, lastStates = "", final = null;
for (let i = 0; i < 160; i++) {
  await sleep(4000);
  const t = await thread(NATIVE, 3);
  const turn = { active: t.session?.activeTurnId ?? null, status: t.session?.status ?? null, latest: t.latestTurn?.turnId ?? null, latestState: t.latestTurn?.state ?? null };
  if (JSON.stringify(turn) !== JSON.stringify(lastTurn)) out({ step: "turn", ...turn });
  lastTurn = turn;
  let s; try { s = status(); } catch { continue; }
  const states = (s.wait?.results ?? []).map((r) => r.state).join();
  if (states !== lastStates) out({ step: "wait", states, endedAt: s.wait?.endedAt ?? null, waiterTurnId: s.wait?.waiterTurnId ?? null });
  lastStates = states;
  final = s;
  if (/fell-back|acknowledged|expired|ended/.test(states)) break;
}
await sleep(30_000);
const answerId = final?.wait?.results?.[0]?.answer?.id;
const t = await thread(NATIVE);
const fallbacks = (t.messages ?? []).filter((m) => m.role === "user" && (m.text || "").includes("may already have been returned") && answerId && (m.text || "").includes(answerId));
out({ step: "final", states: lastStates, answer: final?.wait?.results?.[0]?.answer?.text ?? null, fallbackMessagesInThread: fallbacks.length });
console.log(lastStates === "fell-back" && fallbacks.length === 1 ? "PASS: the turn changed under the wait and the answer fell back once" : "FAIL");
