// The V2 port's acceptance kit: stock T3 on 13976, the scratch Convex on 3214 and the
// scratch connector (socket /srv/agents/cedar/tmp/v2/comms.sock). Never the live Convex
// (3240), the live connector or 3780. Reads the T3 bearer and the admin token from files;
// prints neither, and keeps no user message text.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { connectT3, type Projection } from "./t3.ts";

export const TMP = "/srv/agents/cedar/tmp/v2";
export const OUT = new URL("./raw/", import.meta.url).pathname;
export const ids = JSON.parse(readFileSync(`${TMP}/ids.json`, "utf8")) as { threads: Record<"v2ann" | "v2bob" | "v2cat", string> };
export const adminToken = readFileSync(`${TMP}/admin-token`, "utf8").trim();
export const convex = new ConvexHttpClient("http://127.0.0.1:3214");
export const t3 = await connectT3();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString();
/** Scenario requests come from @v2req (homed in Claude Code, no session): its answers wake no T3 thread. */
export const SENDER = "v2req";
export const SETTLED = ["replied", "ambiguous", "failed", "uncertain"];
export const env = { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
export const sc = (...a: string[]) => execFileSync("systemctl", ["--user", ...a], { env, encoding: "utf8" });
export const isActive = (unit: string) => {
  try {
    return sc("is-active", unit).trim();
  } catch (e) {
    return String((e as { stdout?: unknown }).stdout ?? "").trim();
  }
};

export function log(file: string, rec: Record<string, unknown>) {
  const line = JSON.stringify({ at: now(), ...rec });
  appendFileSync(`${OUT}${file}`, line + "\n");
  console.log(line);
}

/** The scratch CLI: the main connector's socket, or connector A's (each wrapper pins its socket). */
export function comms(args: string[], socket?: string) {
  if (socket && socket !== `${TMP}/comms-a.sock`) throw new Error(`no CLI wrapper for ${socket}`);
  const out = execFileSync(socket ? `${TMP}/comms-a` : `${TMP}/comms`, [...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out);
}
export const send = (conversationId: string, to: string, text: string, socket?: string) => {
  const r = comms(["send", "--as", SENDER, "--conversation", conversationId, `@${to}`, text, "--continue"], socket);
  return { messageId: r.message.id as string, deliveryId: r.deliveries[0].id as string, conversationId };
};

export const projection = async (threadId: string): Promise<Projection> => (await t3.snapshot(threadId)).projection;
const BLOCKING = ["preparing", "queued", "starting", "running", "waiting"];
export const busy = (p: Projection) => p.runs.some((r) => BLOCKING.includes(r.status));
export async function waitBusy(threadId: string, want: boolean, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (busy(await projection(threadId)) === want) return;
    await sleep(300);
  }
  throw new Error(`${threadId} never became ${want ? "busy" : "idle"}`);
}
export async function runOf(threadId: string, messageId: string) {
  return (await projection(threadId)).runs.find((r) => r.userMessageId === messageId);
}
export async function waitRun(threadId: string, messageId: string, statuses: string[], timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await runOf(threadId, messageId);
    if (r && statuses.includes(r.status)) return r;
    await sleep(300);
  }
  throw new Error(`no run for ${messageId} in ${statuses}`);
}

