import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { answersTo, log, send, thread, waitBusy, waitState } from "./t3-live.mjs";
const state = "/srv/agents/cedar/smoke/acc-8.json";
if (process.argv[2] === "start") {
  await waitBusy("t3-codex", false);
  const s = send("t3-lhc", "t3-codex", "Acceptance 8: without using any tools, write the integers from 1 to 400 in words, one per line, then a final line: ACC-8-DONE");
  writeFileSync(state, JSON.stringify(s));
  await waitState(s, "t3-codex", ["delivered"], 120_000);
  log("t3-codex delivered");
} else {
  const s = JSON.parse(readFileSync(state, "utf8"));
  const d = await waitState(s, "t3-codex", ["replied", "ambiguous", "failed", "uncertain"], 400_000);
  const t = await thread("t3-codex");
  const answers = await answersTo(s);
  console.log(JSON.stringify({ state: d.state, detail: d.detail ?? null, ourMessagesInThread: t.messages.filter((m) => m.id === `comms-${s.deliveryId}`).length, answers: answers.map((a) => ({ collected: a.collected, tail: a.text.slice(-30) })) }));
}
