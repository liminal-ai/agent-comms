// Scratch adversarial review tests. Each asserts the CLAIMED behaviour; a failure proves a bug.
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-01T12:00:00Z").getTime();
const MIN = 60_000;
const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
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
async function err(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof ConvexError ? (e.data as { code: string }).code : `plain: ${(e as Error).message}`; }
  return "no error";
}
async function uncertainDelivery(t: T, text = "q") {
  const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text });
  const id = sent.deliveries[0]!.id;
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
  await t.mutation(api.connector.uncertain, { machine: m1, deliveryId: id, claimId: claim.claimId, detail: "restart" });
  return id;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); at(0); });
afterEach(() => vi.useRealTimers());

describe("review: system participants", () => {
  it("R-1a @alerts can't be retired (and retiring it must not kill the alert cron)", async () => {
    const t = await setup();
    const code = await err(t.mutation(api.directory.setState, { adminToken: ADMIN, name: "alerts", state: "retired" }));
    await uncertainDelivery(t);
    const scan = await err(t.mutation(internal.alerts.scan, {}));
    // upgrade can't repair it either
    await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    const scan2 = await err(t.mutation(internal.alerts.scan, {}));
    expect({ code, scan, scan2 }).toEqual({ code: "bad_request", scan: "no error", scan2: "no error" });
  });
  it("R-1b @reminders can't be retired (and retiring it must not kill the reminder cron)", async () => {
    const t = await setup();
    const code = await err(t.mutation(api.directory.setState, { adminToken: ADMIN, name: "reminders", state: "retired" }));
    await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "ping", everyMs: 5 * MIN } as never).catch((e) => { throw e; });
    at(6 * MIN);
    const tick = await err(t.mutation(internal.reminders.tick, {}));
    expect({ code, tick }).toEqual({ code: "bad_request", tick: "no error" });
  });
});

describe("review: owners", () => {
  it("R-2a promote refuses a retired owner", async () => {
    const t = await setup();
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "sam", kind: "human" });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "sam", state: "retired" });
    const code = await err(t.mutation(api.directory.promote, { adminToken: ADMIN, name: "c", kind: "agent", owner: "sam", home: { machine: "m1", harness: "t3", locator: "loc-c" } }));
    expect(code).toBe("bad_request");
  });
  it("R-2b an alert whose owner is retired is not silently dropped", async () => {
    const t = await setup();
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "sam", kind: "human" });
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "c", kind: "agent", owner: "sam", home: { machine: "m1", harness: "t3", locator: "loc-c" } });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "sam", state: "retired" });
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["c"], text: "q" });
    const id = sent.deliveries[0]!.id;
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
    await t.mutation(api.connector.uncertain, { machine: m1, deliveryId: id, claimId: claim.claimId, detail: "restart" });
    const r = await t.mutation(internal.alerts.scan, {});
    const owner = await t.mutation(api.connector.send, { machine: m1, as: "c", to: ["owner"], text: "help" });
    expect({ opened: r.opened, alerts: (await t.query(api.alerts.list, { adminToken: ADMIN })).alerts.length, ownerSkipped: owner.skipped }).toEqual({ opened: 1, alerts: 1, ownerSkipped: [] });
  });
  it("R-2c upgrade flags a legacy participant holding a reserved alias (owner/all)", async () => {
    const t = await setup();
    await t.run(async (ctx) => { await ctx.db.insert("participants", { name: "owner", kind: "agent", state: "active", presence: { status: "offline", at: NOW }, createdAt: NOW, home: { machine: "m1", harness: "t3", locator: "x" } }); });
    expect(await err(t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" }))).toBe("conflict");
  });
});

describe("review: alert config bounds", () => {
  it("R-3 setConfig refuses NaN thresholds", async () => {
    const t = await setup();
    const a = await err(t.mutation(api.alerts.setConfig, { adminToken: ADMIN, connectorSilentMs: Number.NaN }));
    const b = await err(t.mutation(api.alerts.setConfig, { adminToken: ADMIN, reminderBlockedMs: Number.NaN }));
    // consequence: a machine heard from this instant alerts as silent
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    const r = await t.mutation(internal.alerts.scan, {});
    expect({ a, b, opened: r.opened }).toEqual({ a: "bad_request", b: "bad_request", opened: 0 });
  });
});

describe("review: storms", () => {
  it("R-4 first scan after deploy over pre-existing uncertain deliveries: one alert per delivery", async () => {
    const t = await setup();
    for (let i = 0; i < 25; i++) await uncertainDelivery(t, `q${i}`);
    const r = await t.mutation(internal.alerts.scan, {});
    const unread = (await t.query(api.inbox.unreadCount, { adminToken: ADMIN, human: "lee" })).unread;
    expect({ opened: r.opened, unread }).toEqual({ opened: 25, unread: 25 }); // documents the behaviour (passes): 25 alerts in one minute
  });
});

describe("review: scan windows", () => {
  it("R-5 delivery-reclaimed still fires after 500 finished answer deliveries exist (state delivered, collect false)", async () => {
    const t = await setup();
    // 500 answers delivered to a requester: each ends at `delivered` forever (collect false)
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "seed" });
    await t.run(async (ctx) => {
      const d0 = (await ctx.db.get(sent.deliveries[0]!.id as never)) as any;
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert("deliveries", { messageId: d0.messageId, conversationId: d0.conversationId, recipientId: d0.recipientId, collect: false, state: "delivered", at: NOW, createdAt: NOW });
      }
    });
    // A real request, now in flight and taken over 6 times (claimCount 7 > maxClaims 5)
    const req = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "real" });
    const id = req.deliveries[0]!.id;
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId: claim.claimId, turnId: "t1" });
    await t.run(async (ctx) => { await ctx.db.patch(id as never, { claimCount: 7 } as never); });
    const r = await t.mutation(internal.alerts.scan, {});
    expect(r.opened).toBe(1);
  });
  it("R-6 reminder-expired still fires after 500 older reminders have expired", async () => {
    const t = await setup();
    const ids = await t.run(async (ctx) => {
      const a = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "a")).unique())!;
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert("reminders", { name: `old${i}`, text: "x", targetId: a._id, createdById: a._id, everyMs: 30 * MIN, state: "expired", stateAt: NOW - 30 * 24 * 60 * MIN, fires: 1, expiresAt: NOW - 30 * 24 * 60 * MIN, skips: [], createdAt: NOW - 40 * 24 * 60 * MIN });
      }
      return await ctx.db.insert("reminders", { name: "new", text: "x", targetId: a._id, createdById: a._id, everyMs: 30 * MIN, state: "expired", stateAt: NOW, fires: 1, expiresAt: NOW, skips: [], createdAt: NOW });
    });
    const r = await t.mutation(internal.alerts.scan, {});
    expect({ opened: r.opened, id: !!ids }).toEqual({ opened: 1, id: true });
  });
});
