// Starting a connector once its server API exists: the harness adapters from
// config, then the connector itself. Shared by the Convex connector
// (main.ts) and the local comms service, which supplies a local API.

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { HarnessAdapter } from "./adapter.ts";
import type { ConnectorConfig } from "./config.ts";
import { runConnector } from "./connector.ts";
import type { ServerApiShape } from "./server-api.ts";

export type StartConfig = Pick<ConnectorConfig, "machine" | "adapters" | "t3" | "leaseMs" | "pollWaitMs"> & { socket: string };

export async function harnessAdapters(config: StartConfig, log: (line: string) => void): Promise<HarnessAdapter[]> {
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
  return adapters;
}

/** Runs the connector until `stop`. */
export async function startConnector(config: StartConfig, api: ServerApiShape, log: (line: string) => void): Promise<{ stop: () => Promise<void> }> {
  const adapters = await harnessAdapters(config, log);
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
  return { stop: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}