/** Lee types into the thread, as the web composer does: queued as its own run, steered into the running one, or restarting it. */
export async function typeIn(threadId: string, text: string, mode: "queue" | "steer" | "restart" = "queue") {
  const messageId = `lee-sim-${randomUUID()}`;
  let dispatchMode: Record<string, unknown> = { type: "start_immediately" };
  if (mode !== "queue") {
    const active = (await projection(threadId)).runs.find((r) => r.status === "running");
    if (!active) throw new Error(`nothing running in ${threadId} to ${mode}`);
    dispatchMode = { type: mode === "steer" ? "steer_active" : "restart_active", targetRunId: active.id };
  }
  await t3.call("orchestration.dispatchCommand", {
    type: "message.dispatch", commandId: randomUUID(), threadId, messageId, text, attachments: [], createdBy: "user", creationSource: "web", dispatchMode,
  });
  return messageId;
}
/** Lee presses Stop on the running run. */
export async function interrupt(threadId: string) {
  const active = (await projection(threadId)).runs.find((r) => ["starting", "running", "waiting"].includes(r.status));
  if (!active) throw new Error(`nothing to interrupt in ${threadId}`);
  await t3.call("orchestration.dispatchCommand", { type: "run.interrupt", commandId: randomUUID(), threadId, runId: active.id, reason: "V2 port acceptance" });
  return active.id;
}

/** How T3 ran our message: its user messages (must be 1), the runs it started (must be 1), and their statuses and attempts. */
export async function runsFor(threadId: string, messageId: string) {
  const p = await projection(threadId);
  const runs = p.runs.filter((r) => r.userMessageId === messageId);
  return {
    ourMessages: p.messages.filter((m) => m.id === messageId).length,
    runs: runs.map((r) => ({ id: r.id, status: r.status, attempts: p.attempts.filter((a) => a.runId === r.id).map((a) => `${a.reason}:${a.status}`) })),
    foreignInOurRun: runs.length ? p.messages.filter((m) => m.role === "user" && m.runId === runs[0]!.id && m.id !== messageId).length : 0,
  };
}

export async function view(conversationId: string) {
  return (await convex.query("conversations:view" as never, { adminToken, conversationId, limit: 500 } as never)) as {
    messages: { message: { id: string; inReplyTo?: string; collectedFrom?: string; text: string; sender: { name: string } }; deliveries: { id: string; state: string; detail?: string; recipient?: { name: string } }[] }[];
  };
}
export async function delivery(conversationId: string, messageId: string) {
  return (await view(conversationId)).messages.find((m) => m.message.id === messageId)?.deliveries[0];
}
export async function waitState(conversationId: string, messageId: string, states: string[], timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  let d;
  while (Date.now() < end) {
    d = await delivery(conversationId, messageId);
    if (d && states.includes(d.state)) return d;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${states}; last ${JSON.stringify(d)}`);
}
export const answers = async (s: { conversationId: string; messageId: string }) =>
  (await view(s.conversationId)).messages
    .filter((m) => m.message.inReplyTo === s.messageId)
    .map((m) => ({ from: m.message.sender.name, collected: !!m.message.collectedFrom, text: m.message.text.slice(0, 120) }));
export async function group(title: string, members: string[]) {
  return ((await convex.mutation("conversations:createGroup" as never, { adminToken, title, members } as never)) as { conversation: { id: string } }).conversation.id;
}

/**
 * While `ms` runs: approves a pending approval only if the one unfinished command in the
 * thread's active run is exactly `expected`; declines any other. Never approves anything else.
 */
export async function approveOnly(threadId: string, expected: string, ms: number) {
  const seen: { input: string | null; decision: string }[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = (await projection(threadId)) as unknown as Projection & { runtimeRequests?: { id: string; status: string }[] };
    const active = p.runs.find((r) => ["starting", "running", "waiting"].includes(r.status));
    if (!active && seen.length) break;
    for (const req of (p.runtimeRequests ?? []).filter((r) => r.status === "pending")) {
      const open = p.turnItems.filter((i) => i.runId === active?.id && i.type === "command_execution" && !["completed", "failed", "declined", "cancelled", "interrupted"].includes(String((i as { status?: string }).status)));
      const input = open.length === 1 ? String((open[0] as { input?: string }).input) : null;
      const decision = input === expected ? "accept" : "decline";
      await t3.call("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId: randomUUID(), threadId, requestId: req.id, decision });
      seen.push({ input: input === expected ? input : input === null ? null : "<other>", decision });
    }
    await sleep(1000);
  }
  return seen;
}
