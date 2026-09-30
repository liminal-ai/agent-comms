import { answersTo, interrupt, log, send, sleep, typeIn, waitBusy, waitState } from "./t3-live.mjs";

const which = process.argv[2] ?? "all";
const results = {};
const run = async (name, f) => {
  if (which !== "all" && which !== name) return;
  log(`--- ${name}`);
  try {
    results[name] = await f();
  } catch (error) {
    results[name] = { error: String(error) };
  }
  log(name, JSON.stringify(results[name]));
};

// 1. Each provider answers a request, matched.
await run("providers", async () => {
  const out = {};
  for (const who of ["t3-lhc", "t3-codex"]) {
    const s = send("smoke-a", who, `Live test from agent-comms. Reply with exactly: PONG-${who}`);
    const d = await waitState(s, who, ["replied", "ambiguous", "failed", "uncertain"]);
    out[who] = { state: d.state, answers: await answersTo(s) };
  }
  return out;
});

// 2. A thread busy with someone else's turn: ours waits, then runs as its own turn.
await run("busy", async () => {
  await typeIn("t3-native", "Run the shell command `sleep 20` and then reply with exactly: LEE-DONE");
  await waitBusy("t3-native", true);
  const s = send("smoke-a", "t3-native", "Reply with exactly: AFTER-BUSY");
  const d = await waitState(s, "t3-native", ["replied", "ambiguous", "failed", "uncertain"]);
  return { state: d.state, detail: d.detail ?? null, answers: await answersTo(s) };
});

// 3. Someone types into our running turn: ambiguous.
await run("typed-in", async () => {
  const s = send("smoke-a", "t3-native", "Run the shell command `sleep 20`, then reply with exactly: TYPED-TEST");
  await waitState(s, "t3-native", ["delivered"], 60_000);
  await sleep(4000);
  await typeIn("t3-native", "Also say hello.");
  const d = await waitState(s, "t3-native", ["replied", "ambiguous", "failed", "uncertain"]);
  return { state: d.state, detail: d.detail ?? null, answers: await answersTo(s) };
});

// 4. Our turn is interrupted: failed (aborted).
await run("interrupt", async () => {
  await waitBusy("t3-native", false);
  const s = send("smoke-a", "t3-native", "Run the shell command `sleep 30`, then reply with exactly: NEVER");
  await waitState(s, "t3-native", ["delivered"], 60_000);
  await sleep(5000);
  await interrupt("t3-native");
  const d = await waitState(s, "t3-native", ["replied", "ambiguous", "failed", "uncertain"]);
  return { state: d.state, detail: d.detail ?? null, answers: await answersTo(s) };
});

console.log(JSON.stringify(results, null, 1));
