// Acceptance items 3, 4, 5 (send-and-wait) on the installed services, with scripted
// Claude Code sessions for @smoke-a, @smoke-b and @cc-a, and the real comms CLI.
import { admin, api, check, comms, journalTo, log, Session, sleep, status, until } from "./lib.mjs";
journalTo(process.env.JOURNAL ?? new URL("./a-waits.journal.txt", import.meta.url).pathname);

const A = await new Session("smoke-a").register();
const B = await new Session("smoke-b").register();
const C = await new Session("cc-a").register();
for (const s of [A, B, C]) await s.drain();
for (const s of [A, B, C]) await s.drain(3_000); // answers to what was drained
const RUN = `[run ${Date.now().toString(36)}]`;
const T = (text) => `${RUN} ${text}`;
for (const s of [A, B, C]) await s.presence("busy");
const idOf = (out) => /^sent (\S+)/m.exec(out)?.[1];

// --- 3. A wait that runs out: exit 4 with the id; the late answer arrives as a normal message; status shows it.
{
  log("item 3");
  const run = comms(["send", "--as", "smoke-a", "--wait", "5s", "@smoke-b", T("item 3: answer me slowly")]);
  const d = await B.next(RUN);
  await B.delivered(d);
  const r = await run;
  log("cli", r);
  const id = idOf(r.stdout);
  check("3 exit 4 at the bound, with the id and the status command", r.code === 4 && r.stdout.includes(`comms status ${id} --as smoke-a`));
  await B.reply(d, T("item 3: the slow answer"));
  const late = await A.next(RUN);
  check("3 the late answer arrives as a normal answer delivery", late.message.kind === "answer" && late.message.text === T("item 3: the slow answer") && late.inReplyTo?.id === id);
  await A.delivered(late);
  const s = await until("the answer in status", async () => {
    const x = await status("smoke-a", id);
    return x.recipients[0].answer ? x : null;
  });
  check("3 comms status shows the answer, the result expired", s.recipients[0].answer?.text === T("item 3: the slow answer") && s.wait.results[0].state === "expired", s.wait.results[0]);
  const shown = await comms(["status", "--as", "smoke-a", id]);
  log("status cli", shown.stdout);
}

