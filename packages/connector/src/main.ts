#!/usr/bin/env node
// comms-connector --config <file>: runs this machine's connector until SIGINT/SIGTERM.

import { parseArgs } from "node:util";
import { ConvexClient } from "convex/browser";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { loadConfig } from "./config.ts";
import { runConnector } from "./connector.ts";
import { type ConvexTransport, makeServerApi } from "./server-api.ts";

const { values } = parseArgs({ options: { config: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help || !values.config) {
  console.error("usage: comms-connector --config <file.json>");
  process.exit(values.help ? 0 : 2);
}

const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
const config = loadConfig(values.config);
for (const w of config.warnings) log(`warning: ${w}`);

const client = new ConvexClient(config.convexUrl, { unsavedChangesWarning: false });
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
const scope = Effect.runSync(Scope.make());
await Effect.runPromise(
  Scope.provide(scope)(
    runConnector({
      machine: config.machine,
      socketPath: config.socket,
      api,
      ...(config.leaseMs ? { leaseMs: config.leaseMs } : {}),
      ...(config.pollWaitMs ? { pollWaitMs: config.pollWaitMs } : {}),
      log,
    }),
  ),
);
if (config.adapters?.includes("t3")) log("the T3 adapter isn't built yet (M3); T3 participants' deliveries wait");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log(`${signal}: stopping`);
    void Effect.runPromise(Scope.close(scope, Exit.void))
      .then(() => client.close())
      .finally(() => process.exit(0));
  });
}
