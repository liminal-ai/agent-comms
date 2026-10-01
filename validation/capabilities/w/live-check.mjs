// W live check: the web view's registry, reminders, inbox and alerts against the
// local Convex deployment, in headless Chrome. Usage: node live-check.mjs <base-url> <out-dir>
// Leaves no reminder able to fire (the one it creates is cancelled) and restores
// the alert thresholds it changes. Logs each step; screenshots in <out-dir>.
import { chromium } from "/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs";

const [base = "http://127.0.0.1:3791", out = "."] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("dialog", async (d) => {
  log("dialog:", d.type(), JSON.stringify(d.message()));
  await (d.type() === "prompt" ? d.accept("waiting on a test") : d.accept());
});
page.on("pageerror", (e) => log("PAGE ERROR:", e.message));
const side = (name) => page.locator(".side-tabs button", { hasText: name }).first();
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
let failed = 0;
const check = (ok, what) => {
  log(ok ? "PASS" : "FAIL", what);
  if (!ok) failed++;
};

try {
  await page.goto(base);
  await page.waitForSelector(".registry li");
  log("title:", await page.title());

  // Registry: groups, presence, an edit that persists through Convex.
  const groups = await page.locator(".pane.side h3.group").allTextContents();
  log("registry groups:", groups.join(", "));
  // System participants are created at deploy from R1/R3 on; before that there are none.
  const system = await page.locator('.registry li[data-name="reminders"], .registry li[data-name="alerts"]').count();
  if (groups.includes("System")) check(system === 2, "@reminders and @alerts are listed under System");
  else log("no system participants deployed yet (R1/R3)");
  const termA = page.locator('.registry li[data-name="term-a"]');
  log("term-a row:", (await termA.innerText()).replace(/\s+/g, " "));
  await termA.getByRole("button", { name: "Edit" }).click();
  await termA.locator("input").fill("Test terminal for the Claude Code mod (Hazel's live checks).");
  await termA.locator("textarea").fill("Answers requests from the mod's live checks\nRuns in manual permission mode");
  await termA.getByRole("button", { name: "Save" }).click();
  await termA.locator(".duties li").first().waitFor();
  check((await termA.locator(".duties li").count()) === 2, "term-a shows its description and two duties after saving");
  // A refused edit never reaches Convex.
  await termA.getByRole("button", { name: "Edit" }).click();
  await termA.locator("input").fill("x".repeat(201));
  await termA.getByRole("button", { name: "Save" }).click();
  check((await termA.locator(".error").innerText()).includes("at most 200"), "an over-long description is refused in the form");
  await termA.getByRole("button", { name: "Close" }).click();
  await shot("1-registry");

  // Inbox: the badge and title carry the unread count.
  await side("Inbox").click();
  await page.waitForSelector(".pane.side h2");
  log("inbox heading:", await page.locator(".pane.side h2").innerText());
  log("inbox items:", await page.locator(".inbox li").count(), "unread:", await page.locator(".inbox li.unread").count());
  await shot("2-inbox");

  // Reminders: create (as @lee), pause, block, history, cancel.
  await side("Reminders").click();
  const form = page.locator("form.card", { hasText: "New reminder" });
  await form.locator('input[placeholder="@reed"]').fill("@term-a");
  await form.locator("textarea").fill("W live check: this reminder is cancelled before it can fire.");
  await form.locator('input[placeholder="30m"]').fill("30s");
  await form.getByRole("button", { name: "Set reminder" }).click();
  check((await form.locator(".error").innerText()).includes("at least 1m"), "a 30s interval is refused in the form");
  await form.locator('input[placeholder="30m"]').fill("45m");
  await form.locator("summary").click();
  await form.locator('input[placeholder="ci"]').fill("w-live-check");
  await form.locator('input[placeholder="fires"]').fill("3");
  await form.getByRole("button", { name: "Set reminder" }).click();
  await form.locator(".ok").waitFor();
  log("created:", await form.locator(".ok").innerText());
  const row = page.locator(".reminders li.reminder", { hasText: "w-live-check" }).first();
  log("reminder row:", (await row.innerText()).replace(/\s+/g, " "));
  check((await row.innerText()).includes("every 45m, at most 3 fires"), "the schedule reads every 45m, at most 3 fires");
  await row.getByRole("button", { name: "Pause" }).click();
  await row.locator(".badge.r-paused").waitFor();
  check(true, "paused");
  await row.getByRole("button", { name: "Resume" }).click();
  await row.locator(".badge.r-active").waitFor();
  await row.getByRole("button", { name: "Blocked…" }).click();
  await row.locator(".badge.r-blocked").waitFor();
  log("blocked row:", (await row.innerText()).replace(/\s+/g, " "));
  check((await row.innerText()).includes("blocked: waiting on a test"), "blocked with its reason");
  await row.getByRole("button", { name: "History" }).click();
  await row.locator(".history li").first().waitFor();
  log("history:", (await row.locator(".history").innerText()).replace(/\s+/g, " "));
  await shot("3-reminders");
  await row.getByRole("button", { name: "Cancel" }).click();
  const ended = page.locator("details", { hasText: "ended" }).first();
  await ended.waitFor();
  await ended.locator("summary").click();
  const endedRow = ended.locator("li.reminder", { hasText: "w-live-check" }).first();
  await endedRow.locator(".badge.r-cancelled").waitFor();
  check((await endedRow.locator(".actions button").allTextContents()).every((t) => /history/i.test(t)), "a cancelled reminder offers no controls, only its history");
  await shot("4-reminder-cancelled");

  // Alerts: list and thresholds (changed, then restored).
  await side("Alerts").click();
  const settings = page.locator("form.card", { hasText: "Alert thresholds" });
  await settings.waitFor();
  const silent = settings.locator("input").first();
  const before = await silent.inputValue();
  log("alerts listed:", await page.locator(".alerts li[data-alert]").count(), "connector silent threshold:", before, "min");
  await silent.fill("1");
  await settings.getByRole("button", { name: "Save" }).click();
  check((await settings.locator(".error").innerText()).includes("2 minutes"), "a 1-minute connector threshold is refused in the form");
  await silent.fill("12");
  await settings.getByRole("button", { name: "Save" }).click();
  await settings.locator(".ok").waitFor();
  check(true, "threshold saved through alerts.setConfig");
  await silent.fill(before);
  await settings.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(500);
  log("threshold restored to", await silent.inputValue());
  await shot("5-alerts");

  // Phone: one pane at a time, the side tabs in the header.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("header nav button", { hasText: "Reminders" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".pane.side").isVisible(), "phone: the reminders pane shows from the header");
  check(!(await page.locator(".pane.conversations").isVisible()), "phone: conversations hidden meanwhile");
  await shot("6-phone-reminders");
} catch (e) {
  failed++;
  log("ERROR", e.message);
  await shot("error").catch(() => {});
} finally {
  await browser.close();
}
log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
