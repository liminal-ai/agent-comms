// Acceptance item 8: an answer arriving at the wait's bound is never lost; an ack racing the
// fallback gives at most one fallback, and the result ends acknowledged or fell-back.
// The timing is injected: replies and acks are fired at chosen offsets from the bound and
// from the waits sweep (a Convex cron; its phase is measured from a fallback first).
import { ACK_WINDOW_MS } from "@agent-comms/protocol";
import { admin, api, call, check, comms, journalTo, log, ok, Session, sleep, status, until } from "./lib.mjs";
journalTo(process.env.JOURNAL ?? new URL("./c-races.journal.txt", import.meta.url).pathname);

const A = await new Session("smoke-a").register();
const B = await new Session("smoke-b").register();
for (const s of [A, B]) await s.drain(10_000);
await A.presence("busy", "acc-race-turn");
const RUN_ID = Date.now().toString(36);
const T = (text) => `[run ${RUN_ID}] ${text}`;
const at = (ms) => sleep(Math.max(0, ms - Date.now()));
const keepPolling = (s, untilMs) => s.idle(Math.max(0, untilMs - Date.now()));

// --- 8a. Answers fired at the bound ± offset: each one either comes back in the call or lands in the thread.
const offsets = process.env.SKIP_8A ? [] : [-400, -150, -50, 0, 50, 150, 400];
for (const off of offsets) {
  const text = T(`item 8a: answer at bound ${off >= 0 ? "+" : ""}${off} ms`);
  const sent = await ok("send", { as: "smoke-a", to: ["smoke-b"], text: T(`item 8a: question (${off})`), wait: true, waitMs: 8_000, key: `acc-8a-${RUN_ID}-${off + 1000}` });
  const cli = comms(["await", "--as", "smoke-a", sent.message.id]);
  const d = await B.next(T(`item 8a: question (${off})`));
  await B.delivered(d);
  await at(sent.wait.until + off);
  await B.reply(d, text);
  const r = await cli;
  const s = await until("settled", async () => {
    const x = await status("smoke-a", sent.message.id);
    return x.recipients[0].answer ? x : null;
  });
  const state = s.wait.results[0].state;
  let where;
  if (r.code === 0 && r.stdout.includes(text)) where = "returned in the call";
  else {
    const got = await A.next((x) => x.message.text === text, 30_000).catch(() => null);
    where = got && !got.fallback ? "delivered into the thread" : "LOST";
    if (got && !A.turns.has(got.id)) await A.delivered(got);
  }
  check(`8a reply at bound ${off} ms: ${where} (cli exit ${r.code}, result ${state})`, where !== "LOST" && ((where === "returned in the call") === (state !== "expired")));
}

// --- From here on smoke-a's session keeps polling (a live mod would), and stays busy in "its turn".
let aPolling = true;
const aPoller = (async () => {
  while (aPolling) await A.idle(5_000);
})();

// --- Measure the sweep's phase from a fallback.
let roundNo = 0;
async function answered(label) {
  const sent = await ok("send", { as: "smoke-a", to: ["smoke-b"], text: T(label), wait: true, waitMs: 600_000, key: `acc-8b-${RUN_ID}-${++roundNo}` });
  const d = await B.next(T(label));
  await B.delivered(d);
  await B.reply(d, T(`${label}: answer`));
  const w = await until("answered", async () => {
    const x = await call("await", { as: "smoke-a", messageId: sent.message.id, waitMs: 0 });
    return x.ok && x.wait.results[0].state === "answered" ? x.wait : null;
  });
  // Fix pass 0.1: what the harness would report if it saw the CLI's output in this turn.
  const proof = { waitId: w.id, messageId: w.results[0].answer.id, token: w.results[0].proofToken };
  return { sent, answeredAt: w.results[0].at, proof };
}
log("measuring the sweep phase");
const probe = await answered("item 8b: phase probe");
const phaseEnd = probe.answeredAt + ACK_WINDOW_MS + 70_000;
const pollers = [keepPolling(B, phaseEnd)];
const fell = await until("the probe falls back", async () => {
  const s = await status("smoke-a", probe.sent.message.id);
  return s.wait.results[0].state === "fell-back" ? s.wait.results[0].at : null;
}, ACK_WINDOW_MS + 90_000, 200);
await Promise.all(pollers);
const phase = fell % 60_000;
log(`sweep phase: ${phase} ms past the minute (fallback written ${new Date(fell).toISOString()})`);

// --- 8b. Confirmations (answer-seen) fired around the sweep that falls back: never two fallbacks; acknowledged or fell-back.
await A.presence("busy", "acc-race-turn");
// The sweep's start drifts by up to a few seconds from minute to minute: spread the acks across it.
const ackOffsets = Array.from({ length: 19 }, (_, i) => -500 + i * 250);
const rounds = [];
for (const off of ackOffsets) rounds.push({ off, ...(await answered(`item 8b: ack at sweep ${off >= 0 ? "+" : ""}${off} ms`)) });
const latest = Math.max(...rounds.map((r) => r.answeredAt));
let sweepAt = Math.floor((latest + ACK_WINDOW_MS) / 60_000) * 60_000 + phase;
if (sweepAt <= latest + ACK_WINDOW_MS) sweepAt += 60_000;
log(`the sweep that falls these back: ${new Date(sweepAt).toISOString()}; acks at offsets ${ackOffsets.join(", ")} ms`);
const busyUntil = sweepAt + 30_000;
const keep = [keepPolling(B, busyUntil)];
await Promise.all(
  rounds.map(async (r) => {
    await at(sweepAt + r.off);
    // Fix pass: the race is now the harness's confirmation (answer-seen) against the sweep's fallback.
    r.ack = await A.op("answer-seen", { turnId: "acc-race-turn", proofs: [r.proof] });
    r.ackSaw = r.ack.ok ? "answer-seen accepted" : r.ack.error.code;
  }),
);
await Promise.all(keep);
const outcomes = [];
for (const r of rounds) {
  const s = await status("smoke-a", r.sent.message.id);
  const state = s.wait.results[0].state;
  const v = await admin.query(api.conversations.view, { conversationId: r.sent.message.conversationId, limit: 200 });
  const answer = v.messages.find((m) => m.message.text === T(`item 8b: ack at sweep ${r.off >= 0 ? "+" : ""}${r.off} ms: answer`));
  const fallbacks = answer.deliveries.filter((x) => x.recipient === "smoke-a").length - 1;
  outcomes.push([r.off, state]);
  check(
    `8b ack at sweep ${r.off} ms: result ${state}, ${fallbacks} fallback(s) (the ack saw ${r.ackSaw})`,
    (state === "acknowledged" && fallbacks === 0) || (state === "fell-back" && fallbacks === 1),
  );
}

log("8b outcomes by ack offset", outcomes);
check("8b both outcomes occurred, so acks really raced the fallback", outcomes.some((o) => o[1] === "acknowledged") && outcomes.some((o) => o[1] === "fell-back"));
aPolling = false;
await aPoller;
for (const s of [A, B]) await s.unregister();
log(process.exitCode ? "SOME FAILED" : "ALL PASS");
