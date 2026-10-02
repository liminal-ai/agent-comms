// Acceptance driver helpers: the installed connector's socket, scripted Claude Code
// sessions (what the mod does), the real comms CLI, and admin reads of the local
// Convex. The admin token is read from its file and never printed.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

export const SOCKET = "/run/user/1000/agent-comms/connector.sock";
export const api = anyApi;
const adminToken = readFileSync(`${process.env.HOME}/.config/agent-comms/admin-token`, "utf8").trim();
const convex = new ConvexHttpClient("http://127.0.0.1:3240");
export const admin = {
  query: (ref, args = {}) => convex.query(ref, { adminToken, ...args }),
  mutation: (ref, args = {}) => convex.mutation(ref, { adminToken, ...args }),
};

let journal;
export function journalTo(path) {
  journal = path;
}
export function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  console.log(line);
  if (journal) appendFileSync(journal, line + "\n");
}
export function check(name, ok, detail) {
  log(`${ok ? "PASS" : "FAIL"} ${name}`, detail ?? "");
  if (!ok) process.exitCode = 1;
  return ok;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(what, f, timeoutMs = 60_000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function call(op, body, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      { socketPath: SOCKET, path: `/v1/${op}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}
export async function ok(op, body) {
  const r = await call(op, body);
  if (!r.ok) throw new Error(`${op}: ${r.error.code}: ${r.error.message}`);
  return r;
}

/** A scripted Claude Code session: registers, polls, reports like the mod. */
export class Session {
  constructor(participant, sessionId = `acc-${participant}-${Date.now()}`) {
    this.participant = participant;
    this.sessionId = sessionId;
    this.queue = [];
    this.stopped = false;
    /** What this session knows, to answer restart checks truthfully, as the mod does. */
    this.turns = new Map();
    this.seen = [];
  }
  async answerCheck(c, { stale = false } = {}) {
    // Draining after an aborted run: that run's scripted turns are over; say so.
    if (stale && !this.turns.has(c.deliveryId) && c.state === "delivered") {
      this.turns.set(c.deliveryId, { turnId: c.turnId, outcome: { outcome: "replied", answer: "(stale: left over from an aborted acceptance run)" } });
    }
    const t = this.turns.get(c.deliveryId);
    const body = !t
      ? { found: "no" }
      : t.outcome
        ? { found: "yes", turnId: t.turnId, turn: "completed", ...t.outcome }
        : { found: "yes", turnId: t.turnId, turn: "running" };
    const r = await this.op("check-result", { deliveryId: c.deliveryId, ...body });
    log(`@${this.participant} check ${c.deliveryId} (${c.state}) → ${body.found}${body.turn ? `/${body.turn}` : ""}`, r.ok ? "" : r.error);
  }
  /** Settles anything left from an aborted run: checks answered, stale deliveries answered as stale. */
  async drain(ms = 4_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await this.op("poll", { waitMs: 1_000 });
      if (!r.ok) break;
      for (const item of r.items) {
        if (item.type === "check") await this.answerCheck(item.check, { stale: true });
        else {
          await this.delivered(item.delivery);
          if (item.delivery.message.kind === "request") await this.reply(item.delivery, "(stale: left over from an aborted acceptance run)");
          log(`@${this.participant} drained ${item.delivery.id}: ${item.delivery.message.text.slice(0, 60)}`);
        }
      }
    }
    return this;
  }
  async register(status = "idle") {
    await ok("register", { participant: this.participant, harness: "claude-code", sessionId: this.sessionId, cwd: "/acceptance", status });
    return this;
  }
  /** After a connector restart: register again (as the mod does) and answer its restart checks. */
  async reconnect(status = "busy", ms = 3_000) {
    await until(`@${this.participant} registered again`, async () => {
      await this.register(status);
      return true;
    }, 60_000, 500);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await this.op("poll", { waitMs: 500 });
      if (!r.ok) continue;
      for (const item of r.items) {
        if (item.type === "check") await this.answerCheck(item.check);
        else this.queue.push(item);
      }
    }
  }
  op(op, body = {}) {
    return call(op, { sessionId: this.sessionId, ...body });
  }
  async presence(status) {
    const r = await this.op("presence", { status });
    if (!r.ok) throw new Error(`presence: ${r.error.message}`);
    await until(`@${this.participant} ${status} in Convex`, async () => {
      const { agents } = await admin.query(api.registry.list);
      const p = agents.find((a) => a.participant.name === this.participant)?.presence;
      return p?.status === status;
    });
  }
  /** Polls until an item arrives (re-registering if the connector restarted). */
  async next(match = () => true, timeoutMs = 120_000, type = "deliver") {
    const deadline = Date.now() + timeoutMs;
    const want = typeof match === "string" ? (d) => d.message.text.includes(match) : match;
    while (Date.now() < deadline) {
      if (type === "deliver") {
        const j = this.seen.findIndex(want);
        if (j >= 0) return this.seen.splice(j, 1)[0];
      }
      const i = this.queue.findIndex((x) => x.type === type && (type !== "deliver" || want(x.delivery)));
      if (i >= 0) {
        const item = this.queue.splice(i, 1)[0];
        return item.type === "deliver" ? item.delivery : item;
      }
      // Answers and notices nobody is waiting for are finished at once (a live session's turn
      // would end), so they don't hold up the participant's queue; kept in case a later step wants them.
      for (let k = this.queue.length - 1; k >= 0; k--) {
        const x = this.queue[k];
        if (x.type === "deliver" && x.delivery.message.kind !== "request") {
          this.queue.splice(k, 1);
          await this.delivered(x.delivery);
          this.seen.push(x.delivery);
          log(`@${this.participant} finished ${x.delivery.message.kind} ${x.delivery.id}${x.delivery.fallback ? " (fallback)" : ""}: ${x.delivery.message.text.slice(0, 60)}`);
        }
      }
      if (this.background) {
        // A background poller (idle) is filling the queue: just wait for it.
        await sleep(250);
        continue;
      }
      let r;
      try {
        r = await this.op("poll", { waitMs: 5_000 });
      } catch {
        await sleep(1_000);
        continue;
      }
      if (!r.ok) {
        if (r.error.code === "unknown_session") await this.register().catch(() => {});
        else await sleep(500);
        continue;
      }
      for (const item of r.items) {
        if (item.type === "check" && type !== "check") await this.answerCheck(item.check);
        else this.queue.push(item);
      }
    }
    throw new Error(`@${this.participant}: no ${type} within ${timeoutMs} ms`);
  }
  /** Keeps polling for `ms` (as a live mod does), queueing deliveries and answering checks. */
  async idle(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await this.op("poll", { waitMs: Math.min(5_000, Math.max(0, end - Date.now())) }).catch(() => null);
      if (!r) {
        await sleep(1_000);
        continue;
      }
      if (!r.ok) {
        if (r.error.code === "unknown_session") await this.register().catch(() => {});
        continue;
      }
      for (const item of r.items) {
        if (item.type === "check") await this.answerCheck(item.check);
        else this.queue.push(item);
      }
    }
  }
  async delivered(d, turnId = `turn-${d.id}`) {
    this.turns.set(d.id, { turnId });
    return ok("delivered", { sessionId: this.sessionId, deliveryId: d.id, turnId });
  }
  async reply(d, answer, turnId = `turn-${d.id}`) {
    this.turns.set(d.id, { turnId, outcome: { outcome: "replied", answer } });
    return ok("outcome", { sessionId: this.sessionId, deliveryId: d.id, turnId, outcome: "replied", answer });
  }
  async unregister() {
    await call("unregister", { sessionId: this.sessionId }).catch(() => {});
  }
}

/** Runs the installed comms CLI; resolves with {code, stdout, stderr}; `.child` to kill it. */
export function comms(args, { timeoutMs = 300_000 } = {}) {
  const child = spawn("comms", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const done = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    }),
  );
  done.child = child;
  return done;
}

export const status = async (as, messageId) => (await ok("message-status", { as, messageId }));

export function connector(action) {
  const env = { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
  const args = action === "kill" ? ["--user", "kill", "-s", "KILL", "agent-comms-connector.service"] : ["--user", action, "agent-comms-connector.service"];
  try {
    execFileSync("systemctl", args, { env, stdio: "pipe" });
    log(`connector: systemctl ${args.slice(1).join(" ")}`);
  } catch (error) {
    // `kill` exits non-zero when it signalled the main process but not every process in the unit.
    log(`connector: systemctl ${args.slice(1).join(" ")} (exit ${error.status}: ${String(error.stderr).trim()})`);
  }
}
export async function connectorUp() {
  await until("connector answering", async () => (await call("status", {}, 3_000)).ok, 60_000, 500);
}

/** The connector unit's main PID (0 when not running). */
export function connectorPid() {
  const env = { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
  return Number(execFileSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", "agent-comms-connector.service"], { env }).toString().trim());
}
/** Whether a process exists. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
