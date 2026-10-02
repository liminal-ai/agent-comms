// Acceptance items 11 and 12 on the installed services: an injected uncertain delivery and a
// stopped connector each give exactly one alert to the owner; stop, start, stop gives two;
// no system participant ever receives a delivery. The silent-connector threshold is lowered
// to 2 minutes for the test (alertConfig) and put back to 10 afterwards.
import { admin, api, check, comms, connector, connectorUp, journalTo, log, ok, Session, sleep, until } from "./lib.mjs";
journalTo(process.env.JOURNAL ?? new URL("./e-alerts.journal.txt", import.meta.url).pathname);

const RUN_ID = Date.now().toString(36);
const T = (text) => `[run ${RUN_ID}] ${text}`;
const MIN = 60_000;
const t0 = Date.now();
const alertsFor = async (cause, subjectId) =>
  (await admin.query(api.alerts.list, { limit: 200 })).alerts.filter((a) => a.cause === cause && a.subject.id === subjectId && a.openedAt >= t0);

// --- 11a. An injected uncertain delivery: one alert to the owner, resolved when it's completed.
{
  log("item 11a");
  const old = await new Session("smoke-a", `acc-11a-old-${RUN_ID}`).register();
  await old.drain(10_000);
  const sent = await comms(["send", "--as", "smoke-b", "--continue", "@smoke-a", T("item 11a: this one goes uncertain")]);
  const id = /^sent (\S+)/m.exec(sent.stdout)[1];
  const d = await old.next(T("item 11a"));
  await old.delivered(d);
  // The session dies mid-turn; a new one can't tell whether the turn ran: uncertain.
  const fresh = new Session("smoke-a", `acc-11a-new-${RUN_ID}`);
  fresh.turns.set(d.id, { turnId: "unknowable" });
  await fresh.register();
  const c = await fresh.next(() => true, 3 * MIN, "check"); // once the dead session is judged stale (~65 s)
  const r = await ok("check-result", { sessionId: fresh.sessionId, deliveryId: c.check.deliveryId, found: "unknown", detail: "acceptance 11a: injected" });
  log("check answered unknown", r.delivery);
  const opened = await until("the uncertain alert", async () => {
    const a = await alertsFor("uncertain-delivery", d.id);
    return a.length > 0 ? a : null;
  }, 3 * MIN, 5_000);
  await sleep(2 * MIN + 5_000); // two more scans
  const after = await alertsFor("uncertain-delivery", d.id);
  check("11a an uncertain delivery gives exactly one alert to its owner, with the delivery and its conversation", after.length === 1 && after[0].owner.name === "lee" && after[0].subject.conversationId === opened[0].subject.conversationId && !!after[0].subject.conversationId, after.map((a) => ({ owner: a.owner.name, summary: a.summary })));
  await comms(["reply", "--as", "smoke-a", id, T("item 11a: it did run, here's the answer")]);
  const resolved = await until("resolved", async () => ((await alertsFor("uncertain-delivery", d.id))[0].resolvedAt ? true : null), 3 * MIN, 5_000);
  check("11a completing it with comms reply resolves the incident (not announced)", resolved);
  await fresh.unregister();
}

// --- 11b. A stopped connector: one alert per incident; stop, start, stop gives two.
{
  log("item 11b");
  const before = await admin.query(api.alerts.config);
  log("alertConfig before", before);
  const lowered = await admin.mutation(api.alerts.setConfig, { connectorSilentMs: 2 * MIN });
  log("alertConfig lowered for the test", lowered);
  const machine = (await ok("status", {})).machine;
  try {
    connector("stop");
    const first = await until("the first silent-connector alert", async () => {
      const a = await alertsFor("connector-silent", machine);
      return a.length >= 1 ? a : null;
    }, 5 * MIN, 5_000);
    await sleep(MIN + 5_000);
    check("11b a stopped connector gives one alert (not one per scan)", (await alertsFor("connector-silent", machine)).length === 1, first.map((a) => a.summary));
    connector("start");
    await connectorUp();
    await until("resolved after it's heard from", async () => ((await alertsFor("connector-silent", machine))[0].resolvedAt ? true : null), 3 * MIN, 5_000);
    log("resolved; stopping again");
    connector("stop");
    await until("the second alert", async () => ((await alertsFor("connector-silent", machine)).length >= 2 ? true : null), 5 * MIN, 5_000);
    await sleep(MIN + 5_000);
    const all = await alertsFor("connector-silent", machine);
    check("11b stop, start, stop gives exactly two alerts", all.length === 2, all.map((a) => [new Date(a.openedAt).toISOString(), a.resolvedAt ? "resolved" : "open"]));
  } finally {
    connector("start");
    await connectorUp();
    const restored = await admin.mutation(api.alerts.setConfig, { connectorSilentMs: before.connectorSilentMs });
    log("alertConfig restored", restored);
    check("11b the threshold is back to 10 minutes", restored.connectorSilentMs === 10 * MIN);
  }
}

// --- 12. No system participant ever receives a delivery.
{
  log("item 12");
  const { conversations } = await admin.query(api.conversations.list);
  let deliveries = 0;
  const toSystem = [];
  for (const c of conversations) {
    const v = await admin.query(api.conversations.view, { conversationId: c.id, limit: 500 });
    for (const m of v.messages) {
      for (const d of m.deliveries) {
        deliveries++;
        if (d.recipient === "reminders" || d.recipient === "alerts") toSystem.push(d.id);
      }
    }
  }
  check(`12 no system participant ever received a delivery (${deliveries} deliveries in ${conversations.length} conversations)`, toSystem.length === 0, toSystem);
}

log(process.exitCode ? "SOME FAILED" : "ALL PASS");
