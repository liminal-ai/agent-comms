// 4.2 step: promote a Claude Code terminal participant from the web view (headless Chrome).
import { appendFileSync } from "node:fs";
import { chromium } from "/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs";
const OUT = new URL(".", import.meta.url).pathname;
const name = process.argv[2];
const rec = (r) => { const l = JSON.stringify({ at: new Date().toISOString(), ...r }); appendFileSync(`${OUT}web.jsonl`, l + "\n"); console.log(l); };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3790/");
await page.getByLabel("Name").waitFor();
const exists = await page.getByText(`@${name}`).count();
if (!exists) {
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Lives in").selectOption("claude-code");
  await page.getByRole("button", { name: "Promote" }).click();
  await page.getByText(`@${name}`).first().waitFor();
}
const note = exists ? null : await page.locator("form.card p").first().textContent();
await page.waitForTimeout(1500);
const row = page.locator(".people li", { hasText: `@${name}` }).first();
rec({ step: process.argv[3] ?? "promote", name, alreadyPromoted: exists > 0, promoteNote: note, row: await row.textContent(), dot: await row.locator(".dot").getAttribute("class") });
await page.screenshot({ path: `${OUT}web-${process.argv[3] ?? "promote"}.png` });
await browser.close();
