// Records this run's T3 thread events (sequence, type, ids, session state; never message text) to t3-events.jsonl.
import { appendFileSync, readFileSync } from "node:fs";
import { makeT3Client } from "/srv/work/agent-comms/packages/adapter-t3/src/t3/client.ts";
const out = new URL("t3-events.jsonl", import.meta.url).pathname;
const run = JSON.parse(readFileSync(new URL("run.json", import.meta.url), "utf8")) as { threads: Record<string, string> };
const client = makeT3Client({ baseUrl: "http://127.0.0.1:3780", authFile: `${process.env.HOME}/.config/agent-comms/t3-3780.token`, log: () => {} });
for (const [kind, threadId] of Object.entries(run.threads)) {
  const sub = (after?: number) =>
    client.subscribe(threadId, after === undefined ? {} : { afterSequence: after }, (item) => {
      const rec =
        item.kind === "event"
          ? { thread: kind, ...item.event }
          : item.kind === "snapshot"
            ? { thread: kind, snapshot: item.thread.snapshotSequence, session: item.thread.session }
            : { thread: kind, kind: item.kind };
      appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
    });
  await sub();
}
setInterval(() => {}, 60_000);
