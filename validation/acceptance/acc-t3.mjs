// Shared acceptance check, T3 side (items 2a, 4, 5). Marker PRIVATE-ACC in everything typed directly.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "/srv/agents/cedar/agent-comms/node_modules/convex/dist/esm/browser/index.js";
import { answersTo, log, sleep, typeIn, view, waitBusy, waitState } from "./t3-live.mjs";

const adminToken = readFileSync("/srv/agents/cedar/secrets/admin-token", "utf8").trim();
const convex = new ConvexHttpClient("http://127.0.0.1:3240");
const which = process.argv[2] ?? "all";
const out = {};
const comms = (...a) => JSON.parse(execFileSync("/home/leemoore/.local/bin/comms", [...a, "--json"], { encoding: "utf8" }));
async function allMessages() {
  const { conversations } = await convex.query("conversations:list", { adminToken });
  const all = [];
  for (const c of conversations) for (const m of (await view(c.id)).messages) all.push(m);
  return all;
}
async function until(what, f, ms = 300_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await f(); if (v) return v; await sleep(3000); }
  throw new Error(`timed out: ${what}`);
}
const settled = ["replied", "ambiguous", "failed", "uncertain"];

if (which === "all" || which === "2a") {
  log("--- 2a: t3-native asks t3-lhc from its shell");
  await waitBusy("t3-native", false);
  await typeIn("t3-native", `(private, PRIVATE-ACC) Please run exactly this in your shell and tell me what it printed:\ncomms send --as t3-native @t3-lhc "Acceptance 2a: what is the capital of Australia? One word."`);
  const req = await until("request", async () => (await allMessages()).find((m) => m.message.sender.name === "t3-native" && m.message.text.startsWith("Acceptance 2a")));
  const sent = { messageId: req.message.id, conversationId: req.message.conversationId };
  const d = await waitState(sent, "t3-lhc", settled);
  out["2a"] = { state: d.state, answers: await answersTo(sent) };
  log(JSON.stringify(out["2a"]));
}

if (which === "all" || which === "4") {
  log("--- 4: typed into a running comms turn (t3-native)");
  await waitBusy("t3-native", false);
  const r = comms("send", "--as", "t3-codex", "@t3-native", "Acceptance 4: run the shell command `sleep 15` in the foreground, then reply with exactly: ACC-4");
  const sent = { messageId: r.message.id, conversationId: r.message.conversationId };
  await waitState(sent, "t3-native", ["delivered"], 60_000);
  await sleep(4000);
  await typeIn("t3-native", "(PRIVATE-ACC) quick aside: what's 3+3?");
  const first = await waitState(sent, "t3-native", settled);
  let final = first;
  if (first.state === "ambiguous") final = await waitState(sent, "t3-native", ["replied"], 300_000).catch(() => first);
  out["4"] = { first: first.state, final: final.state, detail: final.detail ?? null, answers: await answersTo(sent) };
  log(JSON.stringify(out["4"]));
}

if (which === "all" || which === "5") {
  log("--- 5: an answer that needs the agent's own work (t3-lhc, shell)");
  await waitBusy("t3-lhc", false);
  const r = comms("send", "--as", "t3-codex", "@t3-lhc", "Acceptance 5: run `ls /srv/work/agent-comms/packages | wc -l` in your shell and reply with just the number it prints.");
  const sent = { messageId: r.message.id, conversationId: r.message.conversationId };
  const d = await waitState(sent, "t3-lhc", settled);
  out["5"] = { state: d.state, detail: d.detail ?? null, answers: await answersTo(sent), expected: execFileSync("sh", ["-c", "ls /srv/work/agent-comms/packages | wc -l"], { encoding: "utf8" }).trim() };
  log(JSON.stringify(out["5"]));
}

console.log(JSON.stringify(out, null, 1));
