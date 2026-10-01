// Fires a "Lee" message into a thread the instant its session goes ready after being busy:
// what the web UI's queued message does, and the same moment our adapter sends.
//   node racer.ts <threadId>   (exits after firing; prints the message id)
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { makeT3Client } from "/srv/work/agent-comms/packages/adapter-t3/src/t3/client.ts";
const threadId = process.argv[2]!;
const token = readFileSync(`${process.env.HOME}/.config/agent-comms/t3-3780.token`, "utf8").trim();
const client = makeT3Client({ baseUrl: "http://127.0.0.1:3780", authFile: `${process.env.HOME}/.config/agent-comms/t3-3780.token`, log: () => {} });
let wasBusy = false;
let fired = false;
await client.subscribe(threadId, {}, (item) => {
  const session = item.kind === "event" && item.event.type === "session" ? item.event.session : item.kind === "snapshot" ? item.thread.session : null;
  if (!session || fired) return;
  const busy = ["running", "starting"].includes(session.status);
  if (busy) wasBusy = true;
  else if (wasBusy) {
    fired = true;
    const messageId = `lee-race-${randomUUID()}`;
    void fetch("http://127.0.0.1:3780/api/orchestration/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "thread.turn.start", commandId: randomUUID(), threadId, message: { messageId, role: "user", text: "Also: reply with exactly LEE-RACE", attachments: [] }, runtimeMode: "full-access", interactionMode: "default", createdAt: new Date().toISOString() }),
    }).then((r) => {
      console.log(JSON.stringify({ fired: messageId, status: r.status }));
      process.exit(0);
    });
  }
});
setTimeout(() => process.exit(2), 300_000);
