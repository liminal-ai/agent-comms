// Section 5: the web workflow end to end, in headless Chrome against the real installation.
import { appendFileSync } from "node:fs";
import { chromium } from "/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs";
const OUT = new URL(".", import.meta.url).pathname;
const rec = (r) => { const l = JSON.stringify({ at: new Date().toISOString(), ...r }); appendFileSync(`${OUT}results-web.jsonl`, l + "\n"); console.log(l); };
const suffix = Date.now().toString(36).slice(-5);
const term = `fp1-term-${suffix}`;
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3790/");
await page.getByText("@fp1-codex").first().waitFor();
// Promote a terminal agent.
await page.getByLabel("Name").fill(term);
await page.getByLabel("Lives in").selectOption("claude-code");
await page.getByRole("button", { name: "Promote" }).click();
const note = await page.locator("form.card p").first().textContent();
await page.getByText(`@${term}`).first().waitFor();
await page.waitForTimeout(1500);
const row = await page.locator(".people li", { hasText: `@${term}` }).first();
const termRow = { dot: await row.locator(".dot").getAttribute("class"), text: await row.locator(".muted").textContent() };
await page.screenshot({ path: `${OUT}web-1-promoted.png` });
// Group with Lee, a T3 agent and the new terminal; post addressing only the T3 agent.
const title = `fp1 web ${suffix}`;
await page.getByLabel("Title").fill(title);
await page.getByLabel("Members").fill(`@lee @fp1-codex @${term}`);
await page.getByRole("button", { name: "Create" }).click();
await page.getByPlaceholder("Message; @name wakes that member").fill("@fp1-codex Fix pass web check: reply with exactly FP1-WEB");
const wakes = await page.locator(".send-row .muted").textContent();
await page.getByRole("button", { name: "Send" }).click();
await page.locator(".badge").first().waitFor();
const first = await page.locator(".badge").allTextContents();
await page.locator(".badge", { hasText: "replied" }).first().waitFor({ timeout: 300_000 });
await page.waitForTimeout(1500);
const final = await page.locator(".badge").allTextContents();
const messages = await page.locator(".msg .text").allTextContents();
await page.screenshot({ path: `${OUT}web-2-group.png` });
rec({ scenario: "webWorkflow", promoted: term, promoteNote: note, termRow, group: title, wakes, badgesAfterPost: first, badgesFinal: final, messages });
await browser.close();
