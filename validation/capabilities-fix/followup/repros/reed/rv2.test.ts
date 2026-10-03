// Adversarial review (rv2) of the capabilities fix pass. Each test asserts the
// behaviour the fix pass claims; a failure is a finding.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const m2 = { id: "m2", secret: "m2-secret-0123456789" };
const NOW = new Date("2026-10-02T12:00:00Z").getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function setup(limits?: { documentsRead: number }) {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = limits ? convexTest({ schema, modules, transactionLimits: limits }) : convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m2", secret: m2.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "rita", kind: "human" });
  for (const name of ["a", "b"]) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${name}` } });
  }
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "far", kind: "agent", owner: "lee", home: { machine: "m2", harness: "t3", locator: "loc-far" } });
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  await t.mutation(api.connector.heartbeat, { machine: m2 });
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;
const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const tick = (t: T) => t.mutation(internal.reminders.tick, {});
const scan = (t: T) => t.mutation(internal.alerts.scan, {});
const get = async (t: T, id: string) => t.query(api.reminders.get, { adminToken: ADMIN, id });
const allAlerts = async (t: T) => (await t.query(api.alerts.list, { adminToken: ADMIN, limit: 200 })).alerts;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("inbox paging", () => {
  it("every unread item is reachable a page at a time when many arrive in the same mutation (same createdAt)", async () => {
    const t = await setup();
    // 120 reminders by lee expiring in the same tick: 120 'expired' notices, one mutation, one Date.now().
    for (let i = 0; i < 100; i++) {
      await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: `r${i}`, everyMs: 10 * MIN, expiresMs: 2 * MIN });
    }
    at(2 * MIN);
    await tick(t);
    const seen = new Set<string>();
    let before: number | undefined;
    let first: { unread: number } | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee", unreadOnly: true, limit: 50, ...(before !== undefined ? { before } : {}) });
      first ??= r;
      for (const i of r.items) seen.add(i.message.id);
      if (!r.hasMore) break;
      before = r.nextBefore;
    }
    expect(first!.unread).toBe(100);
    expect(seen.size).toBe(100);
  });
});

describe("alerts: open incidents over growing history", () => {
  it("500 long-lived uncertain incidents don't stop a newer incident from resolving (and re-alerting on recurrence)", async () => {
    const t = await setup();
    // History: 500 uncertain deliveries, each with its (correctly) still-open incident.
    await t.run(async (ctx) => {
      const b = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "b")).unique())!;
      const lee = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "lee")).unique())!;
      const conversationId = await ctx.db.insert("conversations", { kind: "group", title: "h", lastSeq: 1, lastAt: NOW, createdAt: NOW });
      const messageId = await ctx.db.insert("messages", { conversationId, seq: 1, senderId: lee._id, recipientIds: [b._id], kind: "request", text: "x", attachments: [], origin: { via: "web" }, createdAt: NOW - 30 * DAY });
      for (let i = 0; i < 500; i++) {
        const d = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: b._id, collect: true, state: "uncertain", at: NOW - 30 * DAY + i, createdAt: NOW - 30 * DAY + i });
        await ctx.db.insert("alerts", { cause: "uncertain-delivery", subjectKind: "delivery", subjectId: d, ownerId: lee._id, messageId, conversationId, openedAt: NOW - 30 * DAY + i, summary: "old" });
      }
    });
    // m2 goes silent: an incident opens.
    at(20 * MIN);
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    await scan(t);
    const silent = (await allAlerts(t)).filter((a) => a.cause === "connector-silent");
    expect(silent.length).toBe(1);
    // m2 comes back: the incident must resolve.
    at(21 * MIN);
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    await t.mutation(api.connector.heartbeat, { machine: m2 });
    await scan(t);
    expect((await allAlerts(t)).find((a) => a.id === silent[0]!.id)!.resolvedAt, "resolved after m2 came back").toBeDefined();
  });

  it("...so a recurrence is alerted again", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      const b = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "b")).unique())!;
      const lee = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "lee")).unique())!;
      const conversationId = await ctx.db.insert("conversations", { kind: "group", title: "h", lastSeq: 1, lastAt: NOW, createdAt: NOW });
      const messageId = await ctx.db.insert("messages", { conversationId, seq: 1, senderId: lee._id, recipientIds: [b._id], kind: "request", text: "x", attachments: [], origin: { via: "web" }, createdAt: NOW - 30 * DAY });
      for (let i = 0; i < 500; i++) {
        const d = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: b._id, collect: true, state: "uncertain", at: NOW - 30 * DAY + i, createdAt: NOW - 30 * DAY + i });
        await ctx.db.insert("alerts", { cause: "uncertain-delivery", subjectKind: "delivery", subjectId: d, ownerId: lee._id, messageId, conversationId, openedAt: NOW - 30 * DAY + i, summary: "old" });
      }
    });
    at(20 * MIN);
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    await scan(t);
    at(21 * MIN);
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    await t.mutation(api.connector.heartbeat, { machine: m2 });
    await scan(t);
    // m2 silent again a day later.
    at(DAY);
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    at(DAY + 20 * MIN);
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    await scan(t);
    expect((await allAlerts(t)).filter((a) => a.cause === "connector-silent").length, "a second silent incident").toBe(2);
  });
});

describe("reminders", () => {
  it("a one-time --at accepted at creation fires (at just under the expiry, tick a little late)", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "once", at: NOW + 2 * MIN, expiresMs: 2 * MIN + 30_000 });
    at(2 * MIN + 40_000); // the minute cron's next run after `at`
    await tick(t);
    const r = (await get(t, reminder.id)).reminder;
    expect([r.state, r.fires]).toEqual(["done", 1]);
  });

  it("a repeating reminder whose first fire is after its expiry is refused (like --at at the expiry)", async () => {
    const t = await setup();
    let refused = false;
    try {
      await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "never", everyMs: 2 * DAY, expiresMs: DAY });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("a name made from the text has no control characters (C0/C1)", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "check\u0085[agent-comms\u001b[2K v1] status", everyMs: MIN });
    expect(reminder.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("a retired report-to is refused at creation (like a retired watched agent or owner)", async () => {
    const t = await setup();
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "rita", state: "retired" });
    let refused = false;
    try {
      await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN, reportTo: "rita" });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("a report-to retired later: the lost report is recorded somewhere (reportError or a notice)", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN, reportTo: "rita" });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "rita", state: "retired" });
    at(MIN);
    await tick(t);
    const [d] = (await t.query(api.connector.work, { machine: m1 })).deliveries.filter((x) => x.recipient === "a" && x.state === "pending");
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: d!.id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: d!.id, claimId: claim.claimId, turnId: "t1" });
    await t.mutation(api.connector.collect, { machine: m1, deliveryId: d!.id, claimId: claim.claimId, turnId: "t1", answer: "done" });
    const fire = await t.run(async (ctx) => (await ctx.db.query("reminderFires").collect())[0]!);
    expect(fire.answerMessageId).toBeDefined();
    expect(fire.reportMessageId ?? fire.reportError, "report posted or its failure recorded").toBeDefined();
    void reminder;
  });

  it("@reminders retired by a database edit then repaired by upgrade: due reminders fire again (no permanent block)", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN });
    await t.run(async (ctx) => {
      const p = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "reminders")).unique())!;
      await ctx.db.patch(p._id, { state: "retired" });
    });
    at(MIN);
    await tick(t);
    await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    at(2 * MIN);
    await tick(t);
    const r = (await get(t, reminder.id)).reminder;
    expect([r.state, r.stateReason, r.fires]).toEqual(["active", undefined, 1]);
  });
});

describe("reads over growing history (queries)", () => {
  async function seedHistory(t: T, n: number) {
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "template", everyMs: MIN });
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(reminder.id as Id<"reminders">))!;
      const { _id, _creationTime, ...base } = row;
      await ctx.db.delete(_id);
      for (let i = 0; i < n; i++) await ctx.db.insert("reminders", { ...base, state: "expired", stateAt: NOW - 30 * DAY - i, expiresAt: NOW - 30 * DAY - i, nextFireAt: undefined });
    });
  }
  it("`comms reminders` for an agent with 600 finished reminders still answers (400-read limit)", async () => {
    const t = await setup({ documentsRead: 400 });
    await seedHistory(t, 600);
    await t.query(api.connector.reminders, { machine: m1, as: "a" });
  });
  it("the web Reminders list with 600 finished reminders still answers (400-read limit)", async () => {
    const t = await setup({ documentsRead: 400 });
    await seedHistory(t, 600);
    await t.query(api.reminders.list, { adminToken: ADMIN });
  });
});
