// Acceptance items 9 and 10 (reminders) on the installed services. The minute cron
// fires them; each sub-test has its own target so they run side by side.
import { admin, api, check, comms, journalTo, log, ok, Session, sleep, until } from "./lib.mjs";
journalTo(process.env.JOURNAL ?? new URL("./d-reminders.journal.txt", import.meta.url).pathname);

const RUN_ID = Date.now().toString(36);
const T = (text) => `[run ${RUN_ID}] ${text}`;
const MIN = 60_000;
const names = ["smoke-a", "smoke-b", "cc-a", "cc-b", "mod-a", "mod-b", "fp1-term-lccbe"];
const S = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await new Session(n).register()])));
await Promise.all(Object.values(S).map((s) => s.drain(10_000)));
let polling = true;
// Sessions keep polling in the background (a live mod would); tests take deliveries with next().
const pollers = Object.values(S).map(async (s) => {
  s.background = true;
  while (polling) await s.idle(5_000);
  s.background = false;
});

const reminder = async (as, id) => ok("reminder", { as, id });
const remind = async (as, args) => {
  const r = await comms(["remind", "--as", as, ...args, "--json"]);
  if (r.code !== 0) throw new Error(`comms remind: ${r.stderr}`);
  return JSON.parse(r.stdout).reminder;
};
const fireOf = (name) => (d) => d.message.meta?.type === "reminder" && d.message.text.includes(T(name));
const noFire = async (session, name, ms) => {
  const got = await session.next(fireOf(name), ms).catch(() => null);
  return got === null;
};

