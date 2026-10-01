// W (capabilities pass): the web view's logic for the registry, reminders, the
// inbox and alerts. Pure functions, so they're tested without a browser.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Alert, Reminder, RegistryEntry } from "@agent-comms/protocol";
import {
  alertConfigForm,
  alertLabel,
  alertsBadge,
  inboxBadge,
  inboxKind,
  liveStale,
  parseAlertConfig,
  parseProfile,
  parsePromotion,
  parseReminderForm,
  presenceView,
  reminderActions,
  reminderLast,
  reminderLine,
  scheduleText,
  titleWithUnread,
} from "../src/lib/view.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const ref = (name: string, kind: "agent" | "human" | "system" = "agent") => ({ id: `p_${name}`, name, kind });

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    participant: ref("cedar"),
    state: "active",
    presence: { status: "idle", at: NOW - MIN, idleSince: NOW - 12 * MIN, stale: false },
    harness: "t3",
    ...over,
  };
}

function reminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: "r_1",
    name: "ci",
    text: "Check the CI queue.",
    target: ref("reed"),
    createdBy: ref("lee", "human"),
    schedule: { everyMs: 30 * MIN },
    state: "active",
    stateAt: NOW - 60 * MIN,
    fires: 2,
    nextFireAt: NOW + 5 * MIN,
    expiresAt: NOW + 6 * 24 * 60 * MIN,
    createdAt: NOW - 60 * MIN,
    ...over,
  };
}

describe("W registry", () => {
  it("W registry: an idle agent shows how long it has been idle", () => {
    assert.deepEqual(presenceView(entry(), NOW), { status: "idle", label: "idle for 12m" });
  });

  it("W registry: a stale machine is never shown as idle, whatever was last written", () => {
    const v = presenceView(entry({ presence: { status: "idle", at: NOW - 10 * MIN, idleSince: NOW - 60 * MIN, stale: true } }), NOW);
    assert.equal(v.status, "stale");
    assert.match(v.label, /connector not heard from/);
  });

  it("W registry: busy, offline, people and system participants", () => {
    assert.equal(presenceView(entry({ presence: { status: "busy", at: NOW, stale: false } }), NOW).status, "busy");
    assert.equal(presenceView(entry({ presence: { status: "offline", at: NOW, stale: false } }), NOW).status, "offline");
    assert.equal(
      presenceView(entry({ harness: "claude-code", presence: { status: "offline", at: NOW, stale: false } }), NOW).label,
      "mod not connected",
    );
    assert.deepEqual(presenceView(entry({ participant: ref("lee", "human"), presence: null }), NOW), { status: "person", label: "person" });
    assert.deepEqual(presenceView(entry({ participant: ref("reminders", "system"), presence: null }), NOW), { status: "system", label: "system" });
  });

  it("W registry: a profile edit is one description line and one duty per line, blanks dropped", () => {
    assert.deepEqual(parseProfile("  Owns the contract.  ", "Convex\n\n  the connector \n"), {
      ok: true,
      value: { description: "Owns the contract.", duties: ["Convex", "the connector"] },
    });
    // Empty clears (the Convex function takes "" and [] as clear).
    assert.deepEqual(parseProfile("", ""), { ok: true, value: { description: "", duties: [] } });
  });

  it("W registry: a profile edit over the protocol's limits is refused before it's sent", () => {
    assert.equal(parseProfile("x".repeat(201), "").ok, false);
    assert.equal(parseProfile("ok", Array.from({ length: 11 }, (_, i) => `duty ${i}`).join("\n")).ok, false);
    assert.equal(parseProfile("ok", "y".repeat(301)).ok, false);
    assert.equal(parseProfile("two\nlines", "").ok, false);
  });
});

describe("W registry, promotion (R1 API)", () => {
  const base = { name: "oak", harness: "t3" as const, machine: "lim-builder", locator: " thr-1 ", owner: "lee" };
  it("W promote: an agent is promoted with its owner (a person), as R1's directory.promote requires", () => {
    assert.deepEqual(parsePromotion(base, ["lee"]), {
      ok: true,
      value: { name: "oak", kind: "agent", home: { machine: "lim-builder", harness: "t3", locator: "thr-1" }, owner: "lee" },
    });
    assert.deepEqual(parsePromotion({ ...base, harness: "claude-code", locator: "" }, ["lee"]), {
      ok: true,
      value: { name: "oak", kind: "agent", home: { machine: "lim-builder", harness: "claude-code", locator: "oak" }, owner: "lee" },
    });
  });

  it("W promote: reserved names, bad names, a missing thread id or machine, and an owner who isn't a person are refused", () => {
    for (const name of ["owner", "all", "reminders", "alerts"]) assert.equal(parsePromotion({ ...base, name }, ["lee"]).ok, false, name);
    assert.equal(parsePromotion({ ...base, name: "Oak" }, ["lee"]).ok, false);
    assert.equal(parsePromotion({ ...base, locator: " " }, ["lee"]).ok, false);
    assert.equal(parsePromotion({ ...base, machine: "" }, ["lee"]).ok, false);
    assert.equal(parsePromotion({ ...base, owner: "cedar" }, ["lee"]).ok, false);
    assert.equal(parsePromotion({ ...base, owner: "" }, ["lee"]).ok, false);
  });
});

