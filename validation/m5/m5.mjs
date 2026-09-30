// M5 checks that need agents acting on their own: an agent-initiated request,
// Lee's group post to two agents, and typed-in → notice → the agent's comms reply.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "/srv/agents/cedar/agent-comms/node_modules/convex/dist/esm/browser/index.js";
import { answersTo, deliveryOf, log, send, sleep, typeIn, view, waitBusy, waitState } from "./t3-live.mjs";

const adminToken = readFileSync("/srv/agents/cedar/secrets/admin-token", "utf8").trim();
const convex = new ConvexHttpClient("http://127.0.0.1:3240");
const which = process.argv[2] ?? "all";
const out = {};

const comms = (...args) =>
  JSON.parse(execFileSync("/home/leemoore/.local/bin/comms", [...args, "--json"], { encoding: "utf8" }));

async function allMessages() {
  const { conversations } = await convex.query("conversations:list", { adminToken });
  const all = [];
  for (const c of conversations) for (const m of (await view(c.id)).messages) all.push({ conversation: c, ...m });
  return all;
}

async function until(what, f, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await f();
    if (v) return v;
    await sleep(3000);
  }
  throw new Error(`timed out: ${what}`);
}

if (which === "all" || which === "agent") {
  log("--- agent-initiated request, answer back, no loop");
  const marker = `PRIVATE-${Date.now()}`;
  await waitBusy("t3-codex", false);
  await typeIn(
    "t3-codex",
    `(private note for you only: ${marker}) Please use the comms CLI from your shell. Run exactly:\ncomms send --as t3-codex @t3-native "M5 check: what is 17 times 23? Reply with just the number."\nThen tell me what it printed.`,
  );
  const request = await until("t3-codex's request", async () =>
    (await allMessages()).find((m) => m.message.sender.name === "t3-codex" && m.message.text.startsWith("M5 check: what is 17 times 23")),
  );
  const sent = { messageId: request.message.id, conversationId: request.message.conversationId };
  const d = await waitState(sent, "t3-native", ["replied", "ambiguous", "failed", "uncertain"]);
  const answers = await answersTo(sent);
  const answerMsg = (await view(sent.conversationId)).messages.find((m) => m.message.inReplyTo === sent.messageId && m.message.collectedFrom);
  const answerDelivery = answerMsg && (await until("answer delivered to t3-codex", async () => {
    const x = await deliveryOf({ messageId: answerMsg.message.id, conversationId: sent.conversationId }, "t3-codex");
    return x && x.state !== "pending" && x.state !== "claimed" ? x : undefined;
  }));
  log("answer delivered; watching 90 s for any loop");
  await sleep(90_000);
  const after = (await view(sent.conversationId)).messages;
  const everything = await allMessages();
  out.agent = {
    requestDelivery: d.state,
    answers,
    answerDelivery: answerDelivery?.state,
    messagesInConversation: after.length,
    collectedFromAnswer: after.filter((m) => answerMsg && m.message.inReplyTo === answerMsg.message.id).length,
    privateMarkerInConvex: everything.some((m) => m.message.text.includes(marker)),
  };
  log(JSON.stringify(out.agent));
}

if (which === "all" || which === "group") {
  log("--- Lee's group post addressing two agents");
  const g = await convex.mutation("conversations:createGroup", { adminToken, title: `m5 group ${new Date().toISOString().slice(11, 19)}`, members: ["lee", "t3-native", "t3-lhc", "t3-codex"] });
  const post = await convex.mutation("conversations:postAs", {
    adminToken, as: "lee", conversationId: g.conversation.id, to: ["t3-native", "t3-lhc"], text: "M5 group check: reply with your comms name only.",
  });
  const sent = { messageId: post.message.id, conversationId: g.conversation.id };
  const states = {};
  for (const who of ["t3-native", "t3-lhc"]) states[who] = (await waitState(sent, who, ["replied", "ambiguous", "failed", "uncertain"])).state;
  const v = await view(g.conversation.id);
  out.group = {
    deliveries: post.deliveries.map((x) => x.recipient),
    states,
    answers: v.messages.filter((m) => m.message.inReplyTo === sent.messageId).map((m) => ({ from: m.message.sender.name, text: m.message.text, linked: true })),
    codexWoken: v.messages.some((m) => m.deliveries.some((x) => x.recipient === "t3-codex")),
  };
  log(JSON.stringify(out.group));
}

if (which === "all" || which === "typed") {
  log("--- typed-in → ambiguous → notice → agent's comms reply");
  await waitBusy("t3-lhc", false);
  const s = send("smoke-a", "t3-lhc", "M5 typed-in check: run the shell command `sleep 15` in the foreground, then reply with exactly: TYPED-M5");
  await waitState(s, "t3-lhc", ["delivered"], 60_000);
  await sleep(4000);
  await typeIn("t3-lhc", "Quick aside while you work: what's 2+2?");
  const d = await waitState(s, "t3-lhc", ["ambiguous", "replied", "failed", "uncertain"]);
  log(`first: ${d.state} ${d.detail ?? ""}`);
  let final = d;
  if (d.state === "ambiguous") final = await waitState(s, "t3-lhc", ["replied"], 300_000).catch(() => d);
  out.typed = { first: d.state, final: final.state, detail: final.detail ?? null, answers: await answersTo(s) };
  log(JSON.stringify(out.typed));
}

console.log(JSON.stringify(out, null, 1));
