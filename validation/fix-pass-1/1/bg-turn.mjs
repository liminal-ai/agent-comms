// Q1 (Reed): what is the requestedAt of a Claude turn started by a finished background task,
// compared with the createdAt of a message we sent before it? Records events (no text) and turns.
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { t3, thread, now, sleep } from "../5/lib.mjs";
const OUT = new URL(".", import.meta.url).pathname;
const PROJECT = "proj-bacff64b-618b-40a7-87c1-8b89205d3d9e";
const fixture = await thread("thr-2b9246c9-4806-4d5d-bff5-3dca6ede7d49", 1);
const threadId = `thr-fp1-bg-${randomUUID().slice(0, 8)}`;
await t3("/api/orchestration/dispatch", { type: "thread.create", commandId: randomUUID(), threadId, projectId: PROJECT, title: "fix pass 1.2 background-turn probe",
  modelSelection: fixture.modelSelection, runtimeMode: fixture.runtimeMode, interactionMode: fixture.interactionMode, branch: null, worktreePath: null, createdAt: now() });
const recorder = (await import("node:child_process")).spawn("node", [`${OUT}record.ts`, threadId, `${OUT}bg-turn-events.jsonl`], { stdio: "inherit" });
await sleep(2000);
const startTurn = async (messageId, text) => {
  const createdAt = now();
  await t3("/api/orchestration/dispatch", { type: "thread.turn.start", commandId: randomUUID(), threadId, message: { messageId, role: "user", text, attachments: [] },
    runtimeMode: fixture.runtimeMode, interactionMode: fixture.interactionMode, createdAt });
  return createdAt;
};
const idle = async () => { for (;;) { const t = await thread(threadId, 2); if (!t.session || !["running", "starting"].includes(t.session.status)) return t; await sleep(500); } };
const turns = [];
const snap = async (label) => { const t = await thread(threadId); turns.push({ label, at: now(), latestTurn: t.latestTurn, session: t.session && { status: t.session.status, activeTurnId: t.session.activeTurnId },
  messages: t.messages.map((m) => ({ id: m.id, role: m.role, turnId: m.turnId, createdAt: m.createdAt })) }); };

// 1. Lee: launch a background shell task and end the turn.
await startTurn(`lee-bg-${randomUUID()}`, "Start the shell command `sleep 45 && echo BG-DONE` as a background task (run_in_background), then end your turn immediately with the single word STARTED. Do not wait for it.");
await sleep(3000); await idle(); await snap("after-lee-turn");
// 2. Ours, while the background task is still running.
const ourId = `comms-probe-${randomUUID().slice(0, 8)}`;
const ourCreatedAt = await startTurn(ourId, "Reply with exactly OURS");
await sleep(3000); await idle(); await snap("after-our-turn");
// 3. Wait for the background task to finish and Claude to start a turn with no user message.
const deadline = Date.now() + 120_000;
let wake = null;
while (Date.now() < deadline) {
  const t = await thread(threadId, 3);
  const ourTurn = turns.at(-1).latestTurn?.turnId;
  if (t.latestTurn && t.latestTurn.turnId !== ourTurn) { wake = t.latestTurn; break; }
  await sleep(1000);
}
await idle(); await snap("after-wake");
const result = { threadId, ourMessageId: ourId, ourCreatedAt, wakeTurn: wake, wakeRequestedAtEqualsOurs: wake ? Date.parse(wake.requestedAt) === Date.parse(ourCreatedAt) : null };
writeFileSync(`${OUT}bg-turn-result.json`, JSON.stringify({ ...result, snapshots: turns }, null, 1));
recorder.kill();
console.log(JSON.stringify(result));
