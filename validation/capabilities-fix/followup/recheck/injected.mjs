// Follow-up re-check: failure isolation live, on the installed services. COMMS_TEST_FAULT is set
// on the live deployment for one reminder at a time (and removed after): a fire that fails after
// its message is written, and a report that fails after it's written.
import { execFileSync } from "node:child_process";
import { admin, api, check, journalTo, log, Session, sleep, until } from "../../../capabilities/acceptance/lib.mjs";
journalTo(new URL("./injected.journal.txt", import.meta.url).pathname);
const fault = (value) => {
  const args = value ? ["set", "COMMS_TEST_FAULT", value] : ["remove", "COMMS_TEST_FAULT"];
  execFileSync("/srv/agents/cedar/tmp/live-convex-env.sh", args, { stdio: "pipe" });
  log(`COMMS_TEST_FAULT ${value ? `= ${value}` : "removed"}`);
};
const TAG = `[recheck ${Date.now().toString(36)}]`;
const get = (id) => admin.query(api.reminders.get, { id });
const messagesWith = async (text) => {
  const { conversations } = await admin.query(api.conversations.list);
  let n = 0;
  for (const c of conversations.slice(0, 15)) n += (await admin.query(api.conversations.view, { conversationId: c.id, limit: 100 })).messages.filter((m) => m.message.text.includes(text)).length;
  return n;
};

const A = await new Session("smoke-a").register();
await A.drain(5_000);
try {
  // --- A fire that fails after its message is posted: nothing left behind, only it blocked, the tick goes on.
  const bad = await admin.mutation(api.reminders.create, { as: "lee", target: "smoke-a", text: `${TAG} fire fault`, everyMs: 60_000, name: "recheck-fire-fault" });
  const good = await admin.mutation(api.reminders.create, { as: "lee", target: "smoke-b", text: `${TAG} fires normally`, everyMs: 60_000, name: "recheck-normal" });
  fault(`reminder-fire-after-post:${bad.reminder.id}`);
  const b = await until("the faulty reminder blocked", async () => {
    const x = (await get(bad.reminder.id)).reminder;
    return x.state === "blocked" ? x : null;
  }, 150_000, 3_000);
  const g = (await get(good.reminder.id)).reminder;
  check("fire: the faulty reminder is blocked with the injected error, 0 fires", b.fires === 0 && /injected failure after the fire's message was posted/.test(b.stateReason ?? ""), { state: b.state, reason: b.stateReason, fires: b.fires });
  check("fire: no stray message or fire row was left (the sub-transaction rolled back)", (await messagesWith(`${TAG} fire fault`)) === 0 && (await get(bad.reminder.id)).fires.length === 0);
  check("fire: the other reminder fired in the same tick", g.fires >= 1, { fires: g.fires });
  fault(null);
  for (const r of [bad, good]) await admin.mutation(api.reminders.update, { id: r.reminder.id, action: "cancel" });

  // --- A report that fails after it's posted: the collected answer stays (once), no stray report.
  const rep = await admin.mutation(api.reminders.create, { as: "lee", target: "smoke-a", text: `${TAG} report fault`, everyMs: 60_000, name: "recheck-report-fault", reportTo: "lee", max: 1 });
  const fire = await A.next((d) => d.message.text === `${TAG} report fault`, 150_000);
  fault(`reminder-report-after-post:${rep.reminder.id}`);
  await A.delivered(fire);
  await A.reply(fire, `${TAG} the answer`);
  const shown = await until("the answer recorded on the fire", async () => {
    const x = await get(rep.reminder.id);
    return x.fires[0]?.answer ? x : null;
  }, 60_000, 1_000);
  await sleep(3_000);
  const inbox = await admin.query(api.inbox.list, { human: "lee", limit: 50 });
  check("report: the collected answer is recorded on the fire", shown.fires[0].answer.text === `${TAG} the answer`);
  check("report: the answer exists once, and no report reached @lee", (await messagesWith(`${TAG} the answer`)) === 1 && !inbox.items.some((i) => i.message.meta?.type === "reminder-report" && i.message.meta.reminderId === rep.reminder.id));
} finally {
  fault(null);
  await A.unregister();
  const unread = await admin.query(api.inbox.list, { human: "lee", unreadOnly: true, limit: 50 });
  const ours = unread.items.filter((i) => i.message.text.includes("recheck-") || i.message.text.includes(TAG));
  if (ours.length) log("marked read (re-check notices to @lee)", await admin.mutation(api.inbox.markRead, { human: "lee", messageIds: ours.map((i) => i.message.id) }));
}
log(process.exitCode ? "SOME FAILED" : "ALL PASS");
