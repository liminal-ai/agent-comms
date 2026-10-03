// The capabilities pass, R3: reminders. A minute cron (`reminders.tick`) fires
// due reminders as ordinary requests from @reminders; a fire is skipped while the
// previous one isn't final, while the watched participant isn't idle long
// enough, or while its presence is stale; answers are recorded on the fire and
// reported; reminders stop at --max, at expiry, and on done or cancel.

import { renderDelivery } from "@agent-comms/protocol";
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

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const name of ["a", "b", "c"]) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${name}` } });
  }
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
const tick = (t: T) => t.mutation(internal.reminders.tick, {});
const heartbeat = (t: T) => t.mutation(api.connector.heartbeat, { machine: m1 });
const get = async (t: T, id: string) => t.query(api.reminders.get, { adminToken: ADMIN, id });
const pendingFor = async (t: T, name: string) => {
  const items = (await t.query(api.connector.work, { machine: m1 })).deliveries;
  return items.filter((d) => d.recipient === name && d.state === "pending");
};
const inboxTexts = async (t: T) => (await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee" })).items.map((i) => i.message.text);

async function answerFire(t: T, deliveryId: string, text: string) {
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId });
  await t.mutation(api.connector.delivered, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `t-${deliveryId}` });
  return t.mutation(api.connector.collect, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `t-${deliveryId}`, answer: text });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("R3 firing", () => {
  it("fires a due reminder as a request from @reminders, labelled with its creator, and records the fire", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "Check the CI queue.", everyMs: 30 * MIN, name: "ci" });
    at(29 * MIN);
    await tick(t);
    expect(await pendingFor(t, "a")).toEqual([]);
    at(30 * MIN);
    await tick(t);
    const [fire] = await pendingFor(t, "a");
    const { delivery } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: fire!.id });
    expect(delivery.message.sender).toMatchObject({ name: "reminders", kind: "system" });
    expect(delivery.message.meta).toEqual({ type: "reminder", reminderId: reminder.id, name: "ci", setBy: "lee", schedule: "every 30m", fire: 1 });
    const text = renderDelivery(delivery, { harnessLabelsSource: false });
    expect(text).toMatch(new RegExp(`^Reminder: ci \\(id ${reminder.id}\\), set by @lee, every 30m\\. Fire 1\\.$`, "m"));
    expect(text).toMatch(new RegExp(`comms reminder done ${reminder.id} --as a`));
    const shown = await get(t, reminder.id);
    expect(shown.reminder).toMatchObject({ fires: 1, nextFireAt: NOW + 60 * MIN, lastFire: { deliveryState: "claimed", firedAt: NOW + 30 * MIN } });
    expect(shown.fires).toHaveLength(1);
  });

  it("skips a fire while the previous one isn't final, then fires on schedule once it is; the answer is recorded and reported", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "status?", everyMs: 10 * MIN, name: "st", reportTo: "lee" });
    at(10 * MIN);
    await tick(t);
    const [first] = await pendingFor(t, "a");
    at(20 * MIN);
    await tick(t);
    let shown = await get(t, reminder.id);
    expect(shown.reminder).toMatchObject({ fires: 1, nextFireAt: NOW + 30 * MIN, lastSkip: { at: NOW + 20 * MIN, reason: "previous-fire-not-final" } });
    expect(await pendingFor(t, "a")).toHaveLength(1);

    await answerFire(t, first!.id, "all green");
    shown = await get(t, reminder.id);
    expect(shown.fires[0]!.answer?.text).toBe("all green");
    expect(await inboxTexts(t)).toEqual([`Reminder st (${reminder.id}): @a answered:\n> all green`]);
    at(30 * MIN);
    await tick(t);
    expect((await get(t, reminder.id)).reminder.fires).toBe(2);
  });

  it("an ambiguous fire blocks the next for one interval only", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 5 * MIN });
    at(5 * MIN);
    await tick(t);
    const [fire] = await pendingFor(t, "a");
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: fire!.id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: fire!.id, claimId: claim.claimId, turnId: "t1" });
    at(6 * MIN);
    await t.mutation(api.connector.ambiguous, { machine: m1, deliveryId: fire!.id, claimId: claim.claimId, turnId: "t1", entered: [{ origin: "composer" }] });
    at(10 * MIN);
    await tick(t);
    expect((await get(t, reminder.id)).reminder).toMatchObject({ fires: 1, lastSkip: { reason: "previous-fire-not-final" } });
    at(15 * MIN);
    await tick(t);
    expect((await get(t, reminder.id)).reminder.fires).toBe(2);
  });

  it("--idle-for waits for the target (or --watch participant) to be idle long enough, and never trusts stale presence", async () => {
    const t = await setup();
    const presence = (name: string, status: "idle" | "busy") => t.mutation(api.connector.presence, { machine: m1, participant: name, status });
    await presence("a", "busy");
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 30 * MIN, idleForMs: 20 * MIN });
    at(30 * MIN);
    await heartbeat(t);
    await tick(t);
    expect((await get(t, reminder.id)).reminder).toMatchObject({ fires: 0, nextFireAt: NOW + 31 * MIN, lastSkip: { reason: "not-idle" } });
    await presence("a", "idle");
    at(45 * MIN);
    await heartbeat(t);
    await tick(t);
    expect((await get(t, reminder.id)).reminder).toMatchObject({ fires: 0, lastSkip: { reason: "not-idle" } });
    at(50 * MIN);
    await heartbeat(t);
    await tick(t);
    expect((await get(t, reminder.id)).reminder.fires).toBe(1);

    // --watch: b's idleness gates a fire to c; a stale machine never counts as idle.
    const watched = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "c", text: "check on b", everyMs: 10 * MIN, idleForMs: 5 * MIN, watch: "b" });
    await presence("b", "idle");
    at(65 * MIN);
    await tick(t);
    expect((await get(t, watched.reminder.id)).reminder).toMatchObject({ fires: 0, lastSkip: { reason: "presence-stale" } });
    await heartbeat(t);
    at(66 * MIN);
    await heartbeat(t);
    await tick(t);
    expect((await get(t, watched.reminder.id)).reminder.fires).toBe(1);
  });
});

describe("R3 stopping", () => {
  it("--max stops after n fires and tells the creator; a one-time reminder is done after it fires", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN, max: 1, name: "once" });
    at(MIN);
    await tick(t);
    const shown = await get(t, reminder.id);
    expect(shown.reminder).toMatchObject({ state: "done", fires: 1 });
    expect(shown.reminder.nextFireAt).toBeUndefined();
    expect((await inboxTexts(t))[0]).toMatch(new RegExp(`^Reminder once \\(${reminder.id}\\) was marked done: fired 1 time \\(--max 1\\)\\. It won't fire again\\.$`));

    const one = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "y", at: NOW + 10 * MIN });
    at(10 * MIN);
    await tick(t);
    expect((await get(t, one.reminder.id)).reminder).toMatchObject({ state: "done", fires: 1, stateReason: "fired once" });
  });

  it("expires (active or paused), telling the creator; paused and blocked reminders don't fire; done and cancel tell the creator", async () => {
    const t = await setup();
    // Expires before its first fire: refused at creation since follow-up (b), so made valid and then moved.
    const short = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 10 * MIN, expiresMs: 20 * MIN, name: "short" });
    await t.run(async (ctx) => ctx.db.patch(short.reminder.id as never, { expiresAt: NOW + 5 * MIN }));
    const paused = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "y", everyMs: MIN, expiresMs: 3 * MIN, name: "paused" });
    await t.mutation(api.reminders.update, { adminToken: ADMIN, id: paused.reminder.id, action: "pause" });
    at(2 * MIN);
    await tick(t);
    expect(await pendingFor(t, "b")).toEqual([]);
    at(5 * MIN);
    await tick(t);
    expect((await get(t, short.reminder.id)).reminder.state).toBe("expired");
    expect((await get(t, paused.reminder.id)).reminder.state).toBe("expired");
    const texts = await inboxTexts(t);
    expect(texts.some((x) => x.startsWith(`Reminder short (${short.reminder.id}) expired`))).toBe(true);
    expect(texts.some((x) => x.startsWith(`Reminder paused (${paused.reminder.id}) expired`))).toBe(true);

    const c = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "z", everyMs: MIN, name: "c" });
    await t.mutation(api.reminders.update, { adminToken: ADMIN, id: c.reminder.id, action: "cancel" });
    expect((await inboxTexts(t))[0]).toBe(`Reminder c (${c.reminder.id}) was cancelled. It won't fire again.`);
  });

  it("a running fire's turn finishes after a cancel, and its answer is still recorded", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN });
    at(MIN);
    await tick(t);
    const [fire] = await pendingFor(t, "a");
    await t.mutation(api.reminders.update, { adminToken: ADMIN, id: reminder.id, action: "cancel" });
    await answerFire(t, fire!.id, "done anyway");
    expect((await get(t, reminder.id)).fires[0]!.answer?.text).toBe("done anyway");
  });
});

