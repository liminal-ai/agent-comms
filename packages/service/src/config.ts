// The service's config: an explicit mode, and nothing that belongs to the other.
//
// local:  { "mode": "local", "dataDir": "...", "owner": "lee", "web": { "port": 15990 },
//           "machine"?: "local", "environment"?: "local", "socket"?: "...",
//           "adapters"?: ["t3"], "t3"?: {...}, "leaseMs"?, "pollWaitMs"? }
// convex: { "mode": "convex", "connector": "<connector.json>", "web"?: "<web.json>" }
//         (the existing configs, unchanged)

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type ConnectorConfig, defaultSocket, expand } from "@agent-comms/connector/config";
import { NAME_PATTERN } from "@agent-comms/protocol";
import { windowsEndpoint } from "../../windows-pipe/src/index.mjs";

export interface LocalConfig {
  mode: "local";
  environment: string;
  dataDir: string;
  owner: string;
  machine: string;
  socket: string;
  web: { port: number };
  adapters?: "t3"[];
  t3?: ConnectorConfig["t3"];
  leaseMs?: number;
  pollWaitMs?: number;
}

export interface ConvexModeConfig {
  mode: "convex";
  connector: string;
  web?: string;
}

export type ServiceConfig = LocalConfig | ConvexModeConfig;

const LOCAL_KEYS = new Set(["mode", "environment", "dataDir", "owner", "machine", "socket", "web", "adapters", "t3", "leaseMs", "pollWaitMs"]);
// Fields of a Convex connector or web config: in a local config they mean it's the wrong file.
const CONVEX_ONLY = ["convexUrl", "secretFile", "adminTokenFile"];

/**
 * Windows: the current user's named pipe, kept as written (as the connector's own config
 * does): `\\.\pipe\agent-comms-<user SID>-<suffix>`. Elsewhere: a socket path.
 */
function explicitSocket(socket: string, where: string): string {
  if (process.platform !== "win32") return expand(socket);
  const base = windowsEndpoint("connector").slice(0, -"connector".length);
  if (!socket.startsWith(base) || !/^[a-z0-9-]{1,64}$/.test(socket.slice(base.length))) {
    throw new Error(`${where}: on Windows "socket" must be this user's pipe, ${base}<suffix> (suffix: lowercase letters, digits, dashes)`);
  }
  return socket;
}

export function loadServiceConfig(path: string): ServiceConfig {
  const file = expand(path);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const where = `config ${path}`;
  if (raw.mode === "convex") {
    if (typeof raw.connector !== "string") throw new Error(`${where}: convex mode needs "connector" (the connector config file)`);
    if (raw.web !== undefined && typeof raw.web !== "string") throw new Error(`${where}: convex mode's "web" is the web config file`);
    for (const k of Object.keys(raw)) if (!["mode", "connector", "web"].includes(k)) throw new Error(`${where}: convex mode doesn't use "${k}"`);
    return { mode: "convex", connector: expand(raw.connector), ...(raw.web ? { web: expand(raw.web as string) } : {}) };
  }
  if (raw.mode !== "local") throw new Error(`${where}: "mode" must be "local" or "convex"`);
  for (const k of CONVEX_ONLY) if (k in raw) throw new Error(`${where}: local mode doesn't use "${k}"; is this a Convex config?`);
  for (const k of Object.keys(raw)) if (!LOCAL_KEYS.has(k)) throw new Error(`${where}: local mode doesn't use "${k}"`);
  if (typeof raw.dataDir !== "string" || !raw.dataDir) throw new Error(`${where}: local mode needs "dataDir"`);
  const dataDir = expand(raw.dataDir);
  if (!isAbsolute(dataDir)) throw new Error(`${where}: "dataDir" must be absolute`);
  if (typeof raw.owner !== "string" || !NAME_PATTERN.test(raw.owner)) throw new Error(`${where}: "owner" must be a person's comms name (lowercase [a-z0-9_-])`);
  const machine = raw.machine ?? "local";
  if (typeof machine !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(machine)) throw new Error(`${where}: "machine" must be [A-Za-z0-9_.-], 1-64`);
  const web = raw.web as { port?: unknown } | undefined;
  // A fixed port: the admin commands find the service by it.
  if (!web || !Number.isInteger(web.port) || (web.port as number) < 1 || (web.port as number) > 65535) throw new Error(`${where}: local mode needs "web": { "port": <1-65535> } (the web view and admin API, on 127.0.0.1)`);
  const socket = raw.socket === undefined ? defaultSocket() : typeof raw.socket === "string" ? explicitSocket(raw.socket, where) : null;
  if (!socket) throw new Error(`${where}: can't work out the socket path; set "socket"`);
  const environment = raw.environment ?? "local";
  if (typeof environment !== "string" || !/^[A-Za-z0-9 _.-]{1,40}$/.test(environment)) throw new Error(`${where}: "environment" is a short label`);
  const adapters = raw.adapters as LocalConfig["adapters"];
  if (adapters !== undefined && (!Array.isArray(adapters) || adapters.some((a) => a !== "t3"))) throw new Error(`${where}: "adapters" may only list "t3"`);
  const t3 = raw.t3 as LocalConfig["t3"];
  if (adapters?.includes("t3")) {
    if (!t3 || typeof t3.baseUrl !== "string" || typeof t3.authFile !== "string") throw new Error(`${where}: the t3 adapter needs "t3": { "baseUrl", "authFile", "environmentId" }`);
    if (!t3.environmentId) throw new Error(`${where}: "t3.environmentId" is required, so the service can't bind to the wrong T3`);
    if (t3.protocol !== undefined && t3.protocol !== 1 && t3.protocol !== 2) throw new Error(`${where}: "t3.protocol" must be 1 or 2`);
  }
  for (const k of ["leaseMs", "pollWaitMs"] as const) {
    if (raw[k] !== undefined && !(Number.isInteger(raw[k]) && (raw[k] as number) > 0)) throw new Error(`${where}: "${k}" must be a positive integer`);
  }
  return {
    mode: "local",
    environment,
    dataDir,
    owner: raw.owner,
    machine,
    socket,
    web: { port: web.port as number },
    ...(adapters ? { adapters } : {}),
    ...(t3 ? { t3: { ...t3, authFile: expand(t3.authFile) } } : {}),
    ...(raw.leaseMs ? { leaseMs: raw.leaseMs as number } : {}),
    ...(raw.pollWaitMs ? { pollWaitMs: raw.pollWaitMs as number } : {}),
  };
}
