// Shared acceptance check rerun on the real installation (Cedar's items). Homes: fp1-native (native
// Claude, T3), fp1-lhc (Claude-LHC, T3), term-a (Claude Code + mod, Hazel). Marker PRIVATE-ACC2 in
// everything typed directly. Results to shared/results.jsonl.
//   node shared.mjs <item>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { adminToken, comms, convex, interrupt, log, sleep, SETTLED, thread, turnsFor, typeIn, view, waitBusy, waitState, OUT } from "./lib.mjs";

mkdirSync(`${OUT}shared`, { recursive: true });
const run = JSON.parse(readFileSync(`${OUT}run.json`, "utf8"));
const NATIVE = run.threads.native;
const LHC = run.threads.lhc;
const result = (item, rec) => log("shared/results.jsonl", { item, ...rec });
const env = { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
const sc = (...a) => execFileSync("systemctl", ["--user", ...a], { env, encoding: "utf8" });

async function allMessages() {
  const { conversations } = await convex.query("conversations:list", { adminToken });
  const out = [];
  for (const c of conversations) for (const m of (await view(c.id)).messages) out.push({ conversation: c, ...m });
  return out;
}
async function until(what, f, ms = 400_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await f(); if (v) return v; await sleep(3000); }
  throw new Error(`timed out: ${what}`);
}
const answersTo = async (conversationId, messageId) =>
  (await view(conversationId)).messages.filter((m) => m.message.inReplyTo === messageId).map((m) => ({ from: m.message.sender.name, collected: !!m.message.collectedFrom, text: m.message.text.slice(0, 120) }));

/** An agent in a T3 thread runs `comms send` from its own shell. */
async function agentSends(threadId, as, to, question) {
  await waitBusy(threadId, false, 300_000);
  await typeIn(threadId, `(private note, PRIVATE-ACC2) Please run exactly this in your shell and tell me what it printed:\ncomms send --as ${as} @${to} "${question}"`);
  const req = await until(`${as}'s request`, async () => (await allMessages()).find((m) => m.message.sender.name === as && m.message.text === question));
  const d = await waitState(req.message.conversationId, req.message.id, SETTLED, 400_000);
  return { request: req.message.id, conversation: req.message.conversationId, state: d.state, detail: d.detail ?? null, answers: await answersTo(req.message.conversationId, req.message.id) };
}

