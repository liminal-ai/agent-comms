// Local mode in one process: the SQLite store and the repository's Convex
// functions, their crons, the web view/admin API, and the connector (Claude
// Code socket or Windows pipe, plus T3 if configured) using the backend in
// process. No Convex deployment, account or enrollment.

import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { verifyT3Binding } from "@agent-comms/connector/config";
import { type ConvexTransport, makeServerApi } from "@agent-comms/connector/server-api";
import { startConnector } from "@agent-comms/connector/start";
import { LocalBackend, Store, tablesOf } from "@agent-comms/local-backend";
import { crons, modules, schema } from "@agent-comms/local-backend/modules";
import type { LocalConfig } from "./config.ts";
import { ADMIN_TOKEN_FILE, MACHINE_SECRET_FILE, prepareDataDir, settleCredential, STORE_FILE, stageCredentials } from "./data.ts";
import { localWebServer } from "./web.ts";

export interface RunningLocal {
  backend: LocalBackend;
  port: number;
  stop: () => Promise<void>;
}

export async function startLocal(config: LocalConfig, options: { log: (line: string) => void; webRoot?: string }): Promise<RunningLocal> {
  const { log } = options;
  prepareDataDir(config.dataDir);
  const storePath = join(config.dataDir, STORE_FILE);
  let created = false;
  const store = new Store(storePath, tablesOf(schema), {
    create: () => {
      created = true;
      return stageCredentials(config.dataDir);
    },
  });
  let adminToken: string;
  let machineSecret: string;
  try {
    const meta = (key: string) => store.meta(key);
    adminToken = settleCredential(config.dataDir, ADMIN_TOKEN_FILE, meta);
    machineSecret = settleCredential(config.dataDir, MACHINE_SECRET_FILE, meta);
    if (process.platform !== "win32") for (const f of [storePath, `${storePath}-wal`]) if (existsSync(f)) chmodSync(f, 0o600);
  } catch (error) {
    store.close();
    throw error;
  }
  log(`${created ? "created" : "opened"} local store ${store.storeId} in ${config.dataDir}`);
  // The functions read the admin token from their deployment environment, as on Convex.
  process.env.COMMS_ADMIN_TOKEN = adminToken;
  const backend = new LocalBackend(store, modules, { log });
  const stops: (() => Promise<void> | void)[] = [() => backend.close()];
  const stop = async () => {
    for (const s of stops.reverse()) await Promise.resolve(s()).catch((e: Error) => log(`stop: ${e.name}: ${e.message}`));
  };
  try {
    await bootstrap(backend, adminToken, config, machineSecret, log);
    const stopCrons = backend.startCrons(crons);
    stops.push(stopCrons);

    const web = localWebServer({ backend, adminToken, environment: config.environment, ...(options.webRoot ? { root: options.webRoot } : {}), log });
    await new Promise<void>((resolve, reject) => {
      web.once("error", reject);
      web.listen(config.web.port, "127.0.0.1", () => resolve());
    });
    stops.push(() => new Promise<void>((r) => (web.closeAllConnections(), web.close(() => r()))));
    const port = (web.address() as { port: number }).port;
    log(`web view and admin API on 127.0.0.1:${port}${options.webRoot ? "" : " (no built web view found; API only)"}`);

    if (config.adapters?.includes("t3") && config.t3) await verifyT3Binding(config.t3);
    const api = makeServerApi(backend.transport() as unknown as ConvexTransport, { machine: { id: config.machine, secret: machineSecret } });
    const connector = await startConnector({ ...config }, api, log);
    stops.push(() => connector.stop());
    return { backend, port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Idempotent, every start: this machine's credential, the owner, system participants, migrations. */
async function bootstrap(backend: LocalBackend, adminToken: string, config: LocalConfig, secret: string, log: (line: string) => void) {
  await backend.call("mutation", "directory:registerMachine", { adminToken, machineId: config.machine, secret });
  const directory = (await backend.call("query", "directory:list", { adminToken })) as { participants: { name: string; kind: string }[] };
  const owner = directory.participants.find((p) => p.name === config.owner);
  if (!owner) {
    await backend.call("mutation", "directory:promote", { adminToken, name: config.owner, kind: "human" });
    log(`created @${config.owner} (person, the default owner)`);
  } else if (owner.kind !== "human") {
    throw new Error(`"owner" @${config.owner} is a ${owner.kind}, not a person`);
  }
  const result = (await backend.call("mutation", "directory:upgrade", { adminToken, defaultOwner: config.owner })) as { alertHistoryDone: boolean };
  let done = result.alertHistoryDone;
  while (!done) done = ((await backend.call("mutation", "directory:markAlertHistory", { adminToken })) as { done: boolean }).done;
}
