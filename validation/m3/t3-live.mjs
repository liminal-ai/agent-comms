// Live M3 scenarios against Hazel's T3 on 3780 through the real connector.
// Reads the T3 bearer and the Convex admin token from files; prints neither,
// and prints no thread text except our own test answers.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "/srv/agents/cedar/agent-comms/node_modules/convex/dist/esm/browser/index.js";

const REPO = "/srv/agents/cedar/agent-comms";
const T3 = "http://127.0.0.1:3780";
const t3Token = readFileSync(process.env.HOME + "/.config/agent-comms/t3-3780.token", "utf8").trim();
const adminToken = readFileSync("/srv/agents/cedar/secrets/admin-token", "utf8").trim();
const convex = new ConvexHttpClient("http://127.0.0.1:3240");
const THREADS = {
  "t3-native": "thr-2b9246c9-4806-4d5d-bff5-3dca6ede7d49",
  "t3-lhc": "thr-36b7d422-6756-4668-b4fa-96e40d3679b6",
  "t3-codex": "thr-abad70c6-298e-445d-9570-aae607cea3fb",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function send(as, to, text) {
  const out = execFileSync("node", [`${REPO}/packages/comms-cli/src/main.ts`, "send", "--as", as, `@${to}`, text, "--json"], {
    env: { ...process.env, AGENT_COMMS_SOCKET: "/srv/agents/cedar/smoke/run/agent-comms/connector.sock" },
    encoding: "utf8",
  });
  const r = JSON.parse(out);
  return { messageId: r.message.id, conversationId: r.message.conversationId, deliveryId: r.deliveries[0].id };
}

export async function view(conversationId) {
  return convex.query("conversations:view", { adminToken, conversationId });
}

export async function deliveryOf(sent, recipient) {
  const v = await view(sent.conversationId);
  const m = v.messages.find((x) => x.message.id === sent.messageId);
  return m?.deliveries.find((d) => d.recipient === recipient);
}

export async function answersTo(sent) {
  const v = await view(sent.conversationId);
  return v.messages.filter((x) => x.message.inReplyTo === sent.messageId).map((x) => ({ text: x.message.text, collected: !!x.message.collectedFrom }));
}

export async function waitState(sent, recipient, states, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let d;
  while (Date.now() < deadline) {
    d = await deliveryOf(sent, recipient);
    if (d && states.includes(d.state)) return d;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${states.join("|")}; last ${JSON.stringify(d)}`);
}

async function t3(path, body) {
  const r = await fetch(`${T3}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${t3Token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function thread(name) {
  return (await t3(`/api/orchestration/threads/${THREADS[name]}?turnLimit=3`)).thread;
}

/** Someone other than comms sends a user message into the thread (as Lee would from the UI). */
export async function typeIn(name, text) {
  const t = await thread(name);
  await t3("/api/orchestration/dispatch", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId: THREADS[name],
    message: { messageId: `lee-sim-${randomUUID()}`, role: "user", text, attachments: [] },
    runtimeMode: t.runtimeMode,
    interactionMode: t.interactionMode,
    createdAt: new Date().toISOString(),
  });
}

export async function interrupt(name) {
  await t3("/api/orchestration/dispatch", { type: "thread.turn.interrupt", commandId: randomUUID(), threadId: THREADS[name], createdAt: new Date().toISOString() });
}

export async function waitBusy(name, busy, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await thread(name);
    const isBusy = !!t.session && ["running", "starting"].includes(t.session.status);
    if (isBusy === busy) return;
    await sleep(500);
  }
  throw new Error(`${name} never became ${busy ? "busy" : "idle"}`);
}

export { log, sleep };
