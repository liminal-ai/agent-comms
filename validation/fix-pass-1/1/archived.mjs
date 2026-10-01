// Q2 (Reed): how does T3 refuse thread.turn.start on an archived thread, on the path the adapter uses?
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { t3, thread, now } from "../5/lib.mjs";
const OUT = new URL(".", import.meta.url).pathname;
const token = readFileSync(`${process.env.HOME}/.config/agent-comms/t3-3780.token`, "utf8").trim();
const fixture = await thread("thr-abad70c6-298e-445d-9570-aae607cea3fb", 1);
const threadId = `thr-fp1-archived-${randomUUID().slice(0, 8)}`;
await t3("/api/orchestration/dispatch", { type: "thread.create", commandId: randomUUID(), threadId, projectId: "proj-bacff64b-618b-40a7-87c1-8b89205d3d9e", title: "fix pass archived-refusal probe",
  modelSelection: fixture.modelSelection, runtimeMode: fixture.runtimeMode, interactionMode: fixture.interactionMode, branch: null, worktreePath: null, createdAt: now() });
await t3("/api/orchestration/dispatch", { type: "thread.archive", commandId: randomUUID(), threadId, createdAt: now() });
const r = await fetch("http://127.0.0.1:3780/api/orchestration/dispatch", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ type: "thread.turn.start", commandId: randomUUID(), threadId, message: { messageId: `comms-probe-${randomUUID().slice(0, 8)}`, role: "user", text: "x", attachments: [] }, runtimeMode: fixture.runtimeMode, interactionMode: fixture.interactionMode, createdAt: now() }),
});
const body = await r.text();
const after = await thread(threadId).catch((e) => ({ snapshotError: String(e.message) }));
const result = { threadId, httpStatus: r.status, body: body.slice(0, 400), snapshotAfter: after.snapshotError ?? { archivedAt: after.archivedAt, messages: after.messages.length } };
writeFileSync(`${OUT}archived-result.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