describe("W registry, live", () => {
  it("W registry: a machine that stops heartbeating turns stale on the clock, not only when Convex next writes", () => {
    const e = entry({ home: { machine: "m1", harness: "t3", locator: "thr-1" } });
    assert.equal(liveStale(e, NOW - 30_000, NOW).presence?.stale, false);
    assert.equal(liveStale(e, NOW - 90_000, NOW).presence?.stale, true);
    assert.equal(liveStale(e, null, NOW).presence?.stale, true, "never heard from");
    const person = entry({ participant: ref("lee", "human"), presence: null });
    assert.equal(liveStale(person, null, NOW).presence, null);
  });
});

describe("W reminders", () => {
  it("W reminders: the controls offered follow the state; ended reminders have none", () => {
    assert.deepEqual(reminderActions("active"), ["pause", "blocked", "done", "cancel"]);
    assert.deepEqual(reminderActions("paused"), ["resume", "done", "cancel"]);
    assert.deepEqual(reminderActions("blocked"), ["resume", "done", "cancel"]);
    for (const s of ["done", "cancelled", "expired"] as const) assert.deepEqual(reminderActions(s), []);
  });

  it("W reminders: the schedule reads like the rendering (every 30m, once at a time), with its conditions", () => {
    assert.equal(scheduleText(reminder()), "every 30m");
    assert.match(scheduleText(reminder({ schedule: { at: NOW + 90 * MIN } })), /^once at /);
    assert.equal(
      scheduleText(reminder({ idleForMs: 20 * MIN, watch: ref("hazel"), max: 3 })),
      "every 30m, once @hazel has been idle 20m, at most 3 fires",
    );
    assert.equal(scheduleText(reminder({ idleForMs: 20 * MIN })), "every 30m, once @reed has been idle 20m");
  });

  it("W reminders: the status line says the state, fires, next fire and why it's blocked", () => {
    assert.equal(reminderLine(reminder(), NOW), "active · 2 fires · next in 5m");
    assert.equal(reminderLine(reminder({ max: 3 }), NOW), "active · 2 of 3 fires · next in 5m");
    assert.equal(reminderLine(reminder({ state: "blocked", stateReason: "waiting on Lee", nextFireAt: undefined }), NOW), "blocked: waiting on Lee · 2 fires");
    assert.equal(reminderLine(reminder({ state: "active", nextFireAt: NOW - MIN }), NOW), "active · 2 fires · due now");
  });

  it("W reminders: the list shows the last fire's delivery state and the last skip, whichever is newer", () => {
    assert.equal(reminderLast(reminder(), NOW), null, "never fired or skipped");
    const fired = reminder({ lastFire: { messageId: "m_3", deliveryState: "replied", firedAt: NOW - 25 * MIN } });
    assert.equal(reminderLast(fired, NOW), "last fire 25m ago: replied");
    const skipped = reminder({
      lastFire: { messageId: "m_3", deliveryState: "delivered", firedAt: NOW - 31 * MIN },
      lastSkip: { at: NOW - MIN, reason: "previous-fire-not-final" },
    });
    assert.equal(reminderLast(skipped, NOW), "skipped 1m ago: previous fire not final (last fire 31m ago: delivered)");
  });

  it("W reminders: the create form becomes reminders.create arguments", () => {
    const r = parseReminderForm(
      { target: "@reed", text: " Check CI. ", every: "30m", at: "", name: "ci", idleFor: "20m", watch: "@hazel", max: "3", reportTo: "@lee", expires: "2d" },
      NOW,
    );
    assert.deepEqual(r, {
      ok: true,
      value: { target: "reed", text: "Check CI.", everyMs: 30 * MIN, name: "ci", idleForMs: 20 * MIN, watch: "hazel", max: 3, reportTo: "lee", expiresMs: 2 * 24 * 60 * MIN },
    });
    const once = parseReminderForm({ target: "reed", text: "Ping", every: "", at: new Date(NOW + 60 * MIN).toISOString(), name: "", idleFor: "", watch: "", max: "", reportTo: "", expires: "" }, NOW);
    assert.deepEqual(once, { ok: true, value: { target: "reed", text: "Ping", at: NOW + 60 * MIN } });
  });

  it("W reminders: the create form refuses what Convex would (both or neither schedule, under a minute, past, too long)", () => {
    const base = { target: "reed", text: "x", every: "", at: "", name: "", idleFor: "", watch: "", max: "", reportTo: "", expires: "" };
    assert.equal(parseReminderForm(base, NOW).ok, false, "neither");
    assert.equal(parseReminderForm({ ...base, every: "30m", at: new Date(NOW + MIN).toISOString() }, NOW).ok, false, "both");
    assert.equal(parseReminderForm({ ...base, every: "30s" }, NOW).ok, false, "under a minute");
    assert.equal(parseReminderForm({ ...base, every: "thirty" }, NOW).ok, false, "not a duration");
    assert.equal(parseReminderForm({ ...base, at: new Date(NOW - MIN).toISOString() }, NOW).ok, false, "past");
    assert.equal(parseReminderForm({ ...base, every: "1h", expires: "31d" }, NOW).ok, false, "over 30 days");
    assert.equal(parseReminderForm({ ...base, every: "1h", text: "  " }, NOW).ok, false, "no text");
    assert.equal(parseReminderForm({ ...base, every: "1h", max: "0" }, NOW).ok, false, "max under 1");
  });
});

