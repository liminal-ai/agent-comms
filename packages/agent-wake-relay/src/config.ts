// agent-wake-relay's configuration: one JSON file listing the agents to wake,
// and the MCP server to host when any of them is woken by MCP Events. It names
// files for every secret (machine secrets, webhook URLs and keys, the WorkOS
// API key) and holds none itself.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NAME_PATTERN, parseDuration } from "@agent-comms/protocol";
import { eventName, WAKER_KINDS, type WakerConfig } from "./wakers.ts";

export interface TargetConfigFile {
  /** The agent to wake. */
  participant: string;
  /** The machine the agent is homed on, and a file holding that machine's secret. Used read-only, to watch its work. */
  machine: string;
  machineSecretFile: string;
  waker: WakerConfig;
  /** Wake again if a delivery is still outstanding this long after the last wake (ms or `<n>s|m|h`). Default 10m; 0 turns it off. */
  renudgeAfter?: number | string;
}

/** The MCP server ChatGPT connects to for the `mcp-events` waker. */
export interface McpConfigFile {
  /** Where to listen. Default host 127.0.0.1; Tailscale Funnel (or another proxy) makes it public. */
  listen: { host?: string; port: number };
  /** The public https origin clients use, e.g. `https://lim-builder.tailb30114.ts.net` (Funnel on :443). The MCP endpoint (and OAuth resource) is `<this>/mcp`. */
  publicBaseUrl: string;
  /** The OAuth authorization server (AuthKit domain), e.g. `https://<name>.authkit.app`. */
  issuer: string;
  /** Default `<issuer>/oauth2/jwks`. */
  jwksUrl?: string;
  /** A file holding a WorkOS API key, used to look up a token subject's email. Required with allowedEmails. */
  workosApiKeyFile?: string;
  /** Who may use the server: WorkOS users with one of these verified emails, or these token subjects. */
  allowedEmails?: string[];
  allowedSubjects?: string[];
  /** Where subscriptions are kept (mode 600; it holds their signing secrets). Its directory must exist. */
  stateFile: string;
  /** Longest subscription granted (ms or `<n>s|m|h|d`). Default 30d. */
  maxSubscriptionTtl?: number | string;
}

export interface WakeConfigFile {
  convexUrl: string;
  targets: TargetConfigFile[];
  mcp?: McpConfigFile;
}

export interface Target {
  participant: string;
  machine: string;
  machineSecretFile: string;
  waker: WakerConfig;
  renudgeMs: number;
}

export interface McpConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  issuer: string;
  jwksUrl: string;
  workosApiKeyFile?: string;
  allowedEmails: string[];
  allowedSubjects: string[];
  stateFile: string;
  maxTtlMs: number;
}

export interface WakeConfig {
  convexUrl: string;
  targets: Target[];
  mcp?: McpConfig;
}

export class ConfigError extends Error {}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p);
}

function file(p: unknown, what: string): string {
  if (typeof p !== "string" || !p) throw new ConfigError(`${what}: expected a file path`);
  const path = expandHome(p);
  if (!existsSync(path)) throw new ConfigError(`${what}: ${path} doesn't exist`);
  return path;
}

const MAX_TIMER_MS = 2_147_483_647;

/** `maxMs` bounds durations that back a Node timer (which can't wait longer than ~24.8 days). */
function duration(value: number | string | undefined, what: string, fallback: number, maxMs = Infinity): number {
  const ms = durationValue(value, what, fallback);
  if (ms > maxMs) throw new ConfigError(`${what}: at most ${Math.floor(maxMs / 86_400_000)} days`);
  return ms;
}

function durationValue(value: number | string | undefined, what: string, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "number" || /^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new ConfigError(`${what}: expected a non-negative number of milliseconds`);
    return n;
  }
  const ms = parseDuration(value);
  if (ms === null) throw new ConfigError(`${what}: expected milliseconds or <n>s|m|h|d, got "${value}"`);
  if (!Number.isSafeInteger(ms)) throw new ConfigError(`${what}: too large`);
  return ms;
}