const tests = {
  // 9: a T3 agent, every 2 minutes: labelled from @reminders with its creator, answered, reported to @lee.
  async item9t3() {
    const { reminder: r } = await admin.mutation(api.reminders.create, { as: "lee", target: "t3-native", text: T("item 9: reply with exactly: reminder 9 ok"), everyMs: 2 * MIN, max: 1, reportTo: "lee", name: `acc9-${RUN_ID}` });
    const shown = await until("the fire answered", async () => {
      const x = await admin.query(api.reminders.get, { id: r.id });
      return x.fires[0]?.answer ? x : null;
    }, 6 * MIN, 5_000);
    const fire = shown.fires[0];
    const { conversations } = await admin.query(api.conversations.list);
    const dm = conversations.find((c) => c.kind === "dm" && c.members.some((m) => m.name === "t3-native") && c.members.some((m) => m.name === "reminders"));
    const v = dm ? await admin.query(api.conversations.view, { conversationId: dm.id, limit: 20 }) : null;
    const msg = v?.messages.find((m) => m.message.id === fire.messageId)?.message;
    check("9 a fire to a T3 agent is a request from @reminders labelled with its creator and schedule", msg?.sender.name === "reminders" && msg?.meta?.setBy === "lee" && msg?.meta?.schedule === "every 2m", msg?.meta);
    check("9 its answer is collected onto the fire", /reminder 9 ok/.test(fire.answer.text), fire.answer.text);
    const inbox = await admin.query(api.inbox.list, { human: "lee", limit: 10 });
    const report = inbox.items.find((i) => i.message.meta?.type === "reminder-report" && i.message.meta.reminderId === r.id);
    check("9 the answer is reported to @lee's inbox", !!report && /@t3-native answered/.test(report.message.text), report?.message.text);
    if (report) await admin.mutation(api.inbox.markRead, { human: "lee", messageIds: [report.message.id] });
  },

  // 9: a slow answer causes skipped fires, not a pile-up.
  async item9slow() {
    const name = "item 9 slow";
    const r = await remind("cc-b", ["@smoke-a", T(name), "--every", "1m", "--name", "acc9slow"]);
    const f1 = await S["smoke-a"].next(fireOf(name), 3 * MIN);
    await S["smoke-a"].delivered(f1);
    const piledUp = !(await noFire(S["smoke-a"], name, 150_000));
    const x = await reminder("cc-b", r.id);
    check("9 a slow answer: no second fire while the first is unanswered, and the skips are logged", !piledUp && x.reminder.fires === 1 && x.skips.some((s) => s.reason === "previous-fire-not-final"), { fires: x.reminder.fires, skips: x.skips.map((s) => s.reason) });
    await S["smoke-a"].reply(f1, "slow but done");
    const f2 = await S["smoke-a"].next(fireOf(name), 3 * MIN).catch(() => null);
    check("9 once answered, the next fire comes on schedule", !!f2);
    if (f2) {
      await S["smoke-a"].delivered(f2);
      // While this fire's turn runs, cancel: later fires stop, the turn finishes and its answer is recorded (item 10).
      await comms(["reminder", "cancel", r.id, "--as", "cc-b"]);
      const quiet = await noFire(S["smoke-a"], name, 90_000);
      await S["smoke-a"].reply(f2, "answered after the cancel");
      const y = await until("answer recorded", async () => {
        const z = await reminder("cc-b", r.id);
        return z.fires.find((f) => f.answer?.text === "answered after the cancel") ? z : null;
      }, 30_000);
      check("10 cancelling while a fire's turn runs stops later fires and the running turn's answer is still recorded", quiet && y.reminder.state === "cancelled");
    }
  },

  // 9: an ambiguous fire blocks the next for one interval only.
  async item9ambiguous() {
    const name = "item 9 ambiguous";
    const r = await remind("cc-b", ["@smoke-b", T(name), "--every", "1m", "--name", "acc9amb"]);
    const f1 = await S["smoke-b"].next(fireOf(name), 3 * MIN);
    await S["smoke-b"].delivered(f1);
    await ok("outcome", { sessionId: S["smoke-b"].sessionId, deliveryId: f1.id, turnId: `turn-${f1.id}`, outcome: "ambiguous", entered: [{ origin: "composer" }] });
    S["smoke-b"].turns.set(f1.id, { turnId: `turn-${f1.id}`, outcome: { outcome: "ambiguous", entered: [{ origin: "composer" }] } });
    const t0 = Date.now();
    const f2 = await S["smoke-b"].next(fireOf(name), 4 * MIN).catch(() => null);
    const x = await reminder("cc-b", r.id);
    check("9 an ambiguous fire blocks one interval, then the next fire comes", !!f2 && x.skips.some((s) => s.reason === "previous-fire-not-final") && Date.now() - t0 >= 50_000, { after: Date.now() - t0, skips: x.skips.map((s) => s.reason) });
    if (f2) {
      await S["smoke-b"].delivered(f2);
      // Pause while this fire's turn runs: no later fires; the turn's answer is recorded (item 10).
      await comms(["reminder", "pause", r.id, "--as", "cc-b"]);
      const quiet = await noFire(S["smoke-b"], name, 90_000);
      await S["smoke-b"].reply(f2, "answered while paused");
      const y = await until("answer recorded", async () => {
        const z = await reminder("cc-b", r.id);
        return z.fires.find((f) => f.answer?.text === "answered while paused") ? z : null;
      }, 30_000);
      check("10 pausing while a fire's turn runs stops later fires and the running turn's answer is still recorded", quiet && y.reminder.state === "paused");
      await comms(["reminder", "cancel", r.id, "--as", "cc-b"]);
    }
  },

  // 10: --idle-for defers a fire while the target is busy.
  async item10idle() {
    const name = "item 10 idle-for";
    const C = S["cc-a"];
    await C.presence("busy");
    const r = await remind("smoke-b", ["@cc-a", T(name), "--every", "1m", "--idle-for", "1m", "--name", "acc10idle"]);
    const deferred = await noFire(C, name, 150_000);
    const x = await reminder("smoke-b", r.id);
    check("10 --idle-for defers while the target is busy (skips: not-idle)", deferred && x.skips.some((s) => s.reason === "not-idle"), x.skips.map((s) => s.reason));
    await C.presence("idle");
    const t0 = Date.now();
    const f = await C.next(fireOf(name), 4 * MIN).catch(() => null);
    check("10 once the target has been idle a minute, it fires", !!f && Date.now() - t0 >= 55_000, Date.now() - t0);
    if (f) {
      await C.delivered(f);
      await C.reply(f, "ok");
    }
    await comms(["reminder", "cancel", r.id, "--as", "smoke-b"]);
  },

  // 10: --watch defers on another agent's activity.
  async item10watch() {
    const name = "item 10 watch";
    await S["mod-b"].presence("busy");
    const r = await remind("smoke-b", ["@mod-a", T(name), "--every", "1m", "--idle-for", "1m", "--watch", "@mod-b", "--name", "acc10watch"]);
    const deferred = await noFire(S["mod-a"], name, 150_000);
    const x = await reminder("smoke-b", r.id);
    check("10 --watch defers on the watched agent's activity", deferred && x.skips.some((s) => s.reason === "not-idle" && /@mod-b/.test(s.detail ?? "")), x.skips.map((s) => `${s.reason}: ${s.detail}`));
    await S["mod-b"].presence("idle");
    const f = await S["mod-a"].next(fireOf(name), 4 * MIN).catch(() => null);
    check("10 once the watched agent is idle long enough, the target gets the fire", !!f);
    if (f) {
      await S["mod-a"].delivered(f);
      await S["mod-a"].reply(f, "ok");
    }
    await comms(["reminder", "cancel", r.id, "--as", "smoke-b"]);
  },

  // 10: --max 3 stops after three, and the creator (an agent) gets a notice.
  async item10max() {
    const name = "item 10 max";
    const F = S["cc-b"];
    const r = await remind("mod-b", ["@cc-b", T(name), "--every", "1m", "--max", "3", "--name", "acc10max"]);
    for (let i = 0; i < 3; i++) {
      const f = await F.next(fireOf(name), 3 * MIN);
      await F.delivered(f);
      await F.reply(f, `fire ${i + 1} done`);
    }
    const fourth = !(await noFire(F, name, 100_000));
    const x = await reminder("mod-b", r.id);
    check("10 --max 3 stops after three fires", !fourth && x.reminder.fires === 3 && x.reminder.state === "done", x.reminder);
    const notice = await S["mod-b"].next((d) => d.message.kind === "notice" && d.message.meta?.reminderId === r.id, 60_000).catch(() => null);
    check("10 its creator (an agent) is told with a notice, never collected", !!notice && /was marked done: fired 3 times \(--max 3\)/.test(notice.message.text) && notice.message.kind === "notice", notice?.message.text);
  },

  // 10: done and blocked stop it; a short expiry ends it and tells the creator.
  async item10stop() {
    const name = "item 10 done";
    const G = S["fp1-term-lccbe"];
    const r1 = await remind("mod-b", ["@fp1-term-lccbe", T(name), "--every", "1m", "--name", "acc10done"]);
    const f = await G.next(fireOf(name), 3 * MIN);
    await G.delivered(f);
    const done = await comms(["reminder", "done", r1.id, "--as", "fp1-term-lccbe"]);
    await G.reply(f, "done, and marked done");
    check("10 the target marks it done with the command the fire told it", done.code === 0 && /done/.test(done.stdout), done.stdout);
    const name2 = "item 10 blocked";
    const r2 = await remind("mod-b", ["@fp1-term-lccbe", T(name2), "--every", "1m", "--name", "acc10blocked"]);
    const f2 = await G.next(fireOf(name2), 3 * MIN);
    await G.delivered(f2);
    const blocked = await comms(["reminder", "blocked", r2.id, "no credentials for the CI", "--as", "fp1-term-lccbe"]);
    await G.reply(f2, "blocked");
    const quiet = (await noFire(G, name, 90_000)) && (await noFire(G, name2, 1_000));
    const [x1, x2] = [await reminder("mod-b", r1.id), await reminder("mod-b", r2.id)];
    check("10 done and blocked stop further fires", quiet && x1.reminder.state === "done" && x2.reminder.state === "blocked" && x2.reminder.stateReason === "no credentials for the CI", [x1.reminder.state, x2.reminder.state, blocked.stdout.trim()]);
    await comms(["reminder", "cancel", r2.id, "--as", "mod-b"]);

    const r3 = await remind("cc-a", ["@mod-b", T("item 10 expiry"), "--every", "1m", "--expires", "1m", "--name", "acc10exp"]);
    const notice = await S["cc-a"].next((d) => d.message.kind === "notice" && d.message.meta?.reminderId === r3.id, 4 * MIN).catch(() => null);
    const x3 = await reminder("cc-a", r3.id);
    check("10 a short expiry ends it and tells the creator", x3.reminder.state === "expired" && !!notice && /expired/.test(notice.message.text), [x3.reminder.state, notice?.message.text]);
  },
};

const results = await Promise.allSettled(Object.entries(tests).map(async ([k, f]) => {
  log(`start ${k}`);
  try {
    await f();
  } catch (error) {
    check(`${k} ran to the end`, false, String(error));
  }
  log(`end ${k}`);
}));
void results;
polling = false;
await Promise.all(pollers);
for (const s of Object.values(S)) await s.unregister();
log(process.exitCode ? "SOME FAILED" : "ALL PASS");
