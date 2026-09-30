// Shared acceptance items 2b (check), 2c and 3 (web view).
import { readFileSync } from "node:fs";
import { chromium } from "/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs";
import { ConvexHttpClient } from "/srv/agents/cedar/agent-comms/node_modules/convex/dist/esm/browser/index.js";
import { answersTo, log, sleep, typeIn, view, waitBusy, waitState } from "./t3-live.mjs";

const adminToken = readFileSync("/srv/agents/cedar/secrets/admin-token", "utf8").trim();
const convex = new ConvexHttpClient("http://127.0.0.1:3240");
const since = Date.parse(process.argv[2] ?? "2026-09-30T23:19:00Z");
const settled = ["replied", "ambiguous", "failed", "uncertain"];
const out = {};
async function allMessages() {
  const { conversations } = await convex.query("conversations:list", { adminToken });
  const all = [];
  for (const c of conversations) for (const m of (await view(c.id)).messages) all.push(m);
  return all;
}
async function until(what, f, ms = 400_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await f(); if (v) return v; await sleep(3000); }
  throw new Error(`timed out: ${what}`);
}

// 2b: Hazel prompts cc-a; we verify.
log("--- 2b: cc-a → t3-native");
const req2b = await until("cc-a's request", async () =>
  (await allMessages()).find((m) => m.message.sender.name === "cc-a" && m.message.kind === "request" && m.message.recipients.some((r) => r.name === "t3-native") && m.message.createdAt > since));
const s2b = { messageId: req2b.message.id, conversationId: req2b.message.conversationId };
out["2b"] = { request: req2b.message.text.slice(0, 80), state: (await waitState(s2b, "t3-native", settled)).state, answers: await answersTo(s2b) };
log(JSON.stringify(out["2b"]));

// 2c: t3-lhc → cc-a
log("--- 2c: t3-lhc → cc-a");
await waitBusy("t3-lhc", false);
await typeIn("t3-lhc", `(private, PRIVATE-ACC) Please run exactly this in your shell and tell me what it printed:\ncomms send --as t3-lhc @cc-a "Acceptance 2c: what is 12 squared? Just the number."`);
const req2c = await until("t3-lhc's request", async () => (await allMessages()).find((m) => m.message.sender.name === "t3-lhc" && m.message.text.startsWith("Acceptance 2c")));
const s2c = { messageId: req2c.message.id, conversationId: req2c.message.conversationId };
out["2c"] = { state: (await waitState(s2c, "cc-a", settled)).state, answers: await answersTo(s2c) };
log(JSON.stringify(out["2c"]));

// 3: Lee's group, created and posted in the web view.
log("--- 3: Lee's group in the web view");
const title = `acceptance ${new Date().toISOString().slice(11, 19)}`;
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3790/");
await page.getByLabel("Title").fill(title);
await page.getByLabel("Members").fill("@lee @t3-native @t3-lhc @cc-a");
await page.getByRole("button", { name: "Create" }).click();
await page.getByPlaceholder("Message; @name wakes that member").fill("@t3-lhc @cc-a Acceptance 3: reply with your comms name only.");
await page.getByText("wakes @t3-lhc, @cc-a").waitFor({ timeout: 5000 });
await page.getByRole("button", { name: "Send" }).click();
const post = await until("Lee's post", async () => (await allMessages()).find((m) => m.message.sender.name === "lee" && m.message.text.includes("Acceptance 3")));
const s3 = { messageId: post.message.id, conversationId: post.message.conversationId };
const states = {};
for (const who of ["t3-lhc", "cc-a"]) states[who] = (await waitState(s3, who, settled)).state;
await page.waitForTimeout(2000);
await page.screenshot({ path: "/srv/agents/cedar/agent-comms/validation/acceptance/3-group.png" });
await browser.close();
const v = await view(s3.conversationId);
out["3"] = {
  woken: post.deliveries.map((d) => d.recipient),
  states,
  replies: v.messages.filter((m) => m.message.inReplyTo === s3.messageId).map((m) => ({ from: m.message.sender.name, text: m.message.text })),
  nativeWoken: v.messages.some((m) => m.deliveries.some((d) => d.recipient === "t3-native")),
};
log(JSON.stringify(out["3"]));
console.log(JSON.stringify(out, null, 1));
