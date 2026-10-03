// Fix pass 1.3: no fixed-size reads over growing history. 600 finished rows (expired
// reminders, answer deliveries, old uncertain deliveries) under a 400-document read
// limit must not hide a new expiry, reclaim or uncertain delivery, nor make a scan fail.
// Includes Alder's repros (historical expired reminders; 500 old expiries).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-02T12:00:00Z").getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HISTORY = 600;

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest({ schema, modules, transactionLimits: { documentsRead: 400 } });
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const name of ["a", "b"]) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${name}` } });
  }
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;

const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const beat = (t: T) => t.mutation(api.connector.heartbeat, { machine: m1 });
const alerts = async (t: T) => (await t.query(api.alerts.list, { adminToken: ADMIN, limit: 200 })).alerts;

/** One conversation and message, and `n` deliveries to @b of it in the given state, last changed `ago` ms before NOW. */
async function seedDeliveries(t: T, n: number, fields: { state: "delivered" | "uncertain" | "replied"; collect: boolean; ago: number; claimCount?: number }) {
  return t.run(async (ctx) => {
    const b = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "b")).unique())!;
    const conversationId = await ctx.db.insert("conversations", { kind: "group", title: "history", lastSeq: 1, lastAt: NOW, createdAt: NOW });
    const messageId = await ctx.db.insert("messages", {
      conversationId, seq: 1, senderId: b._id, recipientIds: [b._id], kind: "answer", text: "x", attachments: [], origin: { via: "cli" }, createdAt: NOW - fields.ago,
    });
    const ids: Id<"deliveries">[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(await ctx.db.insert("deliveries", {
        // History is already handled (follow-up 3: reported, as the upgrade's migration leaves it), unless it's the new item.
        ...(fields.ago > 0 ? { uncertainReported: true, reclaimReported: true } : {}),
        messageId, conversationId, recipientId: b._id, collect: fields.collect, state: fields.state, at: NOW - fields.ago - i,
        ...(fields.claimCount !== undefined ? { claimCount: fields.claimCount } : {}), createdAt: NOW - fields.ago - i,
      }));
    }
    return ids;
  });
}

/** `n` reminders already expired long ago. */
async function seedExpiredReminders(t: T, n: number) {
  const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "template", everyMs: MIN });
  await t.run(async (ctx) => {
    const row = (await ctx.db.get(reminder.id as Id<"reminders">))!;
    const { _id, _creationTime, ...base } = row;
    await ctx.db.delete(_id);
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("reminders", { ...base, state: "expired", stateAt: NOW - 30 * DAY - i, expiresAt: NOW - 30 * DAY - i, nextFireAt: undefined, expiryReported: true });
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("1.3 reminders: history doesn't hide an expiry", () => {
  it(`Alder's repro: ${HISTORY} expired reminders don't stop a newer one expiring, nor the expiry alert`, async () => {
    const t = await setup();
    await seedExpiredReminders(t, HISTORY);
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 10 * MIN, expiresMs: 2 * MIN });
    at(3 * MIN);
    await beat(t);
    await t.mutation(internal.reminders.tick, {});
    expect((await t.query(api.reminders.get, { adminToken: ADMIN, id: reminder.id })).reminder.state).toBe("expired");
    await t.mutation(internal.alerts.scan, {});
    expect((await alerts(t)).filter((a) => a.cause === "reminder-expired").map((a) => a.subject.id)).toEqual([reminder.id]);
  });

  it("the firing loop checks expiry itself: a reminder due to fire after it expired doesn't fire", async () => {
    const t = await setup();
    await seedExpiredReminders(t, HISTORY);
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 2 * MIN, expiresMs: 2 * MIN });
    // Due exactly at its expiry: the firing loop must see that itself, whatever the expiry scan read.
    at(2 * MIN);
    await t.mutation(internal.reminders.tick, {});
    const shown = await t.query(api.reminders.get, { adminToken: ADMIN, id: reminder.id });
    expect([shown.reminder.state, shown.reminder.fires]).toEqual(["expired", 0]);
  });
});

describe("1.3 alerts: history doesn't hide a new incident", () => {
  it(`${HISTORY} finished answer deliveries don't hide a delivery reclaimed too often`, async () => {
    const t = await setup();
    await seedDeliveries(t, HISTORY, { state: "delivered", collect: false, ago: DAY });
    const [hot] = await seedDeliveries(t, 1, { state: "delivered", collect: true, ago: 0, claimCount: 9 });
    await t.mutation(internal.alerts.scan, {});
    expect((await alerts(t)).map((a) => [a.cause, a.subject.id])).toEqual([["delivery-reclaimed", hot]]);
  });

  it(`${HISTORY} old uncertain deliveries (already reported) don't hide a new one, and an open incident stays open until it clears`, async () => {
    const t = await setup();
    await seedDeliveries(t, HISTORY, { state: "uncertain", collect: true, ago: 2 * DAY });
    const [fresh] = await seedDeliveries(t, 1, { state: "uncertain", collect: true, ago: 0 });
    await t.mutation(internal.alerts.scan, {});
    const opened = (await alerts(t)).filter((a) => a.cause === "uncertain-delivery");
    expect(opened.map((a) => a.subject.id)).toEqual([fresh]);
    at(DAY);
    await beat(t);
    await t.mutation(internal.alerts.scan, {});
    expect((await alerts(t)).find((a) => a.subject.id === fresh)!.resolvedAt).toBeUndefined();
    await t.run(async (ctx) => ctx.db.patch(fresh!, { state: "replied" }));
    await t.mutation(internal.alerts.scan, {});
    expect((await alerts(t)).find((a) => a.subject.id === fresh)!.resolvedAt).toBe(NOW + DAY);
  });

  it(`${HISTORY} old expired reminders don't stop the scan`, async () => {
    const t = await setup();
    await seedExpiredReminders(t, HISTORY);
    await t.mutation(internal.alerts.scan, {});
    expect(await alerts(t)).toEqual([]);
  });
});
