// Fix pass section 4 (Cedar): the restart items rerun on the installed services, now
// confirming each connector kill really ended the process; and 7c with a real CLI kill
// after the answer is printed and before the CLI acknowledges.
import { ACK_WINDOW_MS } from "@agent-comms/protocol";
import { admin, alive, api, call, check, comms, connector, connectorPid, connectorUp, journalTo, log, ok, Session, sleep, status, until } from "../../capabilities/acceptance/lib.mjs";
journalTo(new URL("./restarts.journal.txt", import.meta.url).pathname);

const A = await new Session("smoke-a").register();
const B = await new Session("smoke-b").register();
for (const s of [A, B]) await s.drain(10_000);
const RUN = `[run ${Date.now().toString(36)}]`;
const T = (x) => `${RUN} ${x}`;
let turn = 1;
const busy = async () => {
  await ok("presence", { sessionId: A.sessionId, status: "busy", turnId: `acc-turn-${turn}` });
};
await busy();

/** Kill the connector and prove it: the old PID is gone and a new one serves. */
async function killConnector(label) {
  const before = connectorPid();
  connector("kill");
  await until("the old process gone", async () => !alive(before), 10_000, 100);
  await connectorUp();
  const after = connectorPid();
  check(`${label}: the connector process died (pid ${before} gone) and a new one (pid ${after}) serves`, before > 0 && after > 0 && after !== before && !alive(before));
  for (const s of [A, B]) await s.reconnect();
  await busy();
}

// --- 7a: killed after the answer is stored; comms await gets it.
if (!process.env.ONLY_7C) {
  log("7a");
  const sent = await ok("send", { as: "smoke-a", to: ["smoke-b"], text: T("7a"), wait: true, waitMs: 120_000, key: `fix4-7a-${Date.now()}` });
  const d = await B.next(T("7a"));
  await B.delivered(d);
  await B.reply(d, T("7a answer"));
  await until("stored", async () => {
    const r = await call("await", { as: "smoke-a", messageId: sent.message.id, waitMs: 0 });
    return r.ok && r.wait.results[0].state === "answered";
  }, 30_000);
  await killConnector("7a");
  const r = await comms(["await", "--as", "smoke-a", sent.message.id]);
  check("7a after the restart, comms await prints the stored answer with its proof markers", r.code === 0 && r.stdout.includes(T("7a answer")) && /\[agent-comms proof v1 end /.test(r.stdout), r.stdout);
}

// --- 7a': the real CLI waits through a connector kill.
if (!process.env.ONLY_7C) {
  log("7a'");
  const run = comms(["send", "--as", "smoke-a", "--wait", "120s", "@smoke-b", T("7a'")]);
  const d = await B.next(T("7a'"));
  await B.delivered(d);
  await sleep(2_000);
  await killConnector("7a'");
  await B.reply(d, T("7a' answer"));
  const r = await run;
  check("7a' the CLI keeps waiting through the restart and prints the answer", r.code === 0 && r.stdout.includes(T("7a' answer")), { code: r.code, stderr: r.stderr });
}

// --- 7c with a real CLI kill: printed, then killed before its (provisional) ack; one fallback after the window.
{
  log("7c");
  const run = comms(["send", "--as", "smoke-a", "--wait", "120s", "@smoke-b", T("7c")]);
  const d = await B.next(T("7c"));
  await B.delivered(d);
  // Hold the connector's ack path: kill the CLI the moment its end marker is printed.
  let printed = "";
  run.child.stdout.on("data", (c) => {
    printed += c;
    if (/\[agent-comms proof v1 end /.test(printed)) run.child.kill("SIGKILL");
  });
  await B.reply(d, T("7c answer"));
  const r = await run;
  const id = /^sent (\S+)/m.exec(r.stdout)?.[1];
  check("7c the CLI printed the answer and was killed (SIGKILL)", r.signal === "SIGKILL" && printed.includes(T("7c answer")), { signal: r.signal });
  const s0 = await status("smoke-a", id);
  log("7c result after the kill", s0.wait.results[0]);
  check("7c no ack reached Convex: the result is answered, not printed", s0.wait.results[0].state === "answered" && s0.wait.results[0].printedAt === undefined);
  const fb = await A.next((x) => x.fallback === true && x.message.text === T("7c answer"), ACK_WINDOW_MS + 150_000);
  if (!A.turns.has(fb.id)) await A.delivered(fb);
  const s = await status("smoke-a", id);
  const v = await admin.query(api.conversations.view, { conversationId: s.message.conversationId, limit: 200 });
  const toA = v.messages.find((m) => m.message.text === T("7c answer")).deliveries.filter((x) => x.recipient === "smoke-a");
  check("7c the answer fell back once, after the window from the wait's end, and stays readable", s.wait.results[0].state === "fell-back" && toA.length === 2 && s.recipients[0].answer?.text === T("7c answer"), { fellBackAt: new Date(s.wait.results[0].at).toISOString(), endedAt: new Date(s.wait.endedAt).toISOString() });
}

for (const s of [A, B]) await s.unregister();
log(process.exitCode ? "SOME FAILED" : "ALL PASS");
