// W live check against R1: system participants and owners in the registry, promotion
// with an owner through the form, and Lee's inbox (unread count up on a send to @owner,
// down when the conversation is opened or the item is clicked). Usage:
//   node live-r1.mjs <base-url> <out-dir>
// Promotes @hazel-w (a Claude Code home with no terminal) and retires it at the end.
import { execFileSync } from "node:child_process";
import { chromium } from "/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs";

const [base = "http://127.0.0.1:3791", out = "."] = process.argv.slice(2);
const COMMS = `${process.env.HOME}/.config/agent-comms/terminal-bin/comms`;
const NAME = "hazel-w";
const log = (...a) => console.log(new Date().toISOString(), ...a);
const comms = (...args) => {
  log("$ comms", args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" "));
  const text = execFileSync(COMMS, args, { encoding: "utf8" });
  log(text.trim());
  return text;
};
let failed = 0;
const check = (ok, what) => {
  log(ok ? "PASS" : "FAIL", what);
  if (!ok) failed++;
};

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("dialog", async (d) => {
  log("dialog:", d.type(), JSON.stringify(d.message()));
  await d.accept();
});
page.on("pageerror", (e) => log("PAGE ERROR:", e.message));
const side = (name) => page.locator(".side-tabs button", { hasText: name }).first();
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const unread = async () => {
  const t = await page.title();
  return Number(/^\((\d+)\)/.exec(t)?.[1] ?? 0);
};

try {
  await page.goto(base);
  await page.waitForSelector(".registry li");

  // Registry: system participants and owners.
  const groups = await page.locator(".pane.side h3.group").allTextContents();
  log("registry groups:", groups.join(", "));
  const sys = page.locator('.registry li[data-name="reminders"], .registry li[data-name="alerts"]');
  check((await sys.count()) === 2, "@reminders and @alerts are listed (System)");
  check((await sys.locator("button").count()) === 0, "system participants have no controls");
  const termA = (await page.locator('.registry li[data-name="term-a"]').innerText()).replace(/\s+/g, " ");
  log("term-a row:", termA);
  check(termA.includes("owner @lee"), "agents show their owner (@lee after the backfill)");
  await shot("r1-1-registry");

  // Promote @hazel-w through the form, owned by @lee.
  if ((await page.locator(`.registry li[data-name="${NAME}"]`).count()) === 0) {
    const f = page.locator("form.card", { hasText: "Promote an agent" });
    await f.locator('input[placeholder="cedar"]').fill(NAME);
    await f.locator("select").first().selectOption("claude-code");
    await f.getByRole("button", { name: "Promote" }).click();
    await f.locator(".ok, .error").first().waitFor();
    const note = await f.locator(".ok, .error").first().innerText();
    log("promote:", note);
    check(note.includes("owned by @lee"), "promoted through the form with owner @lee");
  }
  const row = page.locator(`.registry li[data-name="${NAME}"]`);
  await row.waitFor();
  log(`${NAME} row:`, (await row.innerText()).replace(/\s+/g, " "));

  // @owner lands in Lee's inbox: the count goes up.
  const before = await unread();
  log("unread before:", before);
  const sent1 = comms("send", "--as", NAME, "@owner", "W inbox check 1: opening the conversation should mark this read.");
  check(/@lee: in their inbox/.test(sent1), "comms send @owner says it's in @lee's inbox");
  await page.waitForFunction((n) => document.title.startsWith(`(${n})`), before + 1, { timeout: 15_000 });
  check((await unread()) === before + 1, `title shows (${before + 1})`);
  await side("Inbox").click();
  const item = page.locator(".inbox li.unread", { hasText: "W inbox check 1" }).first();
  await item.waitFor();
  check((await page.locator(".side-tabs button", { hasText: "Inbox (" }).count()) === 1, "the Inbox tab carries the count");
  check((await page.locator(".unread-pill").innerText()).includes(`${before + 1} unread`), "the header pill carries the count");
  await shot("r1-2-inbox-unread");

  // Opening the conversation (from the Conversations list) marks it read.
  const conv = page.locator(".convs li", { hasText: `@${NAME}` }).first();
  await conv.click();
  await page.locator(".messages li", { hasText: "W inbox check 1" }).waitFor();
  await page.waitForFunction((n) => !document.title.startsWith(`(${n + 1})`), before, { timeout: 15_000 });
  check((await unread()) === before, "opening the conversation marked it read");
  check((await page.locator(".inbox li.unread", { hasText: "W inbox check 1" }).count()) === 0, "the inbox item is no longer unread");
  await shot("r1-3-opened-read");

  // A message arriving while that conversation is open is read at once.
  comms("send", "--as", NAME, "@owner", "W inbox check 2: arrives while the conversation is open.");
  await page.locator(".messages li", { hasText: "W inbox check 2" }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  check((await unread()) === before, "a message arriving in the open conversation doesn't stay unread");

  // Clicking an unread inbox item marks it read and opens its conversation.
  await page.locator(".convs li", { hasText: "No conversations" }).count(); // no-op
  await page.locator(".pane.conversation").evaluate(() => {}); // keep layout
  await page.goto(base); // nothing selected: no conversation open
  await page.waitForSelector(".registry li");
  comms("send", "--as", NAME, "@owner", "W inbox check 3: clicking this in the inbox should open it and mark it read.");
  await page.waitForFunction((n) => document.title.startsWith(`(${n})`), before + 1, { timeout: 15_000 });
  await side("Inbox").click();
  const item3 = page.locator(".inbox li.unread", { hasText: "W inbox check 3" }).first();
  await item3.waitFor();
  await item3.click();
  await page.locator(".messages li", { hasText: "W inbox check 3" }).waitFor();
  await page.waitForFunction((n) => !document.title.startsWith(`(${n + 1})`), before, { timeout: 15_000 });
  check((await unread()) === before, "clicking the inbox item opened it and marked it read");
  await shot("r1-4-clicked-read");

  // Clean up: retire the test agent.
  await side("Agents").click();
  await page.locator(`.registry li[data-name="${NAME}"]`).getByRole("button", { name: "Retire" }).click();
  await page.waitForTimeout(800);
  check((await page.locator(".registry li", { hasText: `@${NAME}` }).first().getAttribute("class"))?.includes("state-retired") ?? false, `@${NAME} retired`);
} catch (e) {
  failed++;
  log("ERROR", e.message);
  await shot("r1-error").catch(() => {});
} finally {
  await browser.close();
}
log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
