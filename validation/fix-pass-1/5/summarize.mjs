// Computes the section 5 (T3 side) counts from this run's files only.
import { readFileSync, writeFileSync } from "node:fs";
const OUT = new URL(".", import.meta.url).pathname;
const read = (f) => readFileSync(`${OUT}${f}`, "utf8");
const dump = JSON.parse(read("convex-dump.json"));
const results = read("results-t3.jsonl").trim().split("\n").map(JSON.parse);
const events = read("t3-events.jsonl").trim().split("\n").map(JSON.parse);
const log = read("connector-service.log") + read("connector-test-units.log");
const deliveries = dump.flatMap((v) => v.messages.flatMap((m) => m.deliveries.map((d) => ({ ...d, kind: m.message.kind, message: m.message.id }))));
const requests = deliveries.filter((d) => d.kind === "request");
const byState = {};
for (const d of requests) byState[d.state] = (byState[d.state] ?? 0) + 1;
// Count turn starts per comms message from T3's own events: user-message events with our id.
const ourIds = new Set(requests.map((d) => `comms-${d.id}`));
const appended = {};
for (const e of events) if (e.type === "user-message" && ourIds.has(e.messageId)) appended[e.messageId] = (appended[e.messageId] ?? 0) + 1;
const dispatches = {};
for (const m of log.matchAll(/t3 dispatch (comms-[A-Za-z0-9]+)/g)) dispatches[m[1]] = (dispatches[m[1]] ?? 0) + 1;
const collected = dump.flatMap((v) => v.messages).filter((m) => m.message.collectedFrom);
const perDelivery = {};
for (const m of collected) perDelivery[m.message.collectedFrom] = (perDelivery[m.message.collectedFrom] ?? 0) + 1;
const answerDeliveries = deliveries.filter((d) => d.kind === "answer");
const summary = {
  conversations: dump.length,
  requestDeliveries: requests.length,
  requestStates: byState,
  answerDeliveriesBeyondDelivered: answerDeliveries.filter((d) => !["pending", "claimed", "delivered"].includes(d.state)).length,
  messagesAppendedInT3: { deliveriesSeen: Object.keys(appended).length, appendedMoreThanOnce: Object.entries(appended).filter(([, n]) => n > 1) },
  t3Dispatches: { deliveries: Object.keys(dispatches).length, dispatchedMoreThanOnce: Object.entries(dispatches).filter(([, n]) => n > 1) },
  collectedAnswers: collected.length,
  deliveriesWithMoreThanOneCollectedAnswer: Object.entries(perDelivery).filter(([, n]) => n > 1),
  scenarios: Object.fromEntries(results.map((r) => [r.scenario, r.attempts ? r.attempts.map((a) => a.state) : r.state ?? r.final ?? Object.fromEntries(Object.entries(r).filter(([k, v]) => v && typeof v === "object" && "state" in v).map(([k, v]) => [k, v.state]))])),
};
writeFileSync(`${OUT}summary-t3.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
