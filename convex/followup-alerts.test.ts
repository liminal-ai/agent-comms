// Follow-up 2 and 3 (docs/07-fix-pass-followup.md): the alert scans and the resolve pass
// make progress through every eligible row, and what has been reported is tracked, so
// an incident found after a long outage still alerts once. Alder's and Reed's repros.

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

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  for (const m of [m1, m2]) await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: m.id, secret: m.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "a", kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: "a" } });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "b", kind: "agent", owner: "lee", home: { machine: "m2", harness: "t3", locator: "b" } });
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  for (const m of [m1, m2]) await t.mutation(api.connector.heartbeat, { machine: m });
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;

const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const scan = (t: T) => t.mutation(internal.alerts.scan, {});
const alerts = async (t: T) => (await t.query(api.alerts.list, { adminToken: ADMIN, limit: 200 })).alerts;
const beat = (t: T, ...ms: (typeof m1)[]) => Promise.all(ms.map((m) => t.mutation(api.connector.heartbeat, { machine: m })));

/** `n` deliveries to @a in one conversation, in the given state, last changed `ago` ms before now. */
async function seedDeliveries(t: T, n: number, f: { state: "delivered" | "uncertain" | "claimed"; collect: boolean; ago: number; claimCount?: number; withOpenIncident?: boolean }) {
  return t.run(async (ctx) => {
    const a = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "a")).unique())!;
    const lee = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "lee")).unique())!;
    const conversationId = await ctx.db.insert("conversations", { kind: "group", title: "h", lastSeq: 1, lastAt: Date.now(), createdAt: Date.now() });
    const messageId = await ctx.db.insert("messages", {
      conversationId, seq: 1, senderId: lee._id, recipientIds: [a._id], kind: "request", text: "x", attachments: [], origin: { via: "web" }, createdAt: Date.now() - f.ago,
    });
    const ids: Id<"deliveries">[] = [];
    for (let i = 0; i < n; i++) {
      const id = await ctx.db.insert("deliveries", {
        messageId, conversationId, recipientId: a._id, collect: f.collect, state: f.state, at: Date.now() - f.ago - i,
        ...(f.claimCount !== undefined ? { claimCount: f.claimCount } : {}), createdAt: Date.now() - f.ago - i,
      });
      ids.push(id);
      if (f.withOpenIncident) {
        await ctx.db.insert("alerts", {
          cause: f.state === "uncertain" ? "uncertain-delivery" : "delivery-reclaimed", subjectKind: "delivery", subjectId: id,
          ownerId: lee._id, messageId, conversationId, openedAt: Date.now() - f.ago, summary: "old",
        });
      }
    }
    return ids;
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("follow-up 3: outages can't hide alerts", () => {
  it("Alder's repro: an uncertain delivery two hours old with no alert (the scanner was down) is alerted, once", async () => {
    const t = await setup();
    const [id] = await seedDeliveries(t, 1, { state: "uncertain", collect: true, ago: 2 * 60 * MIN });
    await scan(t);
    await scan(t);
    expect((await alerts(t)).filter((a) => a.subject.id === id).length).toBe(1);
  });

  it("a reminder that expired two hours ago, never reported, is alerted once", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 10 * MIN, expiresMs: 2 * MIN });
    at(3 * MIN);
    await t.mutation(internal.reminders.tick, {});
    at(3 * MIN + 2 * 60 * MIN);
    await beat(t, m1, m2);
    await scan(t);
    await scan(t);
    expect((await alerts(t)).filter((a) => a.subject.id === reminder.id).map((a) => a.cause)).toEqual(["reminder-expired"]);
  });

  it("history from before tracking (marked by the upgrade) doesn't flood; what happens after is alerted", async () => {
    const t = await setup();
    // A deployment from before tracking: no migration record yet.
    await t.run(async (ctx) => {
      for (const m of await ctx.db.query("migrations").collect()) await ctx.db.delete(m._id);
    });
    await seedDeliveries(t, 300, { state: "uncertain", collect: true, ago: 30 * DAY });
    await scan(t); // before the migration, the scan leaves these causes alone
    expect(await alerts(t)).toEqual([]);
    for (let i = 0; i < 5; i++) {
      const r = await t.mutation(api.directory.markAlertHistory, { adminToken: ADMIN });
      if (r.done) break;
    }
    await scan(t);
    expect(await alerts(t)).toEqual([]);
    const [fresh] = await seedDeliveries(t, 1, { state: "uncertain", collect: true, ago: 0 });
    await scan(t);
    expect((await alerts(t)).map((a) => a.subject.id)).toEqual([fresh]);
    expect((await t.mutation(api.directory.markAlertHistory, { adminToken: ADMIN })).marked).toBe(0);
  });
});

