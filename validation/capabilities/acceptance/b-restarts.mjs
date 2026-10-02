// Acceptance item 7 (restart while waiting) on the installed services.
import { ACK_WINDOW_MS, WAIT_HELD_MS } from "@agent-comms/protocol";
import { admin, api, call, check, comms, connector, connectorUp, journalTo, log, ok, Session, sleep, status, until } from "./lib.mjs";
journalTo(process.env.JOURNAL ?? new URL("./b-restarts.journal.txt", import.meta.url).pathname);

const A = await new Session("smoke-a").register();
const B = await new Session("smoke-b").register();
for (const s of [A, B]) await s.drain(10_000);
for (const s of [A, B]) await s.drain(3_000);
await A.presence("busy");
const RUN_ID = Date.now().toString(36);
const RUN = `[run ${RUN_ID}]`;
const T = (text) => `${RUN} ${text}`;
const reregister = async () => {
  await connectorUp();
  for (const s of [A, B]) await s.reconnect();
};
const answerStored = (as, id) =>
  until("the answer stored in the wait", async () => {
    const r = await call("await", { as, messageId: id, waitMs: 0 });
    return r.ok && r.wait.results[0].state !== "open" ? r.wait : null;
  }, 30_000);

// --- 7a. The connector is killed after the answer is stored and before the CLI has it: the CLI gets it after the restart.
{
  log("item 7a");
  // The CLI side: a waiting send whose answer the CLI hasn't fetched yet.
  const sent = await ok("send", { as: "smoke-a", to: ["smoke-b"], text: T("item 7a: answer, then the connector dies"), wait: true, waitMs: 120_000, key: `acc-7a-${RUN_ID}` });
  const d = await B.next(RUN);
  await B.delivered(d);
  await B.reply(d, T("item 7a: stored before the kill"));
  // Stored = consumed into the wait, in Convex (the answer's delivery to smoke-a finished as returned).
  await until("consumed in Convex", async () => {
    const v = await admin.query(api.conversations.view, { conversationId: sent.message.conversationId });
    const ans = v.messages.find((m) => m.message.inReplyTo === sent.message.id);
    return ans?.deliveries.find((x) => x.recipient === "smoke-a")?.state === "delivered";
  }, 30_000);
  connector("kill");
  await reregister();
  const r = await comms(["await", "--as", "smoke-a", sent.message.id]);
  log("cli", r);
  check("7a after the restart, comms await gets the stored answer", r.code === 0 && r.stdout.includes(T("item 7a: stored before the kill")));
}

// --- 7a'. The real CLI rides through a connector kill while it waits: it reconnects and gets the answer.
{
  log("item 7a'");
  const run = comms(["send", "--as", "smoke-a", "--wait", "120s", "@smoke-b", T("item 7a': the connector dies while the CLI waits")]);
  const d = await B.next(RUN);
  await B.delivered(d);
  await sleep(2_000);
  await connectorUp();
  connector("kill");
  await reregister();
  await B.reply(d, T("item 7a': answered after the restart"));
  const r = await run;
  log("cli", r);
  check("7a' the CLI keeps waiting through the restart and prints the answer", r.code === 0 && r.stdout.includes(T("item 7a': answered after the restart")));
}

// --- 7b. The CLI is killed mid-wait: once no await has come for WAIT_HELD_MS, a later answer goes into the thread.
{
  log("item 7b");
  const run = comms(["send", "--as", "smoke-a", "--wait", "300s", "@smoke-b", T("item 7b: the CLI dies")]);
  const d = await B.next(RUN);
  await B.delivered(d);
  run.child.kill("SIGKILL");
  const killed = await run;
  const id = /^sent (\S+)/m.exec(killed.stdout)?.[1];
  log(`CLI killed (${killed.signal}); waiting ${WAIT_HELD_MS / 1000}s + 30s`);
  await Promise.all([A.idle(WAIT_HELD_MS + 30_000), B.idle(WAIT_HELD_MS + 30_000)]);
  await B.reply(d, T("item 7b: answered after the CLI died"));
  const got = await A.next((x) => x.message.text === T("item 7b: answered after the CLI died"), 60_000);
  check("7b the answer arrives in A's thread as a normal answer (not a fallback)", got.message.text === T("item 7b: answered after the CLI died") && !got.fallback);
  if (!A.turns.has(got.id)) await A.delivered(got);
  const s = await until("status", async () => ((await status("smoke-a", id)).recipients[0].answer ? status("smoke-a", id) : null));
  check("7b status shows the answer; the wait's result is expired", s.wait.results[0].state === "expired" && s.recipients[0].answer?.text === T("item 7b: answered after the CLI died"), s.wait.results[0]);
}

// --- 7c. The CLI dies after the answer is stored and before it acks: one fallback after the window; status still has it.
{
  log("item 7c");
  const sent = await ok("send", { as: "smoke-a", to: ["smoke-b"], text: T("item 7c: printed, never acked"), wait: true, waitMs: 120_000, key: `acc-7c-${RUN_ID}` });
  const d = await B.next(RUN);
  await B.delivered(d);
  await B.reply(d, T("item 7c: the answer"));
  const wait = await answerStored("smoke-a", sent.message.id);
  check("7c the answer is stored (answered), and no ack comes", wait.results[0].state === "answered");
  const fb = await A.next((x) => x.fallback === true && x.message.text === T("item 7c: the answer"), ACK_WINDOW_MS + 150_000);
  log(`fallback delivery ${fb.id} after ${Math.round((Date.now() - wait.results[0].at) / 1000)} s`);
  if (!A.turns.has(fb.id)) await A.delivered(fb);
  const s = await status("smoke-a", sent.message.id);
  check("7c the result fell back once into the thread and stays readable with comms status", s.wait.results[0].state === "fell-back" && s.recipients[0].answer?.text === T("item 7c: the answer"), { state: s.wait.results[0].state, at: s.wait.results[0].at });
  const v = await admin.query(api.conversations.view, { conversationId: sent.message.conversationId });
  const toA = v.messages.find((m) => m.message.text === T("item 7c: the answer")).deliveries.filter((x) => x.recipient === "smoke-a");
  check("7c exactly two deliveries of the answer to A: the returned one and one fallback", toA.length === 2, toA.map((x) => x.state));
  log(`sweep phase: the fallback was written at ${new Date(s.wait.results[0].at).toISOString()}`);
}

for (const s of [A, B]) await s.unregister();
log(process.exitCode ? "SOME FAILED" : "ALL PASS");
