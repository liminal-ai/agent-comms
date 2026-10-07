#!/usr/bin/env node
// The wake-up-the-sandbox-agents service. Agents in sandboxes (Grok Bot,
// ChatGPT, Muse...) manage their own lifecycle and can't keep a process
// listening for comms, so this runs on an always-on host, watches each agent's
// machine for new deliveries, and wakes the agent through its platform's own
// trigger. Usage: wake <config.json>

import { readFileSync } from "node:fs";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { loadConfig } from "./config.ts";
import { Coordinator, type WorkDelivery } from "./coordinator.ts";
import { makeWaker } from "./wakers.ts";

const path = process.argv[2];
if (!path || path === "--help" || path === "-h") {
  process.stdout.write("usage: wake <config.json>\nWakes sandboxed agents when comms has a delivery for them. See packages/wake/README.md.\n");
  process.exit(path ? 0 : 2);
}

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const config = loadConfig(path);
const client = new ConvexClient(config.convexUrl, {
  unsavedChangesWarning: false,
  // Convex diagnostics can carry arguments (machine secrets); report only that something happened.
  logger: {
    log: () => {},
    logVerbose: () => {},
    warn: () => log("Convex warning (details withheld)"),
    error: () => log("Convex connection error (details withheld)"),
  },
});

const coordinators: Coordinator[] = [];
for (const t of config.targets) {
  const machine = { id: t.machine, secret: readFileSync(t.machineSecretFile, "utf8").trim() };
  const c = new Coordinator({ participant: t.participant, wake: makeWaker(t.participant, t.waker), log, renudgeMs: t.renudgeMs });
  coordinators.push(c);
  client.onUpdate(
    anyApi.connector!.work!,
    { machine },
    (res: { deliveries: WorkDelivery[] }) => c.update(res.deliveries),
    (error: Error) => log(`@${t.participant}: subscription error: ${error.message}`),
  );
}
log(`watching ${config.targets.map((t) => `@${t.participant}`).join(", ")}`);

const stop = async () => {
  for (const c of coordinators) c.close();
  await client.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
