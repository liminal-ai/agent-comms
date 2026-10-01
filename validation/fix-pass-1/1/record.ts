// Records events (no text) for one thread to the given file until killed.
import { appendFileSync } from "node:fs";
import { makeT3Client } from "/srv/work/agent-comms/packages/adapter-t3/src/t3/client.ts";
const [threadId, out] = process.argv.slice(2) as [string, string];
const client = makeT3Client({ baseUrl: "http://127.0.0.1:3780", authFile: `${process.env.HOME}/.config/agent-comms/t3-3780.token`, log: () => {} });
await client.subscribe(threadId, {}, (item) => {
  const rec = item.kind === "event" ? item.event : item.kind === "snapshot" ? { snapshot: item.thread.snapshotSequence } : { kind: item.kind };
  appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
});
setInterval(() => {}, 60_000);