describe("R3 reminders over the connector", () => {
  it("an agent creates, lists and updates reminders; only the creator, the target and the target's owner may change one", async () => {
    const t = await setup();
    const r = await t.mutation(api.connector.remind, { machine: m1, as: "a", target: "b", text: "ping", everyMs: 30 * MIN, name: "p" });
    expect(r.reminder).toMatchObject({ createdBy: { name: "a" }, target: { name: "b" }, state: "active" });
    expect((await t.query(api.connector.reminders, { machine: m1, as: "a" })).reminders.map((x) => x.id)).toEqual([r.reminder.id]);
    expect((await t.query(api.connector.reminders, { machine: m1, as: "b" })).reminders.map((x) => x.id)).toEqual([r.reminder.id]);
    expect((await t.query(api.connector.reminders, { machine: m1, as: "c" })).reminders).toEqual([]);
    expect(await errorCode(t.query(api.connector.reminder, { machine: m1, as: "c", id: r.reminder.id }))).toBe("forbidden"); // fix pass 0.4
    expect(await errorCode(t.mutation(api.connector.reminderUpdate, { machine: m1, as: "c", id: r.reminder.id, action: "pause" }))).toBe("forbidden");
    expect((await t.mutation(api.connector.reminderUpdate, { machine: m1, as: "b", id: r.reminder.id, action: "blocked", reason: "no creds" })).reminder).toMatchObject({ state: "blocked", stateReason: "no creds" });
    expect(await errorCode(t.mutation(api.connector.remind, { machine: m1, as: "a", target: "reminders", text: "x", everyMs: MIN }))).toBe("bad_request");
    expect(await errorCode(t.query(api.connector.reminder, { machine: m1, as: "a", id: "nope" }))).toBe("unknown_reminder");
  });
});

