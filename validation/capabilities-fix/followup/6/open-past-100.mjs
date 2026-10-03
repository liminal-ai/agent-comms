// Follow-up 6, live, on a SCRATCH deployment only: with a conversation of more than 100 messages
// open in the web view as @lee, a new message from @pat must be marked read at once (the view's
// list stays at 100, so a key on the count never changes).
// Usage: node open-past-100.mjs <web-base> <convex-url> <admin-token-file> <out-dir>
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "/srv/agents/hazel/agent-comms/node_modules/convex/dist/esm/browser/index.js";
import { anyApi } from "/srv/agents/hazel/agent-comms/node_modules/convex/dist/esm/server/index.js";
import { chromium } from "/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs";

const [base, convexUrl, tokenFile, out = "."] = process.argv.slice(2);
if (!convexUrl || /:3240\b/.test(convexUrl)) throw new Error("scratch deployment only (not 127.0.0.1:3240)");
const adminToken = readFileSync(tokenFile, "utf8").trim();
const client = new ConvexHttpClient(convexUrl);
const log = (...a) => console.log(new Date().toISOString(), ...a);
let failed = 0;
const check = (ok, what) => (log(ok ? "PASS" : "FAIL", what), ok || failed++);
const unread = async () => (await client.query(anyApi.inbox.unreadCount, { adminToken, human: "lee" })).unread;

const { conversation: dm } = await client.mutation(anyApi.conversations.openDm, { adminToken, a: "pat", b: "lee" });
const conv = (await client.query(anyApi.conversations.list, { adminToken })).conversations.find((c) => c.id === dm.id);
log("the @pat/@lee DM has", conv?.lastSeq, "messages");
check((conv?.lastSeq ?? 0) > 100, "the conversation is past 100 messages");
await client.mutation(anyApi.inbox.markRead, { adminToken, human: "lee", all: true });
check((await unread()) === 0, "nothing unread to start");

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
try {
  await page.addInitScript(([t]) => { localStorage.setItem("agent-comms.adminToken", t); localStorage.setItem("agent-comms.as", "lee"); }, [adminToken]);
  await page.goto(base);
  await page.waitForSelector(".convs li");
  await page.locator(".convs li", { hasText: "@pat · @lee" }).first().click();
  await page.locator(".messages li").first().waitFor();
  log("messages shown:", await page.locator(".messages li.msg").count());
  for (const n of [1, 2]) {
    const text = `follow-up 6 check ${n} ${Date.now()}`;
    await client.mutation(anyApi.conversations.postAs, { adminToken, as: "pat", conversationId: dm.id, to: ["lee"], text });
    await page.locator(".messages li", { hasText: text }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(2000);
    check((await unread()) === 0, `new message ${n} arrived in the open conversation and was marked read (unread ${await unread()})`);
  }
  await page.screenshot({ path: `${out}/open-past-100.png` });
} catch (e) {
  failed++;
  log("ERROR", e.message);
} finally {
  await browser.close();
}
log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
