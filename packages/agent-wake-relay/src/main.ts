#!/usr/bin/env node
// agent-wake-relay: wakes sandboxed and similar agents (Grok Bot, ChatGPT,
// Muse...) that manage their own lifecycle and can't keep a listener running.
// It runs on an always-on host, watches each agent's machine for new
// deliveries, and wakes the agent with provider-specific code. When a target
// is woken by MCP Events (ChatGPT), it also hosts the MCP server ChatGPT
// subscribes through. Usage: agent-wake-relay <config.json>

import { ConvexError } from "convex/values";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { loadConfig } from "./config.ts";
import { Coordinator, type WorkDelivery } from "./coordinator.ts";
import { Authenticator, workosUserLookup } from "./mcp/auth.ts";
import { EventHub } from "./mcp/events.ts";
import { createMcpServer, resourceMetadataUrl, resourceUrl } from "./mcp/server.ts";
import { SubscriptionStore } from "./mcp/store.ts";
import { guardedPost } from "./mcp/webhook.ts";
import { makeWaker } from "./wakers.ts";

const path = process.argv[2];
if (!path || path === "--help" || path === "-h") {
  process.stdout.write("usage: agent-wake-relay <config.json>\nWakes sandboxed agents when comms has a delivery for them. See packages/agent-wake-relay/README.md.\n");
  process.exit(path ? 0 : 2);
}

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const config = loadConfig(path);

let events: EventHub | undefined;
let server: Server | undefined;
const coordinators: Coordinator[] = [];
const byParticipant = new Map<string, Coordinator>();
if (config.mcp) {
  const m = config.mcp;
  const store = new SubscriptionStore(m.stateFile, Date.now, log);
  await store.load();
  if (!["127.0.0.1", "::1", "localhost"].includes(m.host)) log(`mcp: WARNING listening on ${m.host}, not loopback; the endpoint is meant to sit behind tailscale funnel`);
  const auth = new Authenticator({
    issuer: m.issuer,
    resource: resourceUrl(m.publicBaseUrl),
    resourceMetadataUrl: resourceMetadataUrl(m.publicBaseUrl),
    jwksUrl: m.jwksUrl,
    allowedEmails: m.allowedEmails,
    allowedSubjects: m.allowedSubjects,
    ...(m.workosApiKeyFile ? { lookup: workosUserLookup(m.workosApiKeyFile) } : {}),
  });
  events = new EventHub({
    targets: config.targets.flatMap((t) => (t.waker.kind === "mcp-events" ? [{ participant: t.participant, event: t.waker.event! }] : [])),
    store,
    post: guardedPost(),
    authorize: (principal) => auth.authorize(principal),
    // A subscriber connected or refreshed: whatever that participant's coordinator spent while nothing could receive it is woken for again.
    onSubscribed: (participant) => byParticipant.get(participant)?.subscriberAvailable(),
    log,
    maxTtlMs: m.maxTtlMs,
  });
  server = createMcpServer({ publicBaseUrl: m.publicBaseUrl, issuer: m.issuer, auth, hub: events, log });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(m.port, m.host, resolve);
  });
  log(`mcp: serving ${resourceUrl(m.publicBaseUrl)} on ${m.host}:${m.port}; ${store.active().length} subscription(s)`);
}
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

for (const t of config.targets) {
  const machine = { id: t.machine, secret: readFileSync(t.machineSecretFile, "utf8").trim() };
  const c = new Coordinator({
    participant: t.participant,
    wake: makeWaker(t.participant, t.waker, { events }),
    log,
    renudgeMs: t.renudgeMs,
    wakeOn: t.wakeOn,
    ...(t.waker.kind === "mcp-events" && events
      ? {
          forget: (ids: string[]) => events.forget(t.participant, ids),
          retire: (ids: string[]) => events.retire(t.participant, ids),
        }
      : {}),
  });
  coordinators.push(c);
  byParticipant.set(t.participant, c);
  client.onUpdate(
    anyApi.connector!.work!,
    { machine },
    (res: { deliveries: WorkDelivery[] }) => c.update(res.deliveries),
    // The error can serialize the call's arguments, including the machine secret; log only its kind.
    (error: Error) => {
      // A rejected credential never recovers on its own (rotated or revoked secret, deleted machine): exit non-zero so
      // systemd restarts the relay and the secret file is read again, instead of looking alive while waking no one.
      // Convex production redacts plain error text to "Server Error"; the rejection is a ConvexError whose data survives.
      if (error instanceof ConvexError && (error.data as { code?: string } | undefined)?.code === "forbidden") {
        log(`@${t.participant}: the machine credential was rejected; exiting so the service restarts with the current secret file`);
        process.exit(3);
      }
      log(`@${t.participant}: subscription error (${error.name || "Error"}; details withheld)`);
    },
  );
}
log(`watching ${config.targets.map((t) => `@${t.participant}`).join(", ")}`);

const stop = async () => {
  for (const c of coordinators) c.close();
  server?.close();
  await client.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
