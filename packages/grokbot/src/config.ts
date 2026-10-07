// The bridge's configuration: defaults, then a JSON file, then environment
// variables, then command-line flags. Nothing in it is secret: the connector
// holds the machine credential, and the bridge only talks to the local socket.
// A wake webhook that needs a credential names a file holding it.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_POLL_WAIT_MS, NAME_PATTERN, parseDuration } from "@agent-comms/protocol";
import { defaultSocketPath } from "./client.ts";

/** What may appear in the config file. Durations are milliseconds or `<n>s|m|h|d`. */
export interface GrokbotConfigFile {
  /** The comms participant the bridge registers as. Default "grok". */
  participant?: string;
  /** The connector's socket. Default: `$AGENT_COMMS_SOCKET`, else the per-user path. */
  socket?: string;
  /** Where the bridge keeps its state. Default `~/.grok-comms`. */
  home?: string;
  /** Where deliveries are written. Default `<home>/inbox`. */
  inboxDir?: string;
  /** The harness session id to register with. Default: one generated once and kept in `<home>/state.json`. */
  sessionId?: string;
  /** Reported as the session's working directory. Default: `home`. */
  cwd?: string;
  /** How long each poll is held (at most 25000). Default 25000. */
  pollWaitMs?: number | string;
  /** A request not answered within this is reported `ambiguous`. Default 20m. */
  answerTimeout?: number | string;
  /** POSTs a small JSON event here when a delivery arrives or times out. Off by default. */
  wakeWebhook?: { url: string; includeText?: boolean; timeoutMs?: number; authorizationFile?: string } | string;
  /** Unregister the session when the daemon stops. Default false: a restart keeps its session. */
  unregisterOnExit?: boolean;
}

export interface GrokbotConfig {
  participant: string;
  socket: string;
  home: string;
  inboxDir: string;
  outboxDir: string;
  logFile: string;
  stateFile: string;
  lockFile: string;
  sessionId?: string;
  cwd: string;
  pollWaitMs: number;
  answerTimeoutMs: number;
  /** `authorizationFile` holds the whole Authorization header value (e.g. `Bearer …`); it's read at each wake. */
  wakeWebhook?: { url: string; includeText: boolean; timeoutMs: number; authorizationFile?: string };
  unregisterOnExit: boolean;
  /** The config file that was read, if any. */
  configFile?: string;
}

export const DEFAULT_PARTICIPANT = "grok";
export const DEFAULT_ANSWER_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_HOME_DIR = ".grok-comms";

/** The environment variables the bridge reads. */
export const ENV = {
  config: "GROKBOT_CONFIG",
  participant: "GROKBOT_PARTICIPANT",
  home: "GROKBOT_HOME",
  inboxDir: "GROKBOT_INBOX_DIR",
  sessionId: "GROKBOT_SESSION_ID",
  cwd: "GROKBOT_CWD",
  pollWaitMs: "GROKBOT_POLL_WAIT_MS",
  answerTimeout: "GROKBOT_ANSWER_TIMEOUT",
  wakeWebhookUrl: "GROKBOT_WAKE_WEBHOOK_URL",
  wakeIncludeText: "GROKBOT_WAKE_INCLUDE_TEXT",
  wakeAuthorizationFile: "GROKBOT_WAKE_AUTHORIZATION_FILE",
} as const;

export interface ConfigOverrides {
  config?: string;
  participant?: string;
  socket?: string;
  home?: string;
}

export class ConfigError extends Error {}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p);
}

function duration(value: number | string | undefined, what: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number" || /^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new ConfigError(`${what}: expected a non-negative number of milliseconds`);
    return n;
  }
  const ms = parseDuration(value);
  if (ms === null) throw new ConfigError(`${what}: expected milliseconds or <n>s|m|h|d, got "${value}"`);
  return ms;
}