// --- 4a. A waits on B; B, in its turn, sends to A: B's send doesn't wait (A is busy waiting); both complete.
{
  log("item 4a");
  const run = comms(["send", "--as", "smoke-a", "--wait", "60s", "@smoke-b", T("item 4a: A asks B")]);
  const d = await B.next(RUN);
  await B.delivered(d);
  const back = await comms(["send", "--as", "smoke-b", "@smoke-a", T("item 4a: B asks A while A waits")]);
  log("B's send", back);
  check("4a B's send returns at once with the busy-waiting message", back.code === 0 && /@smoke-a is waiting on another request, so this send didn't wait/.test(back.stdout));
  await B.reply(d, T("item 4a: B's answer"));
  const r = await run;
  log("A's cli", r);
  check("4a A's send gets B's answer in the call", r.code === 0 && r.stdout.includes(T("item 4a: B's answer")));
  const toA = await A.next(RUN);
  check("4a B's request reaches A once A's wait is over", toA.message.text === T("item 4a: B asks A while A waits"));
  await A.delivered(toA);
  await A.reply(toA, T("item 4a: A's answer to B"));
  const bGets = await B.next(RUN);
  check("4a and B gets A's answer", bGets.message.text === T("item 4a: A's answer to B"));
  await B.delivered(bGets);
}

// --- 4b. Two simultaneous waiting sends between A and B: exactly one waits, the other doesn't; both complete.
{
  log("item 4b");
  const [ra, rb] = [comms(["send", "--as", "smoke-a", "--wait", "60s", "--json", "@smoke-b", T("item 4b: A to B")]), comms(["send", "--as", "smoke-b", "--wait", "60s", "--json", "@smoke-a", T("item 4b: B to A")])];
  const dB = await B.next(RUN);
  const dA = await A.next(RUN);
  await B.delivered(dB);
  await A.delivered(dA);
  await B.reply(dB, T("item 4b: B answers A"));
  await A.reply(dA, T("item 4b: A answers B"));
  const [a, b] = await Promise.all([ra, rb]);
  const ja = JSON.parse(a.stdout);
  const jb = JSON.parse(b.stdout);
  log("A", { code: a.code, wait: !!ja.wait, noWait: ja.noWait }, "B", { code: b.code, wait: !!jb.wait, noWait: jb.noWait });
  check("4b exactly one of the two simultaneous sends waited; the other said busy-waiting", (!!ja.wait) !== (!!jb.wait) && (ja.noWait?.reason === "busy-waiting" || jb.noWait?.reason === "busy-waiting"));
  check("4b both exit 0", a.code === 0 && b.code === 0);
  // The waiter's answer came back in the call; the other's answer arrives as a turn.
  const waiter = ja.wait ? A : B;
  const other = ja.wait ? B : A;
  const ans = await other.next(RUN);
  check("4b the non-waiting sender gets its answer as a normal delivery", ans.message.kind === "answer");
  await other.delivered(ans);
  check("4b the waiter got its answer in the call", (ja.wait ? ja : jb).wait.results[0].state !== "open");
  void waiter;
}

// --- 4c. A three-agent cycle A→B→C→A: C's send to A doesn't wait; everything completes, no timeouts.
{
  log("item 4c");
  const t0 = Date.now();
  const runA = comms(["send", "--as", "smoke-a", "--wait", "90s", "@smoke-b", T("item 4c: A asks B")]);
  const dB = await B.next(RUN);
  await B.delivered(dB);
  const runB = comms(["send", "--as", "smoke-b", "--wait", "90s", "@cc-a", T("item 4c: B asks C")]);
  const dC = await C.next(RUN);
  await C.delivered(dC);
  const cToA = await comms(["send", "--as", "cc-a", "@smoke-a", T("item 4c: C asks A")]);
  check("4c C's send to A doesn't wait (A is busy waiting)", cToA.code === 0 && /@smoke-a is waiting on another request/.test(cToA.stdout), cToA.stdout);
  await C.reply(dC, T("item 4c: C answers B"));
  const rB = await runB;
  check("4c B's wait on C returns C's answer", rB.code === 0 && rB.stdout.includes(T("item 4c: C answers B")));
  await B.reply(dB, T("item 4c: B answers A"));
  const rA = await runA;
  check("4c A's wait on B returns B's answer", rA.code === 0 && rA.stdout.includes(T("item 4c: B answers A")));
  check("4c the cycle closed without waiting out a bound", Date.now() - t0 < 60_000, `${Date.now() - t0} ms`);
  const dA = await A.next(RUN);
  await A.delivered(dA);
  await A.reply(dA, T("item 4c: A answers C"));
  const cGets = await C.next(RUN);
  await C.delivered(cGets);
  check("4c C's request to A completes too", cGets.message.text === T("item 4c: A answers C"));
}

// --- 5. A group request waited on by one agent returns both answers; with Lee in the group, Lee is "in their inbox".
{
  log("item 5");
  const g = await admin.mutation(api.conversations.createGroup, { title: "acceptance 5", members: ["smoke-a", "smoke-b", "cc-a", "lee"] });
  const run = comms(["send", "--as", "smoke-a", "--conversation", g.conversation.id, "@smoke-b", "@cc-a", "@lee", T("item 5: everyone?")]);
  const [dB, dC] = [await B.next(RUN), await C.next(RUN)];
  await B.delivered(dB);
  await C.delivered(dC);
  await B.reply(dB, T("item 5: B here"));
  await sleep(1_000);
  await C.reply(dC, T("item 5: C here"));
  const r = await run;
  log("cli", r);
  check("5 both agents' answers come back in the call; Lee is listed in their inbox", r.code === 0 && r.stdout.includes(T("item 5: B here")) && r.stdout.includes(T("item 5: C here")) && /→ @lee: in their inbox/.test(r.stdout));
  const id = idOf(r.stdout);
  const s = await status("smoke-a", id);
  check("5 one answer didn't close the other's result: both answered/acknowledged separately", s.wait.results.every((x) => x.state === "acknowledged" || x.state === "answered"), s.wait.results.map((x) => [x.recipient.name, x.state]));
  const inbox = await admin.query(api.inbox.list, { human: "lee", limit: 5 });
  const mine = inbox.items.find((i) => i.message.id === id);
  check("5 the message is in Lee's inbox, unread", mine && mine.readAt === null);
  if (mine) await admin.mutation(api.inbox.markRead, { human: "lee", messageIds: [id] });
}

for (const s of [A, B, C]) await s.unregister();
log(process.exitCode ? "SOME FAILED" : "ALL PASS");
