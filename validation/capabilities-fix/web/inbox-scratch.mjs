// Fix pass 2, web inbox (Alder's 101-message case), on a SCRATCH deployment only.
// Seeds 210 unread messages to @lee from @pat: the oldest 60 in a group, the newest 150 in
// their DM, so the group's rows all fall past the first page. Then, in the web view:
//   1. the oldest message is reachable (older pages, or unread-only);
//   2. opening the group from the Conversations list marks all 60 of its rows read;
//   3. "Mark all read" marks every remaining unread row, not only those shown.
// Usage: node inbox-scratch.mjs <web-base> <convex-url> <admin-token-file> <out-dir>
// Refuses to run against the live deployment (127.0.0.1:3240).
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

// Seed (idempotent by checking the count first).
const people = (await client.query(anyApi.directory.list, { adminToken })).participants.map((p) => p.name);
for (const name of ["lee", "pat"]) if (!people.includes(name)) await client.mutation(anyApi.directory.promote, { adminToken, name, kind: "human" });
await client.mutation(anyApi.inbox.markRead, { adminToken, human: "lee", all: true }).catch(() => {});
const { conversation: group } = await client.mutation(anyApi.conversations.createGroup, { adminToken, title: `inbox-test ${Date.now()}`, members: ["lee", "pat"] });
for (let i = 0; i < 60; i++) await client.mutation(anyApi.conversations.postAs, { adminToken, as: "pat", conversationId: group.id, to: ["lee"], text: `group ${i}` });
const { conversation: dm } = await client.mutation(anyApi.conversations.openDm, { adminToken, a: "pat", b: "lee" });
for (let i = 0; i < 150; i++) await client.mutation(anyApi.conversations.postAs, { adminToken, as: "pat", conversationId: dm.id, to: ["lee"], text: `dm ${i}` });
log("seeded; unread:", await unread());
check((await unread()) === 210, "210 unread to start");

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("dialog", (d) => d.accept());
try {
  await page.addInitScript(([t]) => localStorage.setItem("agent-comms.adminToken", t), [adminToken]);
  await page.goto(base);
  await page.waitForSelector(".registry li, .side-tabs");
  await page.locator(".side-tabs button", { hasText: "Inbox" }).click();
  await page.locator(".inbox li").first().waitFor();

  // 1. The oldest message is reachable.
  for (let i = 0; i < 10 && (await page.locator(".inbox li", { hasText: "group 0" }).count()) === 0; i++) {
    const older = page.getByRole("button", { name: /older/i });
    if ((await older.count()) === 0) break;
    await older.first().click();
    await page.waitForTimeout(500);
  }
  check((await page.locator(".inbox li.unread", { hasText: /^.*group 0$/m }).count()) >= 1, "1: the oldest unread message (group 0) is reachable in the inbox");
  await page.screenshot({ path: `${out}/inbox-1-oldest.png` });

  // 2. Opening the group marks every one of its rows read.
  await page.locator(".convs li", { hasText: group.title ?? "inbox-test" }).first().click();
  await page.locator(".messages li", { hasText: "group 59" }).waitFor();
  await page.waitForTimeout(1500);
  check((await unread()) === 150, `2: opening the group marked its 60 rows read (unread now ${await unread()})`);

  // 3. Mark all read marks everything.
  await page.locator(".side-tabs button", { hasText: "Inbox" }).click();
  await page.getByRole("button", { name: "Mark all read" }).click();
  await page.waitForTimeout(1500);
  check((await unread()) === 0, `3: mark all read left nothing unread (unread now ${await unread()})`);
  await page.screenshot({ path: `${out}/inbox-3-all-read.png` });
} catch (e) {
  failed++;
  log("ERROR", e.message);
} finally {
  await browser.close();
}
log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
