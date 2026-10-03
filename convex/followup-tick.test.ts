// Follow-up 4: the reminder tick stays within Convex's real transaction limits (16 MiB
// read and written) with many due or expiring reminders near the text cap, stopping at a
// budget and carrying on the next tick. Reed's repro (rv2-bytes), with the carry-on check.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-02T12:00:00Z").getTime();
const MIN = 60_000;
const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest({ schema, modules, transactionLimits: true as never });
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (let i = 0; i < 50; i++) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: `a${i}`, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${i}` } });
  }
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}

for (const [label, expiring, due, ch] of [
  ["30 due CJK", 0, 30, "界"],
  ["50 due CJK", 0, 50, "界"],
  ["60 expiring CJK", 60, 0, "界"],
  ["100 expiring + 50 due ASCII", 100, 50, "x"],
] as const) {
  it(`Reed's repro: the tick survives ${label} reminders of 32,000 characters, and carries on until all are handled`, async () => {
    const t = await setup();
    const text = ch.repeat(32_000);
    const ids: string[] = [];
    for (let i = 0; i < expiring; i++) ids.push((await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: `a${i % 50}`, text, everyMs: 60 * MIN, expiresMs: 120 * MIN })).reminder.id);
    // Expiring before their first fire: refused at creation since follow-up (b), so moved here.
    await t.run(async (ctx) => {
      for (const id of ids) await ctx.db.patch(id as never, { expiresAt: NOW + 2 * MIN });
    });
    for (let i = 0; i < due; i++) ids.push((await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: `a${i}`, text, everyMs: 2 * MIN })).reminder.id);
    at(2 * MIN);
    let ticks = 0;
    for (; ticks < 15; ticks++) {
      await t.mutation(internal.reminders.tick, {}); // throws if it goes over the limits
      const states = await t.run(async (ctx) => Promise.all(ids.map(async (id) => (await ctx.db.get(id as never)) as { state: string; fires: number })));
      if (states.every((r) => r.state === "expired" || r.fires >= 1)) break;
    }
    expect(ticks).toBeLessThan(15);
  });
}

// Close-out 1 (docs/08): the byte budget doesn't bound how many queries a tick makes. Alder's
// repro: 1,500 short reminders together exceeded Convex's 4,096 index ranges per transaction,
// rolled back, and never cleared. Both loops, with creators who get the ending notices.
for (const kind of ["expiring", "due"] as const) {
  it(`Alder's repro: 1,500 short reminders ${kind} together, made by people and by agents, all finish across ticks under the real limits`, async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a0", text: "x", everyMs: 60 * MIN, expiresMs: 120 * MIN });
    const ids = await t.run(async (ctx) => {
      const r = (await ctx.db.get(reminder.id as never)) as Record<string, unknown> & { _id: string };
      const { _id, _creationTime, ...fields } = r as never as Record<string, unknown>;
      const agents = await Promise.all(Array.from({ length: 50 }, async (_, i) => (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", `a${i}`)).unique())!));
      const lee = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "lee")).unique())!;
      await ctx.db.delete(_id as never);
      const out: string[] = [];
      for (let i = 0; i < 1_500; i++) {
        const when = kind === "expiring" ? { expiresAt: NOW + MIN } : { nextFireAt: NOW + MIN };
        // Half made by a person (an inbox notice when it ends), half by an agent (a delivered notice).
        const createdById = i % 2 ? lee._id : agents[(i + 1) % 50]!._id;
        out.push(await ctx.db.insert("reminders", { ...(fields as never), ...when, targetId: agents[i % 50]!._id, createdById, name: `short ${i}` }));
      }
      return out;
    });
    at(2 * MIN);
    let ticks = 0;
    for (; ticks < 40; ticks++) {
      await t.mutation(internal.reminders.tick, {}); // throws (and rolls back) if over the limits
      const states = await t.run(async (ctx) => Promise.all(ids.map(async (id) => (await ctx.db.get(id as never)) as { state: string; fires: number })));
      if (states.every((r) => (kind === "expiring" ? r.state === "expired" : r.fires >= 1))) break;
    }
    expect(ticks).toBeLessThan(40);
    if (kind === "expiring") {
      const notices = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.meta?.type === "reminder-ended").length);
      expect(notices).toBe(1_500);
    }
  }, 180_000);
}
