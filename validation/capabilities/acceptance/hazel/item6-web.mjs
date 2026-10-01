// Acceptance item 6, web side: term-a's message to @owner is unread in Lee's inbox
// in the installed web view until its conversation is opened. Usage: node item6-web.mjs <base> <out-dir> <text-fragment>
import { chromium } from "/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs";

const [base, out, fragment] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString(), ...a);
let failed = 0;
const check = (ok, what) => (log(ok ? "PASS" : "FAIL", what), ok || failed++);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const count = async () => Number(/^\((\d+)\)/.exec(await page.title())?.[1] ?? 0);
try {
  await page.goto(base);
  await page.waitForSelector(".registry li");
  await page.waitForFunction(() => /^\(\d+\)/.test(document.title), null, { timeout: 10_000 });
  const before = await count();
  log("title:", await page.title(), "| pill:", await page.locator(".unread-pill").innerText());
  await page.locator(".side-tabs button", { hasText: "Inbox" }).click();
  const item = page.locator(".inbox li", { hasText: fragment }).first();
  await item.waitFor();
  log("inbox item:", (await item.innerText()).replace(/\s+/g, " "), "| class:", await item.getAttribute("class"));
  check((await item.getAttribute("class")) === "unread", "the message is unread in @lee's inbox");
  await page.screenshot({ path: `${out}/item6-1-unread.png` });
  // Reload: still unread (nothing marks it read but opening it).
  await page.reload();
  await page.waitForSelector(".registry li");
  await page.locator(".side-tabs button", { hasText: "Inbox" }).click();
  check((await page.locator(".inbox li.unread", { hasText: fragment }).count()) === 1, "still unread after a reload");
  // Open its conversation from the Conversations list.
  await page.locator(".convs li", { hasText: "@term-a · @lee" }).first().click();
  await page.locator(".messages li", { hasText: fragment }).waitFor();
  await page.waitForFunction((n) => !document.title.startsWith(`(${n})`), before, { timeout: 10_000 });
  log("after opening, title:", await page.title());
  check((await count()) === before - 1, "opening the conversation marked it read (count down by one)");
  check((await page.locator(".inbox li.unread", { hasText: fragment }).count()) === 0, "no longer unread in the inbox");
  await page.screenshot({ path: `${out}/item6-2-opened.png` });
} catch (e) {
  failed++;
  log("ERROR", e.message);
} finally {
  await browser.close();
}
log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