const items = {
  async directory() {
    const { chromium } = await import("/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs");
    const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto("http://127.0.0.1:3790/");
    await page.getByText("@term-a").first().waitFor();
    await page.waitForTimeout(25_000); // T3 presence is polled every 20 s
    await page.reload();
    await page.getByText("@term-a").first().waitFor();
    await page.waitForTimeout(1500);
    const rows = await page.locator(".people li").evaluateAll((els) => els.map((li) => ({ name: li.querySelector(".name")?.textContent, dot: li.querySelector(".dot")?.className, label: li.querySelector(".dot")?.getAttribute("title") })));
    await page.screenshot({ path: `${OUT}shared/1-directory.png` });
    await browser.close();
    result("1", { homes: rows.filter((r) => ["@fp1-native", "@fp1-lhc", "@term-a"].includes(r.name)) });
  },
  async requestsT3() {
    result("2a", await agentSends(NATIVE, "fp1-native", "fp1-lhc", "Acceptance rerun 2a: what is the capital of Canada? One word."));
    result("2c", await agentSends(LHC, "fp1-lhc", "term-a", "Acceptance rerun 2c: what is 13 squared? Just the number."));
  },
  async group() {
    const { chromium } = await import("/srv/work/chess-train-mvp/node_modules/playwright-core/index.mjs");
    const title = `fp1 shared group ${new Date().toISOString().slice(11, 19)}`;
    const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto("http://127.0.0.1:3790/");
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Members").fill("@lee @fp1-native @fp1-lhc @term-a");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByPlaceholder("Message; @name wakes that member").fill("@fp1-lhc @term-a Acceptance rerun 3: reply with your comms name only.");
    await page.getByText("wakes @fp1-lhc, @term-a").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Send" }).click();
    const post = await until("Lee's post", async () => (await allMessages()).find((m) => m.message.sender.name === "lee" && m.message.text.includes("Acceptance rerun 3")));
    const states = {};
    for (const who of ["fp1-lhc", "term-a"]) {
      const v = await until(`${who} settled`, async () => {
        const d = (await view(post.message.conversationId)).messages.find((m) => m.message.id === post.message.id)?.deliveries.find((x) => x.recipient === who);
        return d && SETTLED.includes(d.state) ? d : undefined;
      });
      states[who] = v.state;
    }
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}shared/3-group.png` });
    await browser.close();
    const v = await view(post.message.conversationId);
    result("3", { group: title, woken: post.deliveries.map((d) => d.recipient), states, replies: await answersTo(post.message.conversationId, post.message.id), nativeWoken: v.messages.some((m) => m.deliveries.some((d) => d.recipient === "fp1-native")) });
  },
  async typedT3() {
    const g = (await convex.mutation("conversations:createGroup", { adminToken, title: `fp1 shared typed ${new Date().toISOString().slice(11, 19)}`, members: ["lee", "fp1-req", "fp1-native"] })).conversation.id;
    await waitBusy(NATIVE, false, 300_000);
    const r = comms("send", "--as", "fp1-req", "--conversation", g, "@fp1-native", "Acceptance rerun 4: run `sleep 15` in the foreground, then reply with exactly ACC2-4");
    const id = r.message.id;
    await waitState(g, id, ["delivered"], 120_000);
    await sleep(4000);
    await typeIn(NATIVE, "(PRIVATE-ACC2) quick aside: what's 6+6?");
    const first = await waitState(g, id, SETTLED);
    const final = first.state === "ambiguous" ? await waitState(g, id, ["replied"], 300_000).catch(() => first) : first;
    result("4-t3", { delivery: r.deliveries[0].id, first: first.state, final: final.state, detail: final.detail ?? null, answers: await answersTo(g, id) });
  },
  async workT3() {
    const g = (await convex.mutation("conversations:createGroup", { adminToken, title: `fp1 shared work ${new Date().toISOString().slice(11, 19)}`, members: ["lee", "fp1-req", "fp1-lhc"] })).conversation.id;
    await waitBusy(LHC, false, 300_000);
    const r = comms("send", "--as", "fp1-req", "--conversation", g, "@fp1-lhc", "Acceptance rerun 5: run `ls /srv/work/agent-comms/packages | wc -l` in your shell and reply with just the number it prints.");
    const d = await waitState(g, r.message.id, SETTLED);
    const expected = execFileSync("sh", ["-c", "ls /srv/work/agent-comms/packages | wc -l"], { encoding: "utf8" }).trim();
    result("5-t3", { delivery: r.deliveries[0].id, state: d.state, answers: await answersTo(g, r.message.id), expected });
  },
  async killT3() {
    const g = (await convex.mutation("conversations:createGroup", { adminToken, title: `fp1 shared kill ${new Date().toISOString().slice(11, 19)}`, members: ["lee", "fp1-req", "fp1-lhc"] })).conversation.id;
    await waitBusy(LHC, false, 300_000);
    const r = comms("send", "--as", "fp1-req", "--conversation", g, "@fp1-lhc", "Acceptance rerun 8: without tools, write the numbers one to sixty in words, one per line, then a final line ACC2-8-DONE");
    await waitState(g, r.message.id, ["delivered"], 120_000);
    sc("kill", "--kill-whom=main", "--signal=KILL", "agent-comms-connector"); // systemd restarts it after 5 s
    const d = await waitState(g, r.message.id, SETTLED, 400_000);
    result("8-t3", { delivery: r.deliveries[0].id, state: d.state, answers: (await answersTo(g, r.message.id)).map((a) => ({ ...a, text: a.text.slice(-30) })), turns: await turnsFor(LHC, `comms-${r.deliveries[0].id}`) });
  },
  // 6 and 7 over every conversation in the deployment, from a dump taken now.
  async privacyAndLoops() {
    const { conversations } = await convex.query("conversations:list", { adminToken });
    const dump = [];
    for (const c of conversations) dump.push(await view(c.id));
    writeFileSync(`${OUT}shared/convex-dump-all.json`, JSON.stringify(dump));
    const msgs = dump.flatMap((v) => v.messages);
    const kindOf = new Map(msgs.flatMap((m) => m.deliveries.map((d) => [d.id, m.message.kind])));
    const collected = msgs.filter((m) => m.message.collectedFrom);
    result("6", { messages: msgs.length, withPrivateMarker: msgs.filter((m) => /PRIVATE-ACC2?/.test(m.message.text)).length });
    result("7", {
      collected: collected.length,
      collectedFromAnAnswersDelivery: collected.filter((m) => kindOf.get(m.message.collectedFrom) !== "request").length,
      answerDeliveriesPastDelivered: msgs.filter((m) => m.message.kind === "answer").flatMap((m) => m.deliveries).filter((d) => !["pending", "claimed", "delivered"].includes(d.state)).length,
    });
  },
};
const name = process.argv[2];
if (!items[name]) throw new Error(Object.keys(items).join(", "));
await items[name]();
