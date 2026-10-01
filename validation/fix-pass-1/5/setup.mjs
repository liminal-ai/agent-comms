// Creates this run's T3 threads and comms participants. Idempotent by name.
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { adminToken, convex, now, OUT, t3, thread } from "./lib.mjs";
const PROJECT = "proj-bacff64b-618b-40a7-87c1-8b89205d3d9e";
const from = { native: "thr-2b9246c9-4806-4d5d-bff5-3dca6ede7d49", codex: "thr-abad70c6-298e-445d-9570-aae607cea3fb" };
const file = `${OUT}run.json`;
const run = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { threads: {} };
for (const [kind, fixture] of Object.entries(from)) {
  if (run.threads[kind]) continue;
  const f = await thread(fixture, 1);
  const threadId = `thr-fp1-${kind}-${randomUUID().slice(0, 8)}`;
  await t3("/api/orchestration/dispatch", {
    type: "thread.create", commandId: randomUUID(), threadId, projectId: PROJECT, title: `fix pass 1 section 5 (${kind})`,
    modelSelection: f.modelSelection, runtimeMode: f.runtimeMode, interactionMode: f.interactionMode, branch: null, worktreePath: null, createdAt: now(),
  });
  run.threads[kind] = threadId;
}
const participants = [
  ["fp1-native", { machine: "lim-builder", harness: "t3", locator: run.threads.native }],
  ["fp1-codex", { machine: "lim-builder", harness: "t3", locator: run.threads.codex }],
  ["fp1-req", { machine: "lim-builder", harness: "claude-code", locator: "fp1-req" }],
];
for (const [name, home] of participants) {
  try {
    await convex.mutation("directory:promote", { adminToken, name, kind: "agent", home });
  } catch (e) {
    if (e?.data?.code !== "conflict") throw e;
  }
}
writeFileSync(file, JSON.stringify(run, null, 2));
console.log(JSON.stringify(run));
