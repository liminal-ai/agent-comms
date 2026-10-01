// Acceptance item 11, web side (read-only): the alerts Cedar's item 11 raised show in the
// installed web view's Alerts tab and as unread notices from @alerts in Lee's inbox.
// Usage: node item11-web.mjs <base> <out-dir>. Marks nothing read.
import { chromium } from "/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs";

const [base, out] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString(), ...a);
let failed = 0;
const check = (ok, what) => (log(ok ? "PASS" : "FAIL", what), ok || failed++);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
try {
  await page.goto(base);
  await page.waitForSelector(".registry li");
  await page.waitForTimeout(1500);
  log("title:", await page.title());

  await page.locator(".side-tabs button", { hasText: "Alerts" }).click();
  await page.locator(".pane.side h2", { hasText: "Alerts" }).waitFor();
  log("alerts tab label:", await page.locator(".side-tabs button", { hasText: "Alerts" }).innerText());
  const open = await page.locator(".alerts li.open").allInnerTexts();
  log("open alerts:", open.length);
  for (const t of open) log("  open:", t.replace(/\s+/g, " "));
  const details = page.locator("details", { hasText: "resolved" });
  if (await details.count()) {
    await details.first().locator("summary").click();
    const resolved = await page.locator(".alerts li.resolved").allInnerTexts();
    log("resolved alerts:", resolved.length);
    for (const t of resolved) log("  resolved:", t.replace(/\s+/g, " "));
    check(resolved.some((t) => t.startsWith("Uncertain delivery")), "11a: the uncertain-delivery alert is listed, resolved");
  }
  const all = await page.locator(".alerts li[data-alert]").allInnerTexts();
  check(all.filter((t) => t.startsWith("Connector silent")).length >= 2, "11b: the connector-silent incidents are listed (stop, start, stop)");
  await page.screenshot({ path: `${out}/item11-1-alerts.png`, fullPage: true });

  await page.locator(".side-tabs button", { hasText: "Inbox" }).click();
  await page.locator(".inbox").waitFor();
  const items = await page.locator(".inbox li", { has: page.locator(".tag.alert") }).evaluateAll((els) =>
    els.map((e) => ({ unread: e.classList.contains("unread"), text: e.innerText.replace(/\s+/g, " ") })),
  );
  log("inbox alert items:", items.length);
  for (const i of items) log(`  ${i.unread ? "UNREAD" : "read  "} ${i.text.slice(0, 200)}`);
  check(items.length >= 3 && items.some((i) => i.unread), "the alerts are in Lee's inbox from @alerts, labelled Alert, unread");
  await page.screenshot({ path: `${out}/item11-2-inbox.png`, fullPage: true });
} catch (e) {
  failed++;
  log("ERROR", e.message);
} finally {
  await browser.close();
}
log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