export function parseConfig(raw: unknown): WakeConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError("expected a JSON object");
  const c = raw as Partial<WakeConfigFile>;
  if (typeof c.convexUrl !== "string" || !/^https?:\/\//.test(c.convexUrl)) throw new ConfigError("convexUrl: expected an http(s) URL");
  if (!Array.isArray(c.targets) || !c.targets.length) throw new ConfigError("targets: expected at least one");
  const seen = new Set<string>();
  const events = new Set<string>();
  const targets = c.targets.map((t, i): Target => {
    const at = `targets[${i}]`;
    if (typeof t?.participant !== "string" || !NAME_PATTERN.test(t.participant)) throw new ConfigError(`${at}.participant: expected a comms name`);
    if (seen.has(t.participant)) throw new ConfigError(`${at}.participant: @${t.participant} is listed twice`);
    seen.add(t.participant);
    if (typeof t.machine !== "string" || !t.machine) throw new ConfigError(`${at}.machine: expected a machine id`);
    const w = t.waker as Partial<WakerConfig> | undefined;
    if (!w || !WAKER_KINDS.includes(w.kind as (typeof WAKER_KINDS)[number])) {
      throw new ConfigError(`${at}.waker.kind: expected one of ${WAKER_KINDS.join(", ")}`);
    }
    let waker: WakerConfig;
    if (w.kind === "mcp-events") {
      const event = eventName(t.participant, w as { kind: "mcp-events"; event?: string });
      if (typeof event !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(event)) throw new ConfigError(`${at}.waker.event: expected a name of letters, digits, ".", "_" and "-"`);
      if (events.has(event)) throw new ConfigError(`${at}.waker.event: ${event} is used twice`);
      events.add(event);
      waker = { kind: "mcp-events", event };
    } else {
      const h = w as Partial<Extract<WakerConfig, { kind: "webhook" }>>;
      waker = {
        kind: "webhook",
        urlFile: file(h.urlFile, `${at}.waker.urlFile`),
        ...(h.bearerKeyFile ? { bearerKeyFile: file(h.bearerKeyFile, `${at}.waker.bearerKeyFile`) } : {}),
        ...(h.timeoutMs !== undefined ? { timeoutMs: duration(h.timeoutMs, `${at}.waker.timeoutMs`, 10_000, MAX_TIMER_MS) } : {}),
      };
    }
    return {
      participant: t.participant,
      machine: t.machine,
      machineSecretFile: file(t.machineSecretFile, `${at}.machineSecretFile`),
      waker,
      renudgeMs: duration(t.renudgeAfter, `${at}.renudgeAfter`, 10 * 60_000, MAX_TIMER_MS),
    };
  });
  const mcp = c.mcp === undefined ? undefined : parseMcp(c.mcp);
  if (!mcp && events.size) throw new ConfigError("mcp: required when a target uses the mcp-events waker");
  return { convexUrl: c.convexUrl, targets, ...(mcp ? { mcp } : {}) };
}

function httpsUrl(value: unknown, what: string): string {
  let u: URL;
  try {
    u = new URL(String(value));
  } catch {
    throw new ConfigError(`${what}: expected an https URL`);
  }
  if (u.protocol !== "https:" || u.search || u.hash) throw new ConfigError(`${what}: expected an https URL without query or fragment`);
  return String(value).replace(/\/+$/, "");
}

function strings(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) throw new ConfigError(`${what}: expected a list of strings`);
  return value as string[];
}

function parseMcp(raw: unknown): McpConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError("mcp: expected an object");
  const m = raw as Partial<McpConfigFile>;
  const port = m.listen?.port;
  if (!Number.isInteger(port) || port! < 1 || port! > 65_535) throw new ConfigError("mcp.listen.port: expected a port number");
  const host = m.listen?.host ?? "127.0.0.1";
  if (typeof host !== "string" || !host) throw new ConfigError("mcp.listen.host: expected a host");
  const issuer = httpsUrl(m.issuer, "mcp.issuer");
  const allowedEmails = strings(m.allowedEmails, "mcp.allowedEmails");
  const allowedSubjects = strings(m.allowedSubjects, "mcp.allowedSubjects");
  if (!allowedEmails.length && !allowedSubjects.length) throw new ConfigError("mcp: allowedEmails or allowedSubjects must name who may use it");
  if (allowedEmails.length && !m.workosApiKeyFile) throw new ConfigError("mcp.workosApiKeyFile: required with allowedEmails");
  if (typeof m.stateFile !== "string" || !m.stateFile) throw new ConfigError("mcp.stateFile: expected a file path");
  const stateFile = expandHome(m.stateFile);
  // Capped so now + ttl is always a representable timestamp (and a sane grant).
  const maxTtlMs = duration(m.maxSubscriptionTtl, "mcp.maxSubscriptionTtl", 30 * 86_400_000, 366 * 86_400_000);
  if (maxTtlMs < 60_000) throw new ConfigError("mcp.maxSubscriptionTtl: expected at least a minute");
  const publicBaseUrl = httpsUrl(m.publicBaseUrl, "mcp.publicBaseUrl");
  if (new URL(publicBaseUrl).pathname !== "/") throw new ConfigError("mcp.publicBaseUrl: expected an origin without a path (the MCP endpoint is <origin>/mcp)");
  if (!existsSync(dirname(stateFile))) throw new ConfigError(`mcp.stateFile: ${dirname(stateFile)} doesn't exist`);
  return {
    host,
    port: port!,
    publicBaseUrl,
    issuer,
    jwksUrl: m.jwksUrl === undefined ? `${issuer}/oauth2/jwks` : httpsUrl(m.jwksUrl, "mcp.jwksUrl"),
    ...(m.workosApiKeyFile ? { workosApiKeyFile: file(m.workosApiKeyFile, "mcp.workosApiKeyFile") } : {}),
    allowedEmails,
    allowedSubjects,
    stateFile,
    maxTtlMs,
  };
}

export function loadConfig(path: string): WakeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
  try {
    return parseConfig(raw);
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
}
