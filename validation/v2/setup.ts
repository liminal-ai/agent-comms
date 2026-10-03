// Creates the V2 port's synthetic T3 project and threads on stock 13976, and the scratch
// Convex participants (3214) that live in them. Never the live Convex (3240) or 3780.
//
//   node validation/v2/setup.ts      writes /srv/agents/cedar/tmp/v2/ids.json

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { connectT3 } from "./t3.ts";

const TMP = "/srv/agents/cedar/tmp/v2";
const CONVEX = "http://127.0.0.1:3214";
const idsFile = `${TMP}/ids.json`;
if (existsSync(idsFile)) throw new Error(`${idsFile} exists: setup already ran`);

const t3 = await connectT3();
const config = await t3.call<{ providers: { instanceId: string; installed: boolean; version?: string }[]; settings: { continueThreadsAfterServerUpdate: boolean } }>("server.getConfig", {});
const claude = config.providers.find((p) => p.instanceId === "claudeAgent");
if (!claude?.installed) throw new Error("claudeAgent isn't installed on 13976");
if (config.settings.continueThreadsAfterServerUpdate !== false) throw new Error("automatic continuation is on");

const fixture = `${TMP}/fixture`;
mkdirSync(fixture, { recursive: true });
writeFileSync(`${fixture}/README.txt`, "Synthetic agent-comms V2 port fixture; no production files.\n");
execFileSync("git", ["init", "-q", fixture]);
execFileSync("git", ["-C", fixture, "add", "."]);
execFileSync("git", ["-C", fixture, "-c", "user.name=Cedar", "-c", "user.email=cedar@localhost", "commit", "-qm", "fixture"]);
const projectId = randomUUID();
await t3.call("projects.mutate", { type: "project.create", commandId: randomUUID(), projectId, title: "agent-comms V2 port (synthetic)", workspaceRoot: fixture, createWorkspaceRootIfMissing: false });

// v2ann and v2bob: Claude, full access inside the fixture (they run the comms CLI); v2cat: Claude, approval-required.
const threads: Record<string, string> = {};
for (const [name, runtimeMode] of [["v2ann", "full-access"], ["v2bob", "full-access"], ["v2cat", "approval-required"]] as const) {
  const threadId = randomUUID();
  await t3.call("orchestration.dispatchCommand", {
    type: "thread.create", commandId: randomUUID(), projectId, threadId, title: `comms ${name}`,
    modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5", options: [{ id: "contextWindow", value: "1m" }] }, runtimeMode, interactionMode: "default",
    branch: null, worktreePath: null, createdBy: "user", creationSource: "web",
  });
  threads[name] = threadId;
}
await t3.close();

const adminToken = readFileSync(`${TMP}/admin-token`, "utf8").trim();
const secret = readFileSync(`${TMP}/m1-secret`, "utf8").trim();
const convex = new ConvexHttpClient(CONVEX);
await convex.mutation("directory:registerMachine" as never, { adminToken, machineId: "v2m", secret } as never);
await convex.mutation("directory:promote" as never, { adminToken, name: "v2lee", kind: "human" } as never);
for (const [name, threadId] of Object.entries(threads)) {
  await convex.mutation("directory:promote" as never, { adminToken, name, kind: "agent", owner: "v2lee", home: { machine: "v2m", harness: "t3", locator: threadId } } as never);
}
writeFileSync(idsFile, JSON.stringify({ projectId, fixture, threads, claude: claude.version }, null, 2));
console.log(JSON.stringify({ projectId, threads, claude: claude.version }, null, 2));