describe("R3 system participants", () => {
  it("never get a delivery: the answer to a fire addresses no one", async () => {
    const t = await setup();
    await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN });
    at(MIN);
    await tick(t);
    const [fire] = await pendingFor(t, "a");
    await answerFire(t, fire!.id, "ok");
    const toSystem = await t.run(async (ctx) => {
      const system = (await ctx.db.query("participants").collect()).filter((p) => p.kind === "system").map((p) => p._id);
      return (await ctx.db.query("deliveries").collect()).filter((d) => system.includes(d.recipientId));
    });
    expect(toSystem).toEqual([]);
  });
});

describe("R3 notices to agents", () => {
  it("a report to an agent and an ended notice to an agent creator wake it with a notice, which is never collected", async () => {
    const t = await setup();
    const r = await t.mutation(api.connector.remind, { machine: m1, as: "c", target: "a", text: "x", everyMs: MIN, max: 1, reportTo: "b", name: "n" });
    at(MIN);
    await tick(t);
    const [fire] = await pendingFor(t, "a");
    await answerFire(t, fire!.id, "fine");
    const [report] = await pendingFor(t, "b");
    const [ended] = await pendingFor(t, "c");
    for (const n of [report!, ended!]) {
      expect(n.collect).toBe(false);
      const { delivery, claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: n.id });
      expect(delivery.message).toMatchObject({ kind: "notice", sender: { name: "reminders" } });
      await t.mutation(api.connector.delivered, { machine: m1, deliveryId: n.id, claimId: claim.claimId, turnId: `t-${n.id}` });
    }
    expect((await t.query(api.connector.work, { machine: m1 })).deliveries).toEqual([]);
    expect(r.reminder.state).toBe("active");
  });
});

