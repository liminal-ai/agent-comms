// The V2 port's live scenarios: only what needs a real model in a real T3 thread (concurrent
// human input, interrupts, restarts with a run in flight, the receipt rule, an explicit reply).
// Claim loss, late acknowledgements and retry ordering are deterministic and covered by tests
// (packages/adapter-t3/test/v2-adapter.test.ts, convex/reply-settles.test.ts); their live
// scenarios were dropped (results kept in raw/results.jsonl).
//
//   node validation/v2/scenarios.ts <scenario>
//
// Each appends one line to raw/results.jsonl. An approval responder runs throughout
// (lib.ts startResponder, approve.ts). A scenario that stalls fails, and its line records the
// stall with its evidence; outcomes are never recorded by hand. Scratch connector unit:
// cedar-v2-connector (socket comms.sock).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  answers, group, stallEvidence, startResponder, ids, interrupt, isActive, log, projection, runsFor, sc, SETTLED, send, sleep, t3, TMP, typeIn, waitBusy, waitRun, waitState, env,
} from "./lib.ts";

const ANN = ids.threads.v2ann;
const BOB = ids.threads.v2bob;
const NODE = `${process.env.HOME}/.local/share/fnm/node-versions/v24.18.0/installation/bin/node`;
const MAIN = "cedar-v2-connector";
const result = (scenario: string, rec: Record<string, unknown>) => log("results.jsonl", { scenario, ...rec });
const fresh = (name: string, member: string) => group(`v2 ${name} ${new Date().toISOString().slice(11, 19)}`, ["v2lee", "v2req", member]);

function startConnector(unit: string, config: string) {
  try { sc("reset-failed", unit); } catch {}
  execFileSync("systemd-run", [
    "--user", `--unit=${unit}`, "-q", "-p", "MemoryMax=1G", "-p", "MemorySwapMax=0", "--working-directory=/srv/agents/cedar/agent-comms",
    `--setenv=PATH=${NODE.replace(/\/node$/, "")}:/usr/bin:/bin`, `--setenv=HOME=${process.env.HOME}`,
    NODE, "packages/connector/src/main.ts", "--config", config,
  ], { env });
}
const startMain = () => startConnector(MAIN, `${TMP}/connector.json`);
/** The unit is up and owns its socket (a stray connector on the same socket makes the start fail). */
async function started(unit: string, socket: string) {
  for (let i = 0; i < 40; i++) {
    if (isActive(unit) === "active" && existsSync(socket)) {
      await sleep(1500);
      if (isActive(unit) === "active") return;
    }
    await sleep(250);
  }
  throw new Error(`${unit} didn't start on ${socket}`);
}
async function stop(unit: string) {
  if (isActive(unit) === "active") sc("stop", unit);
  for (let i = 0; i < 40 && isActive(unit) === "active"; i++) await sleep(250);
}

