// Computes the section 5 (T3 side) counts from this run's committed files only (no network):
//   convex-dump.json, results-t3.jsonl, t3-events.jsonl, connector-*.journal.txt
// Writes summary-t3.json. Run from a fresh checkout: node summarize.mjs
//
// One run per delivery is counted as turns, not messages (Alder):
// - T3's view: after our message is appended, the distinct turns that start before the next user
//   message in that thread. A turn our command starts shows `starting` then `running T`; a turn T3
//   or Claude starts by itself goes straight to `running`. We count both, separately.
// - The connector's view: the distinct turn ids it linked to the delivery (handoff-accepted,
//   check-running, check-completed, outcome lines), and its T3 dispatches.
import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL(".", import.meta.url).pathname;
const read = (f) => readFileSync(`${OUT}${f}`, "utf8");
const dump = JSON.parse(read("convex-dump.json"));
const results = read("results-t3.jsonl").trim().split("\n").map(JSON.parse);
const events = read("t3-events.jsonl").trim().split("\n").map(JSON.parse).filter((e) => e.sequence !== undefined);
const journal = read("connector-service.journal.txt") + read("connector-test-units.journal.txt");

const requests = dump.flatMap((v) =>
  v.messages.filter((m) => m.message.kind === "request").flatMap((m) => m.deliveries.map((d) => ({ ...d, conversation: v.conversation.title }))),
);
const RUNNING = new Set(["running", "starting"]);

function t3Turns(deliveryId) {
  const ours = `comms-${deliveryId}`;
  const appends = events.filter((e) => e.type === "user-message" && e.messageId === ours);
  if (appends.length === 0) return { recorded: false };
  const thread = appends[0].thread;
  const list = events.filter((e) => e.thread === thread).sort((a, b) => a.sequence - b.sequence);
  const at = list.findIndex((e) => e.sequence === appends[0].sequence);
  // The session as of our message: busy means we joined a running turn.
  let busyAtOurs = false;
  let activeAtOurs = null;
  for (let i = 0; i < at; i++) {
    if (list[i].type !== "session") continue;
    busyAtOurs = RUNNING.has(list[i].session.status);
    activeAtOurs = busyAtOurs ? list[i].session.activeTurnId : null;
  }
  const commandStarts = new Set();
  const otherStarts = new Set();
  let sawStarting = false;
  let windowEnd = "end of recording";
  for (let i = at + 1; i < list.length; i++) {
    const e = list[i];
    if (e.type === "user-message") {
      windowEnd = e.messageId === ours ? "our message again" : "next user message";
      break;
    }
    if (e.type !== "session") continue;
    if (e.session.status === "starting") sawStarting = true;
    if (e.session.status === "running" && e.session.activeTurnId) {
      const t = e.session.activeTurnId;
      // Joined while the other turn was still `starting`: the first turn to run is the one we joined.
      if (busyAtOurs && activeAtOurs === null) activeAtOurs = t;
      if (t === activeAtOurs || commandStarts.has(t) || otherStarts.has(t)) continue;
      (sawStarting ? commandStarts : otherStarts).add(t);
      sawStarting = false;
    }
  }
  return {
    recorded: true,
    thread,
    ourMessageAppends: appends.length,
    joinedRunningTurn: busyAtOurs ? activeAtOurs : false,
    turnsStartedByCommand: [...commandStarts],
    turnsStartedOtherwise: [...otherStarts],
    windowEnd,
  };
}

function connectorTurns(deliveryId) {
  const lines = journal.split("\n").filter((l) => l.includes(deliveryId));
  const turns = new Set();
  for (const l of lines) for (const m of l.matchAll(/turn=([0-9a-f-]{8,})/g)) turns.add(m[1]);
  return {
    t3Dispatches: lines.filter((l) => l.includes(`t3 dispatch comms-${deliveryId}`)).length,
    turnIdsLinked: [...turns],
    decisions: lines.filter((l) => / decision /.test(l)).map((l) => l.replace(/^.*decision \S+ /, "")),
  };
}

// Claude Code recipients have no T3 events; their turns are counted in Hazel's evidence (claude-code/).
const CLAUDE_CODE = new Set(["term-a", "cc-a", "cc-b", "fp1-req"]);
const perDelivery = requests.map((d) => ({
  delivery: d.id,
  conversation: d.conversation,
  recipient: d.recipient,
  state: d.state,
  t3: CLAUDE_CODE.has(d.recipient) ? { recorded: false, why: "Claude Code recipient: see claude-code/" } : t3Turns(d.id),
  connector: connectorTurns(d.id),
}));
const recorded = perDelivery.filter((p) => p.t3.recorded);
const collected = dump.flatMap((v) => v.messages).filter((m) => m.message.collectedFrom);
const perCollected = {};
for (const m of collected) perCollected[m.message.collectedFrom] = (perCollected[m.message.collectedFrom] ?? 0) + 1;
const scenarioOf = (id) => results.find((r) => JSON.stringify(r).includes(id))?.scenario ?? null;

const summary = {
  requestDeliveries: requests.length,
  requestStates: requests.reduce((a, d) => ((a[d.state] = (a[d.state] ?? 0) + 1), a), {}),
  t3EventsRecordedFor: recorded.length,
  t3DeliveriesNotRecorded: perDelivery.filter((p) => !p.t3.recorded && !p.t3.why).map((p) => p.delivery),
  turnsStartedOtherwise: recorded.filter((p) => p.t3.turnsStartedOtherwise.length).map((p) => ({ delivery: p.delivery, conversation: p.conversation, turns: p.t3.turnsStartedOtherwise, linkedByConnector: p.connector.turnIdsLinked.filter((t) => p.t3.turnsStartedOtherwise.includes(t)) })),
  moreThanOneAppend: recorded.filter((p) => p.t3.ourMessageAppends > 1).map((p) => p.delivery),
  moreThanOneCommandTurn: recorded.filter((p) => p.t3.turnsStartedByCommand.length > 1).map((p) => p.delivery),
  moreThanOneDispatch: perDelivery.filter((p) => p.connector.t3Dispatches > 1).map((p) => p.delivery),
  moreThanOneTurnLinkedByConnector: perDelivery.filter((p) => p.connector.turnIdsLinked.length > 1).map((p) => p.delivery),
  moreThanOneCollectedAnswer: Object.entries(perCollected).filter(([, n]) => n > 1),
  answerDeliveriesBeyondDelivered: dump.flatMap((v) => v.messages.filter((m) => m.message.kind === "answer").flatMap((m) => m.deliveries)).filter((d) => !["pending", "claimed", "delivered"].includes(d.state)).length,
  // The cases Alder asked about by name.
  focus: perDelivery.filter((p) => ["claimLost", "crashWindow", "interruptRecovery"].includes(scenarioOf(p.delivery)) || p.conversation?.startsWith("fp1 shared kill")).map((p) => ({ scenario: scenarioOf(p.delivery) ?? "shared 8-t3", ...p })),
  perDelivery,
};
writeFileSync(`${OUT}summary-t3.json`, JSON.stringify(summary, null, 1));
const { perDelivery: _, focus, ...short } = summary;
console.log(JSON.stringify({ ...short, focus: focus.map((f) => ({ scenario: f.scenario, state: f.state, t3: f.t3, dispatches: f.connector.t3Dispatches, linked: f.connector.turnIdsLinked })) }, null, 1));
