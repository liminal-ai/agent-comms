import { answersTo, send, waitBusy, waitState } from "./t3-live.mjs";
const who = process.argv[2] ?? "t3-native";
await waitBusy(who, false);
const s = send("smoke-a", who, "Reply with exactly: PLAIN-OK");
const d = await waitState(s, who, ["replied", "ambiguous", "failed", "uncertain"]);
console.log(JSON.stringify({ who, state: d.state, detail: d.detail ?? null, answers: await answersTo(s) }));