describe("fix pass 1.2 (contract 0.4): reminder detail access", () => {
  it("only the creator, the target, the target's owner and the report-to read a reminder; anyone else, on any machine, is forbidden", async () => {
    const t = await setup();
    await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m2", secret: "m2-secret-0123456789" });
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "far", kind: "agent", owner: "lee", home: { machine: "m2", harness: "t3", locator: "loc-far" } });
    const m2 = { id: "m2", secret: "m2-secret-0123456789" };
    const r = await t.mutation(api.connector.remind, { machine: m1, as: "a", target: "b", text: "private", everyMs: MIN, reportTo: "c" });
    for (const as of ["a", "b", "c"]) {
      expect((await t.query(api.connector.reminder, { machine: m1, as, id: r.reminder.id })).reminder.text, as).toBe("private");
    }
    expect((await t.query(api.connector.reminders, { machine: m1, as: "c" })).reminders.map((x) => x.id)).toEqual([r.reminder.id]);
    // Alder's repro: an unrelated agent on another machine could read it.
    expect(await errorCode(t.query(api.connector.reminder, { machine: m2, as: "far", id: r.reminder.id }))).toBe("forbidden");
    expect((await t.query(api.connector.reminders, { machine: m2, as: "far" })).reminders).toEqual([]);
    expect(await errorCode(t.mutation(api.connector.reminderUpdate, { machine: m2, as: "far", id: r.reminder.id, action: "pause" }))).toBe("forbidden");
    // The report-to may read it, not change it.
    expect(await errorCode(t.mutation(api.connector.reminderUpdate, { machine: m1, as: "c", id: r.reminder.id, action: "pause" }))).toBe("forbidden");
  });
});

describe("fix pass 1.4: one bad reminder can't stop the rest", () => {
  const counts = (t: T) =>
    t.run(async (ctx) => ({
      messages: (await ctx.db.query("messages").collect()).length,
      deliveries: (await ctx.db.query("deliveries").collect()).length,
      fires: (await ctx.db.query("reminderFires").collect()).length,
    }));

  it("refuses reminder text over MAX_TEXT_CHARS at creation, on every path", async () => {
    const t = await setup();
    const big = "x".repeat(40_000);
    expect(await errorCode(t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: big, everyMs: MIN }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.connector.remind, { machine: m1, as: "b", target: "a", text: big, everyMs: MIN }))).toBe("bad_request");
  });

  it("a 40,000-character reminder (from before the cap) next to a normal one: the normal one fires; the bad one is blocked with the error and leaves nothing behind", async () => {
    const t = await setup();
    const good = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "fine", everyMs: MIN });
    const bad = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "short for now", everyMs: MIN });
    await t.run(async (ctx) => ctx.db.patch(bad.reminder.id as never, { text: "x".repeat(40_000) }));
    const before = await counts(t);
    at(MIN);
    await tick(t);
    expect((await get(t, good.reminder.id)).reminder.fires).toBe(1);
    const b = (await get(t, bad.reminder.id)).reminder;
    expect(b.state).toBe("blocked");
    expect(b.stateReason).toMatch(/^the fire failed: .*32000/);
    const after = await counts(t);
    expect(after).toEqual({ messages: before.messages + 1, deliveries: before.deliveries + 1, fires: before.fires + 1 });
  });

  it("a failure injected after writing has begun leaves no message, delivery or fire, and blocks only that reminder", async () => {
    const t = await setup();
    const r = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN });
    const other = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "y", everyMs: MIN });
    const before = await counts(t);
    at(MIN);
    process.env.COMMS_TEST_FAULT = `reminder-fire-after-post:${r.reminder.id}`;
    try {
      await tick(t);
    } finally {
      delete process.env.COMMS_TEST_FAULT;
    }
    const x = (await get(t, r.reminder.id)).reminder;
    expect([x.state, x.fires]).toEqual(["blocked", 0]);
    expect(x.stateReason).toMatch(/injected/);
    expect((await get(t, other.reminder.id)).reminder.fires).toBe(1);
    expect(await counts(t)).toEqual({ messages: before.messages + 1, deliveries: before.deliveries + 1, fires: before.fires + 1 });
  });
});