/** Resolves the configuration. `env` is usually `process.env`. */
export function loadConfig(env: Record<string, string | undefined>, overrides: ConfigOverrides = {}): GrokbotConfig {
  const homeHint = expandHome(overrides.home ?? env[ENV.home] ?? join(homedir(), DEFAULT_HOME_DIR));
  const explicit = overrides.config ?? env[ENV.config];
  const configFile = explicit ? expandHome(explicit) : join(homeHint, "config.json");
  let file: GrokbotConfigFile = {};
  if (existsSync(configFile)) {
    try {
      file = JSON.parse(readFileSync(configFile, "utf8")) as GrokbotConfigFile;
    } catch (error) {
      throw new ConfigError(`${configFile}: ${(error as Error).message}`);
    }
    if (typeof file !== "object" || file === null || Array.isArray(file)) throw new ConfigError(`${configFile}: expected a JSON object`);
  } else if (explicit) {
    throw new ConfigError(`config file ${configFile} doesn't exist`);
  }

  const home = expandHome(overrides.home ?? env[ENV.home] ?? file.home ?? join(homedir(), DEFAULT_HOME_DIR));
  const participant = overrides.participant ?? env[ENV.participant] ?? file.participant ?? DEFAULT_PARTICIPANT;
  if (!NAME_PATTERN.test(participant)) throw new ConfigError(`participant "${participant}" isn't a comms name (lowercase [a-z0-9_-], 1-48)`);

  const socket = overrides.socket ?? (env.AGENT_COMMS_SOCKET || undefined) ?? file.socket ?? defaultSocketPath(env);
  if (!socket) throw new ConfigError("can't work out the connector socket; set AGENT_COMMS_SOCKET or \"socket\" in the config");

  const pollWaitMs = duration(env[ENV.pollWaitMs] ?? file.pollWaitMs, "pollWaitMs") ?? MAX_POLL_WAIT_MS;
  if (pollWaitMs > MAX_POLL_WAIT_MS) throw new ConfigError(`pollWaitMs: at most ${MAX_POLL_WAIT_MS}`);
  const answerTimeoutMs = duration(env[ENV.answerTimeout] ?? file.answerTimeout, "answerTimeout") ?? DEFAULT_ANSWER_TIMEOUT_MS;
  if (answerTimeoutMs < 1) throw new ConfigError("answerTimeout: must be positive");

  const hook = typeof file.wakeWebhook === "string" ? { url: file.wakeWebhook } : file.wakeWebhook;
  const hookUrl = env[ENV.wakeWebhookUrl] ?? hook?.url;
  let wakeWebhook: GrokbotConfig["wakeWebhook"];
  if (hookUrl) {
    let parsed: URL;
    try {
      parsed = new URL(hookUrl);
    } catch {
      throw new ConfigError(`wakeWebhook: "${hookUrl}" isn't a URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ConfigError("wakeWebhook: only http and https URLs");
    const includeEnv = env[ENV.wakeIncludeText];
    const authFile = env[ENV.wakeAuthorizationFile] || hook?.authorizationFile;
    const authorizationFile = authFile ? expandHome(authFile) : undefined;
    if (authorizationFile && !existsSync(authorizationFile)) throw new ConfigError(`wakeWebhook: authorizationFile ${authorizationFile} doesn't exist`);
    // A credential over plain http would travel in cleartext; allow it only to this machine.
    if (authorizationFile && parsed.protocol === "http:" && !isLoopback(parsed.hostname))
      throw new ConfigError("wakeWebhook: authorizationFile needs an https URL (plain http is allowed only to localhost)");
    wakeWebhook = {
      url: parsed.toString(),
      includeText: includeEnv !== undefined ? /^(1|true|yes)$/i.test(includeEnv) : hook?.includeText === true,
      timeoutMs: hook?.timeoutMs ?? 5_000,
      ...(authorizationFile ? { authorizationFile } : {}),
    };
  }

  const inboxDir = expandHome(env[ENV.inboxDir] ?? file.inboxDir ?? join(home, "inbox"));
  const sessionId = env[ENV.sessionId] ?? file.sessionId;
  return {
    participant,
    socket,
    home,
    inboxDir,
    outboxDir: join(home, "outbox"),
    logFile: join(home, "log.jsonl"),
    stateFile: join(home, "state.json"),
    lockFile: join(home, "daemon.lock"),
    ...(sessionId ? { sessionId } : {}),
    cwd: expandHome(env[ENV.cwd] ?? file.cwd ?? home),
    pollWaitMs,
    answerTimeoutMs,
    ...(wakeWebhook ? { wakeWebhook } : {}),
    unregisterOnExit: file.unregisterOnExit === true,
    ...(existsSync(configFile) ? { configFile } : {}),
  };
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}
