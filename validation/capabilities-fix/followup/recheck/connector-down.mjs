// Follow-up re-check: the installed CLI, the installed connector killed mid-send and kept down.
// The connector is frozen (SIGSTOP) so the send connects but gets no answer, then stopped and
// kept down: the CLI retries with its key, gives up with exit 3 and prints --key; a rerun with
// that key, once the connector is back, posts once.
import { execFileSync } from "node:child_process";
import { admin, api, check, comms, connectorPid, connectorUp, journalTo, log, sleep } from "../../../capabilities/acceptance/lib.mjs";
journalTo(new URL("./connector-down.journal.txt", import.meta.url).pathname);
const env = { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
const sys = (...a) => execFileSync("systemctl", ["--user", ...a], { env, stdio: "pipe" }).toString().trim();

const text = `[recheck ${Date.now().toString(36)}] connector down on retry`;
const pid = connectorPid();
log(`connector pid ${pid}; freezing it`);
process.kill(pid, "SIGSTOP");
const run = comms(["send", "--as", "smoke-a", "--continue", "@smoke-b", text], { timeoutMs: 120_000 });
await sleep(1_500); // the CLI has connected and sent its request; nobody answers
log("stopping the connector (and keeping it down)");
sys("stop", "agent-comms-connector.service");
try {
  process.kill(pid, "SIGCONT"); // let a stopped process finish dying, if systemd hasn't already
} catch {}
const r = await run;
log("cli", r);
const key = /--key (\S+)/.exec(r.stderr)?.[1];
check("the CLI gave up with exit 3 (unreachable) and printed its --key", r.code === 3 && !!key, { code: r.code, key });
let state;
try {
  state = sys("is-active", "agent-comms-connector.service");
} catch (e) {
  state = String(e.stdout ?? "").trim(); // is-active exits non-zero when the unit isn't active
}
log(`connector state while the CLI gave up: ${state}`);
sys("start", "agent-comms-connector.service");
await connectorUp();
log(`connector back, pid ${connectorPid()}`);
const again = await comms(["send", "--as", "smoke-a", "--continue", "--key", key, "@smoke-b", text]);
const again2 = await comms(["send", "--as", "smoke-a", "--continue", "--key", key, "@smoke-b", text]);
log("rerun", again.stdout.trim(), "| rerun again", again2.stdout.trim());
const id1 = /^sent (\S+)/m.exec(again.stdout)?.[1];
const id2 = /^sent (\S+)/m.exec(again2.stdout)?.[1];
const { conversations } = await admin.query(api.conversations.list);
let copies = 0;
for (const c of conversations.slice(0, 10)) {
  const v = await admin.query(api.conversations.view, { conversationId: c.id, limit: 50 });
  copies += v.messages.filter((m) => m.message.text === text).length;
}
check("a rerun with the key posts it once (and a second rerun returns the same message)", again.code === 0 && id1 === id2 && copies === 1, { id1, id2, copies });
log(process.exitCode ? "SOME FAILED" : "ALL PASS");
