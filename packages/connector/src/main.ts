#!/usr/bin/env node
// comms-connector --config <file>: runs this machine's connector until SIGINT/SIGTERM.

import { parseArgs } from "node:util";
import { loadConfig, verifyT3Binding } from "./config.ts";
import { startConvexConnector } from "./convex.ts";

const { values } = parseArgs({ options: { config: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help || !values.config) {
  console.error("usage: comms-connector --config <file.json>");
  process.exit(values.help ? 0 : 2);
}

const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
const config = loadConfig(values.config);
if (config.adapters?.includes("t3") && config.t3) await verifyT3Binding(config.t3);
for (const w of config.warnings) log(`warning: ${w}`);

const connector = await startConvexConnector(config, log);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log(`${signal}: stopping`);
    void connector.stop().finally(() => process.exit(0));
  });
}
