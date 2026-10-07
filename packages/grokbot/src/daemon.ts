// `grokbot run`: one daemon per bridge home, stopped cleanly by SIGINT/SIGTERM,
// and exiting by itself (status 0) when a newer session supersedes it.

import { socketClient } from "./client.ts";
import type { GrokbotConfig } from "./config.ts";
import { Bridge } from "./bridge.ts";
import { acquireLock, LockHeld } from "./lock.ts";
import { Store } from "./store.ts";
import { webhookWake } from "./webhook.ts";

export async function runDaemon(config: GrokbotConfig, options: { log: (line: string) => void }): Promise<number> {
  const store = new Store({ inboxDir: config.inboxDir, outboxDir: config.outboxDir, logFile: config.logFile, stateFile: config.stateFile });
  await store.init();
  let release: () => Promise<void>;
  try {
    release = await acquireLock(config.lockFile);
  } catch (error) {
    if (error instanceof LockHeld) {
      options.log(error.message);
      return 1;
    }
    throw error;
  }
  const bridge = new Bridge({
    config,
    client: socketClient(config.socket),
    store,
    log: options.log,
    ...(config.wakeWebhook ? { wake: webhookWake(config.wakeWebhook) } : {}),
  });
  const onSignal = (signal: NodeJS.Signals) => {
    options.log(`${signal}: stopping`);
    void bridge.stop("stopped");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    options.log(`connector socket ${config.socket}; inbox ${config.inboxDir}; answer timeout ${Math.round(config.answerTimeoutMs / 1000)} s`);
    await bridge.start();
    const reason = await bridge.done;
    if (reason === "superseded") options.log(`a newer session took over @${config.participant}; exiting`);
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await release();
  }
}
