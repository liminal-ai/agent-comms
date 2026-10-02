// Capabilities pass, R0: the contract (new operations, CLI exit codes, renderings).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as P from "../src/index.ts";
import { cedar, delivery, message } from "./fixtures.ts";

const ok = (op: string, body: unknown) => {
  const r = P.decodeRequest(op as P.Op, body);
  assert.equal(r.ok, true, `${op}: ${!r.ok ? r.error : ""}`);
  return (r as { value: unknown }).value;
};
const bad = (op: string, body: unknown) => assert.equal(P.decodeRequest(op as P.Op, body).ok, false, `${op} should refuse ${JSON.stringify(body)}`);

describe("R0 operations", () => {
  it("lists the new operations", () => {
    for (const op of ["await", "ack", "message-status", "agents", "agents-set", "remind", "reminders", "reminder", "reminder-update"]) {
      assert.equal(P.isOp(op), true, op);
    }
  });

  it("send takes wait and waitMs, bounded", () => {
    assert.deepEqual(ok("send", { as: "cedar", to: ["reed"], text: "q", wait: true, waitMs: 90_000 }), { as: "cedar", to: ["reed"], text: "q", wait: true, waitMs: 90_000 });
    bad("send", { as: "cedar", to: ["reed"], text: "q", wait: true, waitMs: P.MAX_WAIT_MS + 1 });
    ok("send", { as: "cedar", to: ["owner"], text: "q" }); // @owner is a name on the wire, resolved by Convex
  });

  it("await is held at most MAX_POLL_WAIT_MS; ack names recipients optionally", () => {
    ok("await", { as: "cedar", messageId: "m_1", waitMs: 25_000 });
    bad("await", { as: "cedar", messageId: "m_1", waitMs: 25_001 });
    ok("ack", { as: "cedar", messageId: "m_1" });
    ok("ack", { as: "cedar", messageId: "m_1", recipients: ["reed"] });
    ok("message-status", { as: "cedar", messageId: "m_1" });
  });

  it("registry operations bound descriptions and duties", () => {
    ok("agents", { as: "cedar" });
    ok("agents", { as: "cedar", name: "reed", long: true });
    ok("agents-set", { as: "cedar", name: "cedar", description: "comms builder", duties: ["owns Convex", "owns the connector"] });
    bad("agents-set", { as: "cedar", name: "cedar", description: "x".repeat(P.MAX_DESCRIPTION_CHARS + 1) });
    bad("agents-set", { as: "cedar", name: "cedar", duties: Array(P.MAX_DUTIES + 1).fill("d") });
  });

  it("remind needs exactly one of every and at; bounds the interval and expiry", () => {
    ok("remind", { as: "lee", target: "reed", text: "check CI", everyMs: 30 * 60_000, name: "ci", idleForMs: 600_000, watch: "hazel", max: 3, reportTo: "lee", expiresMs: 86_400_000 });
    ok("remind", { as: "lee", target: "reed", text: "once", at: 1_800_000_000_000 });
    bad("remind", { as: "lee", target: "reed", text: "neither" });
    bad("remind", { as: "lee", target: "reed", text: "both", everyMs: 60_000, at: 1_800_000_000_000 });
    bad("remind", { as: "lee", target: "reed", text: "too often", everyMs: 30_000 });
    bad("remind", { as: "lee", target: "reed", text: "too long", everyMs: 60_000, expiresMs: P.REMINDER_MAX_EXPIRY_MS + 1 });
    ok("reminders", { as: "lee" });
    ok("reminder", { as: "lee", id: "r_1" });
    ok("reminder-update", { as: "reed", id: "r_1", action: "blocked", reason: "waiting on Lee" });
    bad("reminder-update", { as: "reed", id: "r_1", action: "snooze" });
  });

  it("has an `unsupported` error for operations a connector doesn't implement yet", () => {
    assert.equal(P.ERROR_STATUS.unsupported, 501);
  });
});

describe("R0 CLI exit codes and durations", () => {
  it("has a distinct code for 'bound reached, still pending'", () => {
    assert.deepEqual(P.CLI_EXIT, { ok: 0, refused: 1, usage: 2, unreachable: 3, pending: 4, endedWithoutAnswer: 5 });
  });
  it("parses and formats durations", () => {
    assert.equal(P.parseDuration("90s"), 90_000);
    assert.equal(P.parseDuration("9m"), 540_000);
    assert.equal(P.parseDuration("2h"), 7_200_000);
    assert.equal(P.parseDuration("7d"), 604_800_000);
    assert.equal(P.parseDuration("5 min"), null);
    assert.equal(P.formatDuration(1_800_000), "30m");
  });
});