describe("fix pass 1.5: reports never block collecting the answer", () => {
  const reportsTo = (t: T, name: string) =>
    t.run(async (ctx) => {
      const to = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", name)).unique())!;
      return (await ctx.db.query("messages").collect()).filter((m) => m.meta?.type === "reminder-report" && m.recipientIds.includes(to._id));
    });
  const answersBy = (t: T, name: string) =>
    t.run(async (ctx) => {
      const p = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", name)).unique())!;
      return (await ctx.db.query("messages").collect()).filter((m) => m.senderId === p._id && m.kind === "answer");
    });

  it("Alder's repro: a 32,000-character answer to a --report-to reminder is collected, and the report is posted clipped, pointing to the full answer", async () => {
    const t = await setup();
    const r = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN, reportTo: "lee", name: "big" });
    at(MIN);
    await tick(t);
    const [d] = await pendingFor(t, "a");
    const got = await answerFire(t, d!.id, "y".repeat(32_000));
    expect(got.duplicate).toBe(false);
    const [report] = await reportsTo(t, "lee");
    expect(report!.text.length).toBeLessThanOrEqual(32_000);
    expect(report!.text).toMatch(new RegExp(`^Reminder big \\(${r.reminder.id}\\): @a answered:\\n> y+`));
    expect(report!.text).toContain(got.answerMessageId!);
    expect((await get(t, r.reminder.id)).fires[0]!.answer?.text.length).toBe(32_000);
  });

  it("a report failure after writing began keeps the answer (once), leaves no stray report, and a retry posts nothing twice", async () => {
    const t = await setup();
    const r = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN, reportTo: "b" });
    at(MIN);
    await tick(t);
    const [d] = await pendingFor(t, "a");
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: d!.id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: d!.id, claimId: claim.claimId, turnId: "t1" });
    process.env.COMMS_TEST_FAULT = `reminder-report-after-post:${r.reminder.id}`;
    let first;
    try {
      first = await t.mutation(api.connector.collect, { machine: m1, deliveryId: d!.id, claimId: claim.claimId, turnId: "t1", answer: "done" });
    } finally {
      delete process.env.COMMS_TEST_FAULT;
    }
    expect(first.duplicate).toBe(false);
    expect((await answersBy(t, "a")).map((m) => m.text)).toEqual(["done"]);
    expect(await reportsTo(t, "b")).toEqual([]);
    expect((await get(t, r.reminder.id)).fires[0]!.answer?.text).toBe("done");
    const again = await t.mutation(api.connector.collect, { machine: m1, deliveryId: d!.id, claimId: claim.claimId, turnId: "t1", answer: "done" });
    expect(again.duplicate).toBe(true);
    expect((await answersBy(t, "a")).length).toBe(1);
    expect((await reportsTo(t, "b")).length).toBeLessThanOrEqual(1);
  });
});
