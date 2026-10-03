// Follow-up, Reed's scope answer: (a) the waits sweep can't be starved by answered results
// not yet due; (c) the reminder lists answer over finished history; (b) three creation-time
// checks (a reminder that can't fire before it expires; control characters in a derived
// name; a retired report-to). Reed's repros (rv2-sweep, rv2), with the brief's wording.

import { ACK_WINDOW_MS } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
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

async function setup(limits?: { documentsRead: number }) {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = limits ? convexTest({ schema, modules, transactionLimits: limits }) : convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const n of ["a", "b", "c"]) await t.mutation(api.directory.promote, { adminToken: ADMIN, name: n, kind: "agent", owner: "lee", home: { machine: "m1", harness: "claude-code", locator: n } });
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;
async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    return `plain: ${(error as Error).message}`;
  }
  return "no error";
}
const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("(a) the waits sweep", () => {
  it("Reed's repro: 500 answered results not yet due (a long group wait still running) don't starve a due fallback", async () => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", wait: true, waitMs: 9 * MIN } as never);
    const due = sent.deliveries[0]!.id;
    await t.run(async (ctx) => {
      const d = (await ctx.db.get(due as never)) as { recipientId: Id<"participants">; messageId: Id<"messages">; _id: Id<"deliveries"> };
      const w = await ctx.db.insert("waits", { waiterId: d.recipientId, messageId: d.messageId, until: NOW + 60 * MIN, active: true, lastAwaitAt: NOW + 10 * MIN, inInboxIds: [], createdAt: NOW - 1 });
      for (let i = 0; i < 500; i++) await ctx.db.insert("waitResults", { waitId: w, recipientId: d.recipientId, deliveryId: d._id, state: "answered", at: NOW - 1 });
    });
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: due });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: due, claimId: claim.claimId, turnId: "tb" });
    const got = await t.mutation(api.connector.collect, { machine: m1, deliveryId: due, claimId: claim.claimId, turnId: "tb", answer: "4" });
    at(ACK_WINDOW_MS + MIN);
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    await t.mutation(internal.waits.sweep, {});
    const fb = await t.run(async (ctx) => (await ctx.db.query("deliveries").withIndex("by_message", (q) => q.eq("messageId", got.answerMessageId as never)).collect()).filter((x) => x.fallback).length);
    expect(fb).toBe(1);
  });
});

describe("(c) reminder lists over finished history (400-read limit)", () => {
  async function seedHistory(t: T, n: number) {
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "template", everyMs: MIN });
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(reminder.id as Id<"reminders">))!;
      const { _id, _creationTime, ...base } = row;
      await ctx.db.delete(_id);
      for (let i = 0; i < n; i++) await ctx.db.insert("reminders", { ...base, state: "expired", stateAt: NOW - 30 * DAY - i, expiresAt: NOW - 30 * DAY - i, nextFireAt: undefined, expiryReported: true });
    });
  }
  it("Reed's repro: `comms reminders` for an agent with 600 finished reminders answers, live ones first and complete", async () => {
    const t = await setup({ documentsRead: 400 });
    await seedHistory(t, 600);
    const live = await t.mutation(api.connector.remind, { machine: m1, as: "b", target: "a", text: "live", everyMs: MIN });
    const r = await t.query(api.connector.reminders, { machine: m1, as: "a" });
    expect(r.reminders[0]!.id).toBe(live.reminder.id);
    expect(r.reminders.length).toBeLessThan(100);
  });
  it("Reed's repro: the web Reminders list with 600 finished reminders answers, live ones first", async () => {
    const t = await setup({ documentsRead: 400 });
    await seedHistory(t, 600);
    const live = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "live", everyMs: MIN });
    const r = await t.query(api.reminders.list, { adminToken: ADMIN });
    expect(r.reminders[0]!.id).toBe(live.reminder.id);
    const expired = await t.query(api.reminders.list, { adminToken: ADMIN, state: "expired" });
    expect(expired.reminders.length).toBeGreaterThan(0);
    expect(expired.reminders.length).toBeLessThanOrEqual(50);
  });
});

describe("(b) creation-time checks", () => {
  const create = (t: T, args: Record<string, unknown>) => t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", ...args } as never);

  it("a reminder that can't fire before it expires is refused: --at leaves at least one tick; --every is shorter than the time to expiry", async () => {
    const t = await setup();
    expect(await errorCode(create(t, { at: NOW + 10 * MIN - 30_000, expiresMs: 10 * MIN }))).toBe("bad_request");
    expect(await errorCode(create(t, { at: NOW + 9 * MIN, expiresMs: 10 * MIN }))).toBe("no error");
    expect(await errorCode(create(t, { everyMs: 10 * MIN, expiresMs: 10 * MIN }))).toBe("bad_request");
    expect(await errorCode(create(t, { everyMs: 9 * MIN, expiresMs: 10 * MIN }))).toBe("no error");
  });

  it("Reed's repro: a name derived from the text has no control characters (C0, C1, U+2028/2029)", async () => {
    const t = await setup();
    const { reminder } = await create(t, { text: "check\u0085the\u0007queue\u2028now", everyMs: MIN });
    expect(reminder.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(reminder.name).toBe("check the queue now");
  });

  it("Reed's repro: a retired --report-to is refused; one retired later records a reportError instead of nothing", async () => {
    const t = await setup();
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "c", state: "retired" });
    expect(await errorCode(create(t, { everyMs: MIN, reportTo: "c" }))).toBe("bad_request");
    const { reminder } = await create(t, { everyMs: MIN, reportTo: "b" });
    at(MIN);
    await t.mutation(internal.reminders.tick, {});
    const [d] = (await t.query(api.connector.work, { machine: m1 })).deliveries.filter((x) => x.recipient === "a");
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "b", state: "retired" });
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: d!.id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: d!.id, claimId: claim.claimId, turnId: "t" });
    await t.mutation(api.connector.collect, { machine: m1, deliveryId: d!.id, claimId: claim.claimId, turnId: "t", answer: "done" });
    const fire = await t.run(async (ctx) => (await ctx.db.query("reminderFires").collect()).find((f) => f.reminderId === (reminder.id as never)));
    expect(fire!.reportError).toMatch(/@b is retired/);
  });
});