describe("follow-up 2: the scans progress through every eligible row", () => {
  it("Alder's repro: 500 in-flight deliveries don't hide a newer reclaimed one", async () => {
    const t = await setup();
    await seedDeliveries(t, 500, { state: "delivered", collect: true, ago: MIN, claimCount: 1 });
    const [id] = await seedDeliveries(t, 1, { state: "delivered", collect: true, ago: 0, claimCount: 9 });
    await scan(t);
    expect((await alerts(t)).some((a) => a.subject.id === id)).toBe(true);
  });

  it("500 reclaimed deliveries already alerted don't hide a newer one", async () => {
    const t = await setup();
    await seedDeliveries(t, 500, { state: "delivered", collect: true, ago: MIN, claimCount: 9, withOpenIncident: true });
    const [id] = await seedDeliveries(t, 1, { state: "delivered", collect: true, ago: 0, claimCount: 9 });
    for (let i = 0; i < 4; i++) await scan(t);
    expect((await alerts(t)).filter((a) => a.subject.id === id).length).toBe(1);
  });

  it("Alder's repro: a 501st incident whose condition cleared resolves past 500 still-open ones", async () => {
    const t = await setup();
    const ids = await seedDeliveries(t, 501, { state: "uncertain", collect: true, ago: 2 * 60 * MIN, withOpenIncident: true });
    await t.run(async (ctx) => ctx.db.patch(ids.at(-1)!, { state: "replied" }));
    await scan(t);
    await scan(t);
    const all = (await t.query(api.alerts.list, { adminToken: ADMIN, openOnly: true, limit: 200 })).alerts;
    expect(all.some((a) => a.subject.id === ids.at(-1))).toBe(false);
  });

  it("Reed's repro: with 500 long-lived open incidents, a connector incident resolves in one scan, and a later silence alerts again", async () => {
    const t = await setup();
    await seedDeliveries(t, 500, { state: "uncertain", collect: true, ago: 30 * DAY, withOpenIncident: true });
    at(20 * MIN);
    await beat(t, m1);
    await scan(t);
    const silent = (await alerts(t)).filter((a) => a.cause === "connector-silent");
    expect(silent.length).toBe(1);
    at(21 * MIN);
    await beat(t, m1, m2);
    await scan(t);
    expect((await alerts(t)).find((a) => a.id === silent[0]!.id)!.resolvedAt).toBe(NOW + 21 * MIN);
    at(DAY);
    await beat(t, m1);
    at(DAY + 20 * MIN);
    await beat(t, m1);
    await scan(t);
    expect((await alerts(t)).filter((a) => a.cause === "connector-silent").length).toBe(2);
  });

  it("a reminder blocked again after a resume is alerted again; 300 blocked reminders don't hide a newer one", async () => {
    const t = await setup();
    const make = () => t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 10 * MIN });
    const block = (id: string) => t.mutation(api.reminders.update, { adminToken: ADMIN, id, action: "blocked", reason: "stuck" });
    const many = [];
    for (let i = 0; i < 300; i++) many.push((await make()).reminder.id);
    for (const id of many) await block(id);
    at(61 * MIN);
    await beat(t, m1, m2);
    await scan(t);
    const { reminder } = await make();
    await block(reminder.id);
    at(122 * MIN);
    await beat(t, m1, m2);
    for (let i = 0; i < 3; i++) await scan(t);
    expect((await alerts(t)).filter((a) => a.subject.id === reminder.id).length).toBe(1);
    await t.mutation(api.reminders.update, { adminToken: ADMIN, id: reminder.id, action: "resume" });
    await scan(t);
    await block(reminder.id);
    at(183 * MIN);
    await beat(t, m1, m2);
    for (let i = 0; i < 3; i++) await scan(t);
    expect((await alerts(t)).filter((a) => a.subject.id === reminder.id).length).toBe(2);
  });
});
