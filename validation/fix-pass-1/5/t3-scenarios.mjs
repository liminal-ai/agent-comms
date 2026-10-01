// Section 5, T3 side, on the real installation (agent-comms-connector.service,
// local Convex, Hazel's T3 on 3780), in this run's own threads and groups.
// Each scenario appends one result line to results-t3.jsonl.
//   node t3-scenarios.mjs <scenario>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { comms, convex, adminToken, group, interrupt, log, sleep, SETTLED, thread, turnsFor, typeIn, view, waitBusy, waitState, OUT } from "./lib.mjs";

const run = JSON.parse(readFileSync(`${OUT}run.json`, "utf8"));
const NATIVE = run.threads.native;
const CODEX = run.threads.codex;
const env = { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
const sc = (...a) => execFileSync("systemctl", ["--user", ...a], { env, encoding: "utf8" });
const result = (scenario, rec) => log("results-t3.jsonl", { scenario, ...rec });
const send = (conversationId, to, text, socket) => {
  const r = comms(...(socket ? ["--socket", socket] : []), "send", "--as", "fp1-req", "--conversation", conversationId, `@${to}`, text);
  return { messageId: r.message.id, deliveryId: r.deliveries[0].id, conversationId };
};
const answers = async (s) =>
  (await view(s.conversationId)).messages.filter((m) => m.message.inReplyTo === s.messageId).map((m) => ({ collected: !!m.message.collectedFrom, text: m.message.text.slice(0, 120) }));
const fresh = async (name, member) => group(`fp1 ${name} ${new Date().toISOString().slice(11, 19)}`, ["lee", "fp1-req", member]);

const scenarios = {
  // The dispatcher with the real T3 adapter: a plain request.
  async baseline() {
    const g = await fresh("baseline", "fp1-codex");
    await waitBusy(CODEX, false);
    const s = send(g, "fp1-codex", "Fix pass check: reply with exactly FP1-BASELINE");
    const d = await waitState(g, s.messageId, SETTLED);
    result("baseline", { delivery: s.deliveryId, state: d.state, answers: await answers(s), turns: await turnsFor(CODEX, `comms-${s.deliveryId}`) });
  },

  // Crash after T3 accepted our message and before `delivered` was recorded.
  async crashWindow() {
    const g = await fresh("crash-window", "fp1-codex");
    await waitBusy(CODEX, false);
    sc("stop", "agent-comms-connector");
    try { sc("reset-failed", "cedar-fp1-faulty"); } catch {}
    execFileSync("systemd-run", ["--user", "--unit=cedar-fp1-faulty", "-q", "-p", "MemoryMax=1G", "--working-directory=/srv/work/agent-comms",
      `--setenv=PATH=${process.env.PATH}`, `--setenv=HOME=${process.env.HOME}`, "--setenv=XDG_RUNTIME_DIR=/run/user/1000", "--setenv=AGENT_COMMS_FAULT=crash-after-accept",
      "node", "packages/connector/src/main.ts", "--config", `${process.env.HOME}/.config/agent-comms/connector.json`], { env });
    await sleep(2500);
    const s = send(g, "fp1-codex", "Fix pass crash-window check: without tools, write the numbers one to forty in words, one per line, then a final line FP1-CRASH-DONE");
    // The faulty connector kills itself right after T3 accepts; wait for it to die.
    for (let i = 0; i < 120; i++) {
      const active = (() => { try { return sc("is-active", "cedar-fp1-faulty").trim(); } catch (e) { return String(e.stdout ?? "").trim(); } })();
      if (active !== "active") break;
      await sleep(500);
    }
    const before = await delivery_(s);
    sc("start", "agent-comms-connector");
    const d = await waitState(g, s.messageId, SETTLED, 400_000).catch(async () => delivery_(s));
    result("crashWindow", { delivery: s.deliveryId, stateAtCrash: before?.state, final: d.state, detail: d.detail ?? null, answers: await answers(s), turns: await turnsFor(CODEX, `comms-${s.deliveryId}`) });
  },

  // 1.1: Lee's queued message flushing on the same `ready` as our send.
  async queuedFlush() {
    const g = await fresh("queued-flush", "fp1-native");
    await waitBusy(NATIVE, false);
    await typeIn(NATIVE, "Run the shell command `sleep 12` in the foreground, then reply with exactly LEE-FIRST");
    await waitBusy(NATIVE, true);
    const s = send(g, "fp1-native", "Fix pass 1.1 check: reply with exactly FP1-QUEUED");
    // Lee's held message is sent the moment the session goes ready, as ours is.
    await waitBusy(NATIVE, false, 240_000);
    await typeIn(NATIVE, "And also: reply with exactly LEE-SECOND");
    const d = await waitState(g, s.messageId, SETTLED);
    result("queuedFlush", { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s), turns: await turnsFor(NATIVE, `comms-${s.deliveryId}`) });
  },

  // 1.1, sharpened: Lee's message fired by a racer on the same `ready` event our adapter waits for.
  async queuedRace() {
    const attempts = [];
    for (let i = 0; i < 3; i++) {
      const g = await fresh(`queued-race-${i}`, "fp1-native");
      await waitBusy(NATIVE, false, 240_000);
      await typeIn(NATIVE, "Run the shell command `sleep 10` in the foreground, then reply with exactly LEE-FIRST");
      await waitBusy(NATIVE, true);
      const racer = (await import("node:child_process")).spawn("node", [`${OUT}racer.ts`, NATIVE], { stdio: ["ignore", "pipe", "inherit"] });
      let fired = "";
      racer.stdout.on("data", (b) => (fired += b));
      const racerDone = new Promise((r) => racer.once("exit", r));
      const s = send(g, "fp1-native", "Fix pass 1.1 race check: reply with exactly FP1-RACE");
      const d = await waitState(g, s.messageId, SETTLED);
      await racerDone;
      const leeId = (() => { try { return JSON.parse(fired).fired; } catch { return null; } })();
      attempts.push({ delivery: s.deliveryId, ours: `comms-${s.deliveryId}`, lee: leeId, state: d.state, detail: d.detail ?? null, answers: await answers(s) });
      await waitBusy(NATIVE, false, 240_000);
    }
    result("queuedRace", { attempts });
  },

  // 2.2 on the real path: connector A, frozen in its courtesy wait past its lease, loses the claim to B.
  async claimLost() {
    const g = await fresh("claim-lost", "fp1-native");
    await waitBusy(NATIVE, false, 240_000);
    sc("stop", "agent-comms-connector");
    try { sc("reset-failed", "cedar-fp1-a"); } catch {}
    execFileSync("mkdir", ["-p", "-m", "700", "/srv/agents/cedar/smoke/runA"]);
    execFileSync("systemd-run", ["--user", "--unit=cedar-fp1-a", "-q", "-p", "MemoryMax=1G", "--working-directory=/srv/work/agent-comms",
      `--setenv=PATH=${process.env.PATH}`, `--setenv=HOME=${process.env.HOME}`, "node", "packages/connector/src/main.ts", "--config", "/srv/agents/cedar/smoke/connector-a.json"], { env });
    await sleep(2500);
    await typeIn(NATIVE, "Run the shell command `sleep 40` in the foreground, then reply with exactly LEE-LONG");
    await waitBusy(NATIVE, true);
    const s = send(g, "fp1-native", "Fix pass 2.2 check: reply with exactly FP1-CLAIM", "/srv/agents/cedar/smoke/runA/agent-comms/connector.sock");
    await sleep(3000); // A has claimed and is in its courtesy wait
    const atFreeze = await delivery_(s);
    execFileSync("kill", ["-STOP", sc("show", "-p", "MainPID", "--value", "cedar-fp1-a").trim()]);
    await sleep(11_000); // A's 8 s lease runs out
    sc("start", "agent-comms-connector"); // B takes over
    await sleep(8_000);
    execFileSync("kill", ["-CONT", sc("show", "-p", "MainPID", "--value", "cedar-fp1-a").trim()]);
    const d = await waitState(g, s.messageId, SETTLED, 400_000);
    await sleep(5_000);
    sc("stop", "cedar-fp1-a");
    result("claimLost", { delivery: s.deliveryId, stateAtFreeze: atFreeze?.state, state: d.state, detail: d.detail ?? null, answers: await answers(s), turns: await turnsFor(NATIVE, `comms-${s.deliveryId}`) });
  },

  // 1.7 on T3: text typed into our running turn.
  async typedIn() {
    const g = await fresh("typed-in", "fp1-native");
    await waitBusy(NATIVE, false, 240_000);
    const s = send(g, "fp1-native", "Fix pass typed-in check: run `sleep 15` in the foreground, then reply with exactly FP1-TYPED");
    await waitState(g, s.messageId, ["delivered"], 120_000);
    await sleep(4000);
    await typeIn(NATIVE, "Quick aside while you work: what's 5+5?");
    const d = await waitState(g, s.messageId, SETTLED);
    result("typedIn", { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s) });
  },

  // An interrupt mid-stream while the connector is down; recovery must never collect the partial answer.
  async interruptRecovery() {
    const g = await fresh("interrupt", "fp1-native");
    await waitBusy(NATIVE, false, 240_000);
    const s = send(g, "fp1-native", "Fix pass interrupt check: without tools, write a 2,500-word story about a clockmaker. Take your time.");
    await waitState(g, s.messageId, ["delivered"], 120_000);
    await sleep(6000);
    sc("kill", "--kill-whom=main", "--signal=KILL", "agent-comms-connector");
    await interrupt(NATIVE);
    await sleep(3000);
    // systemd restarts the connector (Restart=on-failure); recovery replays from the cursor.
    const d = await waitState(g, s.messageId, SETTLED, 400_000);
    result("interruptRecovery", { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s) });
  },

  // 2.4 / 2.5: retire, remove from the group, and rebind, each with a request in flight.
  async lifecycle() {
    const out = {};
    for (const action of ["retire", "remove", "rebind"]) {
      const name = `fp1-${action}-${Date.now().toString(36)}`;
      await convex.mutation("directory:promote", { adminToken, name, kind: "agent", home: { machine: "lim-builder", harness: "t3", locator: CODEX } });
      const g = await fresh(action, name);
      await waitBusy(CODEX, false, 240_000);
      const s = send(g, name, `Fix pass ${action} check: run \`sleep 10\` in the foreground, then reply with exactly FP1-${action.toUpperCase()}`);
      await waitState(g, s.messageId, ["delivered"], 120_000);
      if (action === "retire") await convex.mutation("directory:setState", { adminToken, name, state: "retired" });
      if (action === "remove") await convex.mutation("conversations:removeMember", { adminToken, conversationId: g, name });
      if (action === "rebind") await convex.mutation("directory:rebind", { adminToken, name, home: { machine: "lim-builder", harness: "t3", locator: NATIVE } });
      const d = await waitState(g, s.messageId, SETTLED);
      out[action] = { delivery: s.deliveryId, state: d.state, detail: d.detail ?? null, answers: await answers(s), turnsInOriginalThread: await turnsFor(CODEX, `comms-${s.deliveryId}`), inNewThread: action === "rebind" ? (await turnsFor(NATIVE, `comms-${s.deliveryId}`)).ourMessages : undefined };
    }
    result("lifecycle", out);
  },

  // 1.10: an oversize request is refused with a clear error.
  async oversize() {
    const g = await fresh("oversize", "fp1-codex");
    let error = null;
    try {
      execFileSync(`${process.env.HOME}/.local/bin/comms`, ["send", "--as", "fp1-req", "--conversation", g, "@fp1-codex", "x".repeat(40_000)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      error = { exit: e.status, stderr: String(e.stderr).slice(0, 300) };
    }
    const v = await view(g);
    result("oversize", { error, messagesPosted: v.messages.length });
  },
};

async function delivery_(s) {
  return (await view(s.conversationId)).messages.find((m) => m.message.id === s.messageId)?.deliveries[0];
}

const name = process.argv[2];
if (!scenarios[name]) throw new Error(`scenarios: ${Object.keys(scenarios).join(", ")}`);
await scenarios[name]();
