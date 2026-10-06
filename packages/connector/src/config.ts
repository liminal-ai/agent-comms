import { windowsEndpoint } from '../../windows-pipe/src/index.mjs';
import { readPrivateWindowsSecret } from '../../windows-pipe/src/secret.mjs';
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
    /** T3's orchestration protocol: 1 for v0.0.44 (the default), 2 from v0.0.46. */
    protocol?: 1 | 2;
    /** Stable ID from /.well-known/t3/environment; refuses a different server. */
    environmentId?: string;
  };
}

export async function verifyT3Binding(t3: NonNullable<ConnectorConfig["t3"]>, request: typeof fetch = fetch): Promise<void> {
  if (!t3.environmentId) return;
  const base = t3.baseUrl.replace(/^ws/, "http").replace(/\/$/, "");
  const descriptor = await request(`${base}/.well-known/t3/environment`, { signal: AbortSignal.timeout(10_000) });
  if (!descriptor.ok || (await descriptor.json() as { environmentId?: string }).environmentId !== t3.environmentId) {
    throw new Error("T3 environment identity mismatch; refusing to connect");
  }
  const token = (process.platform === "win32" ? readPrivateWindowsSecret(expand(t3.authFile)) : readFileSync(expand(t3.authFile), "utf8")).trim();
  const session = await request(`${base}/api/auth/session`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!session.ok || (await session.json() as { authenticated?: boolean }).authenticated !== true) {
    throw new Error("T3 credential rejected for the configured environment");
  }
}

/** The per-user default: $AGENT_COMMS_SOCKET, else the platform's standard path (Windows: the current user's pipe). */
export function defaultSocket(): string | null {
  if (process.platform === "win32") return process.env[SOCKET_ENV] ?? windowsEndpoint();
  return socketPath({
    platform: process.platform,
    override: process.env[SOCKET_ENV],
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    home: homedir(),
    uid: process.getuid?.(),
  });
}

export interface LoadedConfig extends ConnectorConfig {
  socket: string;
  secret: string;
  warnings: string[];
}

export const expand = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));

export function loadConfig(path: string): LoadedConfig {
  const raw = JSON.parse(readFileSync(expand(path), "utf8")) as Partial<ConnectorConfig> & { mode?: unknown };
  if (raw.mode === "local") throw new Error(`config ${path}: this is a local-mode service config; run it with service.mjs, not the connector`);
  if (raw.mode !== undefined && raw.mode !== "convex") throw new Error(`config ${path}: "mode" must be "convex" for the connector`);
  for (const key of ["machine", "secretFile", "convexUrl"] as const) {
    if (typeof raw[key] !== "string" || !raw[key]) throw new Error(`config ${path}: "${key}" is required`);
  }
  const config = raw as ConnectorConfig;
  const warnings: string[] = [];
  const secretFile = expand(config.secretFile);
  const mode = statSync(secretFile).mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077)) warnings.push(`${secretFile} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  const secret = (process.platform === "win32" ? readPrivateWindowsSecret(secretFile) : readFileSync(secretFile, "utf8")).trim();
  if (secret.length < 16) throw new Error(`${secretFile}: the machine secret must be at least 16 characters`);
  const socket = config.socket ?? defaultSocket();
  if (!socket) throw new Error(`can't work out the socket path; set "socket" in ${path}`);
  if (config.t3?.protocol !== undefined && config.t3.protocol !== 1 && config.t3.protocol !== 2) {
    throw new Error(`config ${path}: "t3.protocol" must be 1 or 2`);
  }
  const t3 = config.t3 ? { ...config.t3, authFile: expand(config.t3.authFile) } : undefined;
  return { ...config, ...(t3 ? { t3 } : {}), secretFile, secret, socket, warnings };
}
