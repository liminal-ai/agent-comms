// Section 5 kit (T3 side). Reads the T3 bearer and the admin token from files; prints neither.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "/srv/work/agent-comms/node_modules/convex/dist/esm/browser/index.js";

export const T3 = "http://127.0.0.1:3780";
export const HOME = process.env.HOME;
const t3Token = () => readFileSync(`${HOME}/.config/agent-comms/t3-3780.token`, "utf8").trim();
export const adminToken = readFileSync(`${HOME}/.config/agent-comms/admin-token`, "utf8").trim();
export const convex = new ConvexHttpClient("http://127.0.0.1:3240");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString();
export const OUT = new URL(".", import.meta.url).pathname;

export function log(file, rec) {
  const line = JSON.stringify({ at: now(), ...rec });
  appendFileSync(`${OUT}${file}`, line + "\n");
  console.log(line);
}

export async function t3(path, body) {
  const r = await fetch(`${T3}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${t3Token()}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
export const thread = async (id, turnLimit) => (await t3(`/api/orchestration/threads/${id}${turnLimit ? `?turnLimit=${turnLimit}` : ""}`)).thread;

/** Someone other than comms sends a message into the thread (what the web UI sends). */
export async function typeIn(threadId, text) {
  const t = await thread(threadId, 1);
  const messageId = `lee-sim-${randomUUID()}`;
  await t3("/api/orchestration/dispatch", {
    type: "thread.turn.start", commandId: randomUUID(), threadId,
    message: { messageId, role: "user", text, attachments: [] },
    runtimeMode: t.runtimeMode, interactionMode: t.interactionMode, createdAt: now(),
  });
  return messageId;
}
export const interrupt = (threadId) => t3("/api/orchestration/dispatch", { type: "thread.turn.interrupt", commandId: randomUUID(), threadId, createdAt: now() });

export async function waitBusy(threadId, busy, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await thread(threadId, 1);
    if ((!!t.session && ["running", "starting"].includes(t.session.status)) === busy) return;
    await sleep(300);
  }
  throw new Error(`${threadId} never became ${busy ? "busy" : "idle"}`);
}

export function comms(...args) {
  const out = execFileSync(`${HOME}/.local/bin/comms`, [...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out);
}

export async function view(conversationId) {
  return convex.query("conversations:view", { adminToken, conversationId, limit: 500 });
}
export async function delivery(conversationId, messageId) {
  return (await view(conversationId)).messages.find((m) => m.message.id === messageId)?.deliveries[0];
}
export async function waitState(conversationId, messageId, states, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  let d;
  while (Date.now() < end) {
    d = await delivery(conversationId, messageId);
    if (d && states.includes(d.state)) return d;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${states}; last ${JSON.stringify(d)}`);
}
export const SETTLED = ["replied", "ambiguous", "failed", "uncertain"];

export async function group(title, members) {
  return (await convex.mutation("conversations:createGroup", { adminToken, title, members })).conversation.id;
}

/** Turns in the thread whose start was our message (T3 records the starter's createdAt as requestedAt), and our message count. */
export async function turnsFor(threadId, messageId) {
  const t = await thread(threadId);
  const ours = t.messages.filter((m) => m.id === messageId);
  return { ourMessages: ours.length, latestTurnIsOurs: !!ours[0] && t.latestTurn?.requestedAt === ours[0].createdAt, assistantTurnsAfterOurs: [...new Set(t.messages.filter((m) => ours[0] && m.role === "assistant" && m.createdAt > ours[0].createdAt).map((m) => m.turnId))] };
}
