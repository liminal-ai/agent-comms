// agent-wake-relay's configuration: one JSON file listing the agents to wake.
// It names files for every secret (machine secrets, webhook URLs and keys) and
// holds none itself.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NAME_PATTERN, parseDuration } from "@agent-comms/protocol";
import { WAKER_KINDS, type WakerConfig } from "./wakers.ts";

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

export interface WakeConfigFile {
  convexUrl: string;
  targets: TargetConfigFile[];
}

export interface Target {
  participant: string;
  machine: string;
  machineSecretFile: string;
  waker: WakerConfig;
  renudgeMs: number;
}

export interface WakeConfig {
  convexUrl: string;
  targets: Target[];
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

function duration(value: number | string | undefined, what: string, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "number" || /^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new ConfigError(`${what}: expected a non-negative number of milliseconds`);
    return n;
  }
  const ms = parseDuration(value);
  if (ms === null) throw new ConfigError(`${what}: expected milliseconds or <n>s|m|h|d, got "${value}"`);
  return ms;
}

export function parseConfig(raw: unknown): WakeConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError("expected a JSON object");
  const c = raw as Partial<WakeConfigFile>;
  if (typeof c.convexUrl !== "string" || !/^https?:\/\//.test(c.convexUrl)) throw new ConfigError("convexUrl: expected an http(s) URL");
  if (!Array.isArray(c.targets) || !c.targets.length) throw new ConfigError("targets: expected at least one");
  const seen = new Set<string>();
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
    const waker: WakerConfig = {
      kind: "webhook",
      urlFile: file(w.urlFile, `${at}.waker.urlFile`),
      ...(w.bearerKeyFile ? { bearerKeyFile: file(w.bearerKeyFile, `${at}.waker.bearerKeyFile`) } : {}),
      ...(w.timeoutMs !== undefined ? { timeoutMs: duration(w.timeoutMs, `${at}.waker.timeoutMs`, 10_000) } : {}),
    };
    return {
      participant: t.participant,
      machine: t.machine,
      machineSecretFile: file(t.machineSecretFile, `${at}.machineSecretFile`),
      waker,
      renudgeMs: duration(t.renudgeAfter, `${at}.renudgeAfter`, 10 * 60_000),
    };
  });
  return { convexUrl: c.convexUrl, targets };
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
