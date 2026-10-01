import { admin, api, comms, until, log, journalTo } from "./lib.mjs";
journalTo(new URL("./cleanup.journal.txt", import.meta.url).pathname);
const { alerts } = await admin.query(api.alerts.list, { openOnly: true });
for (const a of alerts) {
  log("open alert", { cause: a.cause, subject: a.subject, summary: a.summary });
  if (a.cause !== "uncertain-delivery") continue;
  const v = await admin.query(api.conversations.view, { conversationId: a.subject.conversationId, limit: 500 });
  const m = v.messages.find((x) => x.deliveries.some((d) => d.id === a.subject.id));
  const d = m.deliveries.find((x) => x.id === a.subject.id);
  log("its delivery", { message: m.message.id, text: m.message.text.slice(0, 80), recipient: d.recipient, state: d.state });
  const r = await comms(["reply", "--as", d.recipient, m.message.id, "(acceptance cleanup: this test delivery from an aborted item 7 run is complete)"]);
  log("comms reply", r.stdout.trim(), r.code);
  await until("resolved", async () => !(await admin.query(api.alerts.list, { openOnly: true })).alerts.some((x) => x.id === a.id), 3 * 60_000, 5_000);
  log("resolved", a.id);
}
const inbox = await admin.query(api.inbox.list, { human: "lee", unreadOnly: true, limit: 200 });
const ours = inbox.items.filter((i) => i.message.sender.name === "alerts" || /\(stale: left over from an aborted acceptance run\)/.test(i.message.text));
log("marking read", ours.map((i) => `${i.message.sender.name}: ${i.message.text.slice(0, 70)}`));
const res = await admin.mutation(api.inbox.markRead, { human: "lee", messageIds: ours.map((i) => i.message.id) });
log("markRead", res);
log("left unread in Lee's inbox", inbox.items.filter((i) => !ours.includes(i)).map((i) => `${i.message.sender.name}: ${i.message.text.slice(0, 70)}`));