describe("W inbox", () => {
  it("W inbox: the badge and the page title carry the unread count", () => {
    assert.equal(inboxBadge(0), "Inbox");
    assert.equal(inboxBadge(3), "Inbox (3)");
    assert.equal(titleWithUnread("agent comms", 0), "agent comms");
    assert.equal(titleWithUnread("agent comms", 3), "(3) agent comms");
  });
});

describe("W inbox, kinds", () => {
  it("W inbox: messages from system participants are labelled by what they are", () => {
    const m = (meta?: any) => ({ meta }) as any;
    assert.equal(inboxKind(m()), null);
    assert.equal(inboxKind(m({ type: "alert", alertId: "a", cause: "connector-silent", subject: { kind: "machine", id: "m1" } })), "Alert");
    assert.equal(inboxKind(m({ type: "reminder-report", reminderId: "r", name: "ci", target: "reed", fireMessageId: "m" })), "Reminder report: ci");
    assert.equal(inboxKind(m({ type: "reminder-ended", reminderId: "r", name: "ci", state: "expired" })), "Reminder ended: ci");
    assert.equal(inboxKind(m({ type: "reminder", reminderId: "r", name: "ci", setBy: "lee", schedule: "every 30m", fire: 2 })), "Reminder: ci");
  });
});

describe("W alerts", () => {
  const alert = (over: Partial<Alert> = {}): Alert => ({
    id: "a_1",
    cause: "uncertain-delivery",
    subject: { kind: "delivery", id: "d_9" },
    owner: ref("lee", "human"),
    messageId: "m_1",
    openedAt: NOW - 5 * MIN,
    summary: "delivery d_9 is uncertain",
    ...over,
  });

  it("W alerts: each cause has a plain label, and resolved incidents say so", () => {
    assert.equal(alertLabel(alert(), NOW), "Uncertain delivery · d_9 · open 5m");
    assert.equal(alertLabel(alert({ cause: "connector-silent", subject: { kind: "machine", id: "lim-builder" }, resolvedAt: NOW - MIN }), NOW), "Connector silent · lim-builder · resolved after 4m");
    for (const cause of ["reminder-blocked", "reminder-expired", "delivery-reclaimed"] as const) {
      assert.doesNotMatch(alertLabel(alert({ cause }), NOW), /undefined/);
    }
  });

  it("W alerts: the badge counts open incidents only", () => {
    assert.equal(alertsBadge([alert(), alert({ id: "a_2", resolvedAt: NOW })]), "Alerts (1)");
    assert.equal(alertsBadge([]), "Alerts");
  });

  it("W alerts: thresholds are edited in minutes and checked against Convex's ranges", () => {
    assert.deepEqual(alertConfigForm({ connectorSilentMs: 10 * MIN, reminderBlockedMs: 60 * MIN, maxClaims: 5 }), {
      connectorSilentMin: "10",
      reminderBlockedMin: "60",
      maxClaims: "5",
    });
    assert.deepEqual(parseAlertConfig({ connectorSilentMin: "15", reminderBlockedMin: "120", maxClaims: "4" }), {
      ok: true,
      value: { connectorSilentMs: 15 * MIN, reminderBlockedMs: 120 * MIN, maxClaims: 4 },
    });
    assert.equal(parseAlertConfig({ connectorSilentMin: "1", reminderBlockedMin: "60", maxClaims: "5" }).ok, false);
    assert.equal(parseAlertConfig({ connectorSilentMin: "10", reminderBlockedMin: "0", maxClaims: "5" }).ok, false);
    assert.equal(parseAlertConfig({ connectorSilentMin: "10", reminderBlockedMin: "60", maxClaims: "1" }).ok, false);
    assert.equal(parseAlertConfig({ connectorSilentMin: "10", reminderBlockedMin: "60", maxClaims: "2.5" }).ok, false);
  });
});