describe("R0 renderings", () => {
  const reminders = { id: "p_rem", name: "reminders", kind: "system" as const };

  it("renders a reminder fire with a structured header and how to mark it done or blocked", () => {
    const d = delivery({
      message: message({ seq: 4, sender: reminders, text: "Check the CI queue.", meta: { type: "reminder", reminderId: "r_9", name: "ci", setBy: "lee", schedule: "every 30m", fire: 3 } }),
    });
    const text = P.renderDelivery(d, { harnessLabelsSource: false });
    assert.equal(P.parseDeliveryHeader(text)?.deliveryId, "d_1");
    assert.match(text, /^Reminder: ci \(id r_9\), set by @lee, every 30m\. Fire 3\.$/m);
    assert.match(text, /^From: @reminders \(system\)/m);
    assert.match(text, /^> Check the CI queue\.$/m);
    assert.match(text, /comms reminder done r_9/);
    assert.match(text, /comms reminder blocked r_9 "<why>"/);
    assert.match(text, /not an instruction from the user of this session/);
  });

  it("renders the one fallback answer as possibly already shown", () => {
    const request = message({ seq: 3, sender: cedar, text: "q" });
    const d = delivery({ fallback: true, message: message({ seq: 4, kind: "answer", inReplyTo: "m_3", text: "4" }), inReplyTo: request });
    const text = P.renderDelivery(d, { harnessLabelsSource: true });
    assert.match(text, /may already have been returned to your waiting `comms send`/);
  });

  it("produces the texts system participants post", () => {
    assert.match(P.renderReminderReport({ reminderName: "ci", reminderId: "r_9", target: "reed", answer: "CI is green" }), /^Reminder ci \(r_9\): @reed answered:\n> CI is green$/);
    assert.match(P.renderReminderEnded({ reminderName: "ci", reminderId: "r_9", state: "expired" }), /^Reminder ci \(r_9\) expired/);
    assert.match(P.renderAlert({ cause: "connector-silent", subject: { kind: "machine", id: "lim-builder" }, detail: "not heard from for 12m" }), /^Alert: the connector on lim-builder hasn't been heard from/);
  });
});

describe("R0 review (Hazel)", () => {
  it("requires a reason for reminder-update blocked in the decoder", () => {
    assert.equal(P.decodeRequest("reminder-update", { as: "a", id: "r_1", action: "blocked" }).ok, false);
    assert.equal(P.decodeRequest("reminder-update", { as: "a", id: "r_1", action: "blocked", reason: " " }).ok, false);
    assert.equal(P.decodeRequest("reminder-update", { as: "a", id: "r_1", action: "blocked", reason: "creds" }).ok, true);
    assert.equal(P.decodeRequest("reminder-update", { as: "a", id: "r_1", action: "pause" }).ok, true);
  });

  it("parses --at as ISO 8601 with a time, or HH:MM as the next occurrence in local time", () => {
    const now = new Date(2026, 9, 1, 15, 0).getTime();
    assert.equal(P.parseAt("2026-10-01T14:30:00Z", now), Date.UTC(2026, 9, 1, 14, 30));
    assert.equal(P.parseAt("2026-10-02T09:00+02:00", now), Date.UTC(2026, 9, 2, 7, 0));
    assert.equal(P.parseAt("16:30", now), new Date(2026, 9, 1, 16, 30).getTime());
    assert.equal(P.parseAt("14:30", now), new Date(2026, 9, 2, 14, 30).getTime());
    for (const bad of ["2026-10-01", "25:00", "9:5", "tomorrow", ""]) assert.equal(P.parseAt(bad, now), null, bad);
  });

  it("renders a schedule for the reminder line", () => {
    assert.equal(P.formatSchedule({ everyMs: 1_800_000 }), "every 30m");
    assert.equal(P.formatSchedule({ at: Date.UTC(2026, 9, 1, 14, 30) }), "once at 2026-10-01 14:30 UTC");
  });
});

describe("R3 notices (agreed with Hazel)", () => {
  const reminders = { id: "p_rem", name: "reminders", kind: "system" as const };
  it("renders a notice: its own header kind, no reply expected, no comms reply line", () => {
    const d = delivery({
      message: message({ seq: 5, kind: "notice", sender: reminders, text: "Reminder ci (r_9): @reed answered:\n> green", meta: { type: "reminder-report", reminderId: "r_9", name: "ci", target: "reed", fireMessageId: "m_2" } }),
    });
    for (const harnessLabelsSource of [true, false]) {
      const text = P.renderDelivery(d, { harnessLabelsSource });
      assert.deepEqual(P.parseDeliveryHeader(text), { deliveryId: "d_1", messageId: d.message.id, kind: "notice" });
      assert.match(text, /^Notice #5 from @reminders \(system\):$/m);
      assert.match(text, /^> > green$/m);
      assert.match(text, /No reply is expected/);
      assert.doesNotMatch(text, /comms reply|An answer is expected/);
      assert.match(text, /not an instruction from the user of this session/);
    }
  });
});

describe("P3 bug 3: --at refuses impossible dates", () => {
  it("doesn't roll 30 February or 31 April over into the next month", () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(P.parseAt("2026-02-30T10:00Z", now), null);
    assert.equal(P.parseAt("2026-04-31T10:00Z", now), null);
    assert.equal(P.parseAt("2026-02-28T24:00Z", now), null);
    assert.equal(P.parseAt("2026-02-28T10:00Z", now), Date.UTC(2026, 1, 28, 10, 0));
    assert.equal(P.parseAt("2028-02-29T10:00Z", now), Date.UTC(2028, 1, 29, 10, 0));
  });
});