const scenarios: Record<string, () => Promise<void>> = {
  /** Tells the synthetic agents which CLI is theirs (the scratch one), so nothing reaches the live connector. */
  async brief() {
    for (const [name, threadId] of [["v2ann", ANN], ["v2bob", BOB]] as const) {
      await waitBusy(threadId, false);
      await typeIn(threadId, `Setup note for this synthetic test thread: you are @${name}. Answer requests here in plain text in your reply; don't run commands unless a message asks you to run a specific one, and never inspect or manage services or files. The agent-comms CLI for you is ${TMP}/comms (only when asked; never any other comms binary). Reply with exactly: BRIEFED`);
      await sleep(1000);
      await waitBusy(threadId, false);
    }
    result("brief", { ok: true });
  },

  async baseline() {
    const g = await fresh("baseline", "v2ann");
    await waitBusy(ANN, false);
    const s = send(g, "v2ann", "V2 check baseline: without tools, reply with exactly V2-BASELINE");
    const d = await waitState(g, s.messageId, SETTLED);
    result("baseline", { delivery: s.deliveryId, state: d.state, answers: await answers(s), t3: await runsFor(ANN, `comms-${s.deliveryId}`) });
  },

  /** Lee's run is going when the request arrives: the courtesy wait, then our own run. */
  async busyThenOwn() {
    const g = await fresh("busy-then-own", "v2ann");
    await waitBusy(ANN, false);
    const lee = await typeIn(ANN, "Without tools, write a 600-word story about a heron, then a final line LEE-FIRST");
    await waitRun(ANN, lee, ["running"]);
    const s = send(g, "v2ann", "V2 check busy: without tools, reply with exactly V2-BUSY");
    const d = await waitState(g, s.messageId, SETTLED);
    result("busyThenOwn", { delivery: s.deliveryId, state: d.state, answers: await answers(s), t3: await runsFor(ANN, `comms-${s.deliveryId}`), lee: await runsFor(ANN, lee) });
  },

  /** Lee sends while our run is going, the composer's default (queue): his message is its own run; ours isn't ambiguous. */
  async queuedBehind() {
    const g = await fresh("queued-behind", "v2ann");
    await waitBusy(ANN, false);
    const s = send(g, "v2ann", "V2 check queued: without tools, write a 600-word story about a canal, then a final line V2-QUEUED");
    await waitRun(ANN, `comms-${s.deliveryId}`, ["running"]);
    await sleep(3000);
    const lee = await typeIn(ANN, "Quick aside: without tools, what's 2+2? Reply with just the number.", "queue");
    const d = await waitState(g, s.messageId, SETTLED);
    result("queuedBehind", { delivery: s.deliveryId, state: d.state, answers: await answers(s), t3: await runsFor(ANN, `comms-${s.deliveryId}`), lee: await runsFor(ANN, lee) });
  },

  /** Lee steers into our running run: ambiguous, only the fact reported; then the unmatched notice. */
  async steeredIn() {
    const g = await fresh("steered-in", "v2ann");
    await waitBusy(ANN, false);
    const s = send(g, "v2ann", "V2 check steer: without tools, write a 800-word story about a bridge, then a final line V2-STEER");
    await waitRun(ANN, `comms-${s.deliveryId}`, ["running"]);
    await sleep(4000);
    const lee = await typeIn(ANN, "Steering aside: also tell me what 5+5 is.", "steer");
    const d = await waitState(g, s.messageId, SETTLED);
    await waitBusy(ANN, false); // the notice's run (the agent's own comms reply goes through the responder)
    const notice = await runsFor(ANN, `comms-notice-${s.deliveryId}`);
    result("steeredIn", { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s), t3: await runsFor(ANN, `comms-${s.deliveryId}`), leeIn: (await projection(ANN)).messages.find((m) => m.id === lee)?.runId ?? null, notice });
  },

  /** Lee restarts our running run with his message (restart_active). */
  async restartSteer() {
    const g = await fresh("restart-steer", "v2ann");
    await waitBusy(ANN, false);
    const s = send(g, "v2ann", "V2 check restart-steer: without tools, write a 800-word story about a mill, then a final line V2-RESTART");
    await waitRun(ANN, `comms-${s.deliveryId}`, ["running"]);
    await sleep(4000);
    let error: string | null = null;
    try {
      await typeIn(ANN, "Change of plan: just reply with exactly LEE-RESTART.", "restart");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const d = await waitState(g, s.messageId, SETTLED);
    result("restartSteer", { delivery: s.deliveryId, typeInError: error, state: d.state, detail: d.detail ?? null, answers: await answers(s), t3: await runsFor(ANN, `comms-${s.deliveryId}`) });
  },

  /** Lee presses Stop on our run while the connector follows it. */
  async liveInterrupt() {
    const g = await fresh("live-interrupt", "v2ann");
    await waitBusy(ANN, false);
    const s = send(g, "v2ann", "V2 check interrupt: without tools, write a 2,000-word story about a lighthouse keeper. Take your time.");
    await waitRun(ANN, `comms-${s.deliveryId}`, ["running"]);
    await sleep(6000);
    await interrupt(ANN);
    const d = await waitState(g, s.messageId, SETTLED);
    result("liveInterrupt", { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s), t3: await runsFor(ANN, `comms-${s.deliveryId}`) });
  },

  /** Lee stops our run while the connector is down (SIGKILL); recovery must not collect the partial answer. */
  async interruptRecovery() {
    const g = await fresh("interrupt-recovery", "v2ann");
    await waitBusy(ANN, false);
    const s = send(g, "v2ann", "V2 check interrupt-recovery: without tools, write a 2,500-word story about a clockmaker. Take your time.");
    await waitState(g, s.messageId, ["delivered"], 120_000);
    await waitRun(ANN, `comms-${s.deliveryId}`, ["running"]);
    await sleep(6000);
    sc("kill", "--kill-whom=main", "--signal=KILL", MAIN);
    await interrupt(ANN);
    await sleep(3000);
    await stop(MAIN);
    startMain();
    const d = await waitState(g, s.messageId, SETTLED, 400_000);
    result("interruptRecovery", { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s), t3: await runsFor(ANN, `comms-${s.deliveryId}`) });
  },

  /** Connector restarted (clean stop) mid-run, the run finishes while it's down: recovered from one snapshot. */
  async connectorRestart() {
    const g = await fresh("connector-restart", "v2bob");
    await waitBusy(BOB, false);
    const s = send(g, "v2bob", "V2 check connector-restart: without tools, write a 600-word story about a lantern, then a final line V2-RESTARTED");
    await waitRun(BOB, `comms-${s.deliveryId}`, ["running"]);
    await stop(MAIN);
    await waitBusy(BOB, false, 240_000);
    startMain();
    const d = await waitState(g, s.messageId, SETTLED, 400_000);
    result("connectorRestart", { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s), t3: await runsFor(BOB, `comms-${s.deliveryId}`) });
  },

  /** The conservative receipt rule: a T3 agent asks from its shell; the answer is printed in the call and delivered again into its thread. */
  async receipt() {
    await waitBusy(ANN, false);
    await waitBusy(BOB, false);
    const lee = await typeIn(ANN, `Run exactly this in your shell, in the foreground, and tell me what it printed:\n${TMP}/comms send --as v2ann @v2bob "V2 receipt check: without tools, reply with exactly V2-RECEIPT"`);
    await waitBusy(ANN, true);
    await waitBusy(ANN, false, 300_000);
    // The answer's delivery into @v2ann's thread comes ~2 minutes after the wait ended.
    const end = Date.now() + 420_000;
    let found = null;
    while (Date.now() < end && !found) {
      const p = await projection(ANN);
      found = p.messages.find((m) => m.role === "user" && m.id.startsWith("comms-") && !m.id.startsWith("comms-notice-") && (p.runs.find((r) => r.userMessageId === m.id)?.ordinal ?? 0) > (p.runs.find((r) => r.userMessageId === lee)?.ordinal ?? 0))?.id ?? null;
      if (!found) await sleep(5000);
    }
    const p = await projection(ANN);
    const leeRun = p.runs.find((r) => r.userMessageId === lee);
    const toolCalls = p.turnItems.filter((i) => i.runId === leeRun?.id && i.type === "command_execution").length;
    const answerSeen = p.turnItems.some((i) => i.runId === leeRun?.id && i.type === "assistant_message" && /V2-RECEIPT/.test(i.text ?? ""));
    result("receipt", { leeRun: leeRun?.status, toolCalls, answerInTheCallReported: answerSeen, answerDeliveredIntoThread: found, t3: found ? await runsFor(ANN, found) : null });
  },


  /** docs/09 4 (option A), live: the agent answers with comms reply during the turn, then ends it with other text. */
  async replyDuring() {
    const g = await fresh("reply-during", "v2ann");
    await waitBusy(ANN, false);
    const s = send(g, "v2ann", "V2 check reply-during: answer this request by running exactly this one shell command, using this request's message id from the header above: " +
      `${TMP}/comms reply --as v2ann <message id> "V2-REPLY-A"` + " . After it succeeds, end your turn with the single word: done");
    const d = await waitState(g, s.messageId, SETTLED);
    await sleep(5000);
    result("replyDuring", { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s), t3: await runsFor(ANN, `comms-${s.deliveryId}`) });
  },
};

const name = process.argv[2];
if (!name || !scenarios[name]) throw new Error(`scenarios: ${Object.keys(scenarios).join(", ")}`);
const agents = { [ANN]: "v2ann", [BOB]: "v2bob" };
const responder = startResponder(agents);
let failed = false;
try {
  await scenarios[name]!();
} catch (error) {
  // A stalled or broken run fails and keeps its evidence; nothing is recorded as its outcome.
  failed = true;
  result(name, { failed: true, error: error instanceof Error ? error.message : String(error), evidence: await stallEvidence(agents), approvals: responder.decisions });
} finally {
  const decisions = await responder.stop();
  if (!failed && decisions.length) log("results.jsonl", { scenario: name, approvals: decisions });
  if (isActive(MAIN) !== "active") startMain(); // never leave the scratch connector down
  await t3.close();
}
process.exit(failed ? 1 : 0);
