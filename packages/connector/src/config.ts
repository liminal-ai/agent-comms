// The connector's config file. The machine secret lives in its own file,
// referenced by path, so the config can be shown without showing the secret.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SOCKET_ENV, socketPath } from "@agent-comms/protocol";

export interface ConnectorConfig {
  /** This machine's id, as registered with `directory:registerMachine`. */
  machine: string;
  /** File holding the machine's connector secret (mode 0600). */
  secretFile: string;
  /** The Convex deployment URL, e.g. http://127.0.0.1:3240 for the local deployment. */
  convexUrl: string;
  /** Default: the per-user path (see the protocol's `socketPath`). */
  socket?: string;
  leaseMs?: number;
  pollWaitMs?: number;
  /** Harness adapters to load besides Claude Code's, which is always on. */
  adapters?: "t3"[];
  t3?: {
    /** e.g. ws://127.0.0.1:3780 */
    baseUrl: string;
    /** File holding the bearer credential for T3 (mode 0600). */
    authFile: string;
  };
}

export interface LoadedConfig extends ConnectorConfig {
  socket: string;
  secret: string;
  warnings: string[];
}

const expand = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));

export function loadConfig(path: string): LoadedConfig {
  const raw = JSON.parse(readFileSync(expand(path), "utf8")) as Partial<ConnectorConfig>;
  for (const key of ["machine", "secretFile", "convexUrl"] as const) {
    if (typeof raw[key] !== "string" || !raw[key]) throw new Error(`config ${path}: "${key}" is required`);
  }
  const config = raw as ConnectorConfig;
  const warnings: string[] = [];
  const secretFile = expand(config.secretFile);
  const mode = statSync(secretFile).mode & 0o777;
  if (mode & 0o077) warnings.push(`${secretFile} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  const secret = readFileSync(secretFile, "utf8").trim();
  if (secret.length < 16) throw new Error(`${secretFile}: the machine secret must be at least 16 characters`);
  const socket =
    config.socket ??
    socketPath({
      platform: process.platform,
      override: process.env[SOCKET_ENV],
      xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
      home: homedir(),
      uid: process.getuid?.(),
    });
  if (!socket) throw new Error(`can't work out the socket path; set "socket" in ${path}`);
  const t3 = config.t3 ? { ...config.t3, authFile: expand(config.t3.authFile) } : undefined;
  return { ...config, ...(t3 ? { t3 } : {}), secretFile, secret, socket, warnings };
}
