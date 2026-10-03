#!/usr/bin/env node
// comms-connector --config <file>: runs this machine's connector until SIGINT/SIGTERM.

import { parseArgs } from "node:util";
import { ConvexClient } from "convex/browser";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { HarnessAdapter } from "./adapter.ts";
import { loadConfig } from "./config.ts";
import { runConnector } from "./connector.ts";
import { type ConvexTransport, describeFailure, makeServerApi } from "./server-api.ts";

const { values } = parseArgs({ options: { config: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help || !values.config) {
  console.error("usage: comms-connector --config <file.json>");
  process.exit(values.help ? 0 : 2);
}

const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
const config = loadConfig(values.config);
for (const w of config.warnings) log(`warning: ${w}`);

// The Convex client's own logging prints server errors, which can echo a call's arguments (the
// machine secret among them). It only gets to log what's known to be safe (fix pass 3.6).
const quiet = (level: string) => (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (/ConvexError: \{"code":"[a-z_]+"/.test(text) || /^\[CONVEX [A-Z]\(/.test(text)) {
    const code = /"code":"([a-z_]+)"/.exec(text)?.[1];
    if (code) log(`convex ${level}: refused (${code})`);
    return;
  }
  log(`convex ${level}: ${describeFailure(new Error(text))}`);
};
const client = new ConvexClient(config.convexUrl, {
  unsavedChangesWarning: false,
  logger: { log: () => {}, logVerbose: () => {}, warn: quiet("warn"), error: quiet("error") },
});
const transport: ConvexTransport = {
  query: (ref, args) => client.query(ref, args),
  mutation: (ref, args) => client.mutation(ref, args),
  watch: (ref, args, onValue, onError) => {
    const unsubscribe = client.onUpdate(ref, args, onValue, onError);
    return () => unsubscribe();
  },
};
client.subscribeToConnectionState((state) => {
  if (!state.isWebSocketConnected && state.hasEverConnected) log("server connection lost; retrying");
});

const api = makeServerApi(transport, { machine: { id: config.machine, secret: config.secret } });

const adapters: HarnessAdapter[] = [];
if (config.adapters?.includes("t3")) {
  if (!config.t3) throw new Error(`config: "adapters" includes t3 but there's no "t3" section`);
  // Loaded only when configured.
  const { t3HarnessAdapter } = await import("./t3.ts");
  const t3 = { baseUrl: config.t3.baseUrl, authFile: config.t3.authFile, log };
  if (config.t3.protocol === 2) {
    const { makeT3ClientV2 } = await import("@agent-comms/adapter-t3/v2/client");
    const { makeT3AdapterV2 } = await import("@agent-comms/adapter-t3/v2");
    adapters.push(t3HarnessAdapter(makeT3AdapterV2({ client: makeT3ClientV2(t3), log })));
  } else {
    const { makeT3Client } = await import("@agent-comms/adapter-t3/client");
    const { makeT3Adapter } = await import("@agent-comms/adapter-t3");
    adapters.push(t3HarnessAdapter(makeT3Adapter({ client: makeT3Client(t3), log })));
  }
  log(`T3 adapter: ${config.t3.baseUrl} (orchestration protocol ${config.t3.protocol ?? 1})`);
}
const scope = Effect.runSync(Scope.make());
await Effect.runPromise(
  Scope.provide(scope)(
    runConnector({
      machine: config.machine,
      socketPath: config.socket,
      api,
      ...(config.leaseMs ? { leaseMs: config.leaseMs } : {}),
      ...(config.pollWaitMs ? { pollWaitMs: config.pollWaitMs } : {}),
      adapters,
      log,
      ...(process.env.AGENT_COMMS_FAULT === "crash-after-accept" ? { fault: "crash-after-accept" as const } : {}),
    }),
  ),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log(`${signal}: stopping`);
    void Effect.runPromise(Scope.close(scope, Exit.void))
      .then(() => client.close())
      .finally(() => process.exit(0));
  });
}
