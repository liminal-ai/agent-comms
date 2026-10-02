// Adversarial review: failing tests for suspected reminder bugs.
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
    if (error instanceof ConvexError) return `${(error.data as { code: string }).code}: ${(error.data as { message?: string }).message ?? ""}`;
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("review", () => {
  it("BUG1: once 200 reminders have passed their expiry, later reminders never expire and keep firing", async () => {
    const t = await setup();
    for (let i = 0; i < 200; i++) {
      await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: `old ${i}`, everyMs: 10 * MIN, expiresMs: MIN });
    }
    at(MIN);
    expect((await tick(t)).expired).toBe(200);
    const fresh = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "fresh", everyMs: MIN, expiresMs: 5 * MIN });
    for (let m = 2; m <= 20; m++) {
      at(m * MIN);
      // answer nothing; but fires only skip while previous not final, so make each final by failing it
      await tick(t);
      for (const d of await pendingFor(t, "b")) {
        const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: d.id });
        await t.mutation(api.connector.failed, { machine: m1, deliveryId: d.id, claimId: claim.claimId, reason: "error" });
      }
    }
    const shown = await get(t, fresh.reminder.id);
    // 20 minutes in, 15 minutes past its 5-minute expiry:
    expect({ state: shown.reminder.state, fires: shown.reminder.fires }).toEqual({ state: "expired", fires: expect.any(Number) });
  });

  it("BUG2: one reminder whose text is over MAX_TEXT_CHARS (web create accepts it) makes every tick throw: no fires, no expiries", async () => {
    const t = await setup();
    const other = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "ok", everyMs: MIN, expiresMs: 3 * MIN });
    await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x".repeat(32_001), everyMs: MIN });
    at(MIN);
    expect(await errorCode(tick(t))).toBe("no error");
    at(4 * MIN);
    await tick(t).catch(() => {});
    expect((await get(t, other.reminder.id)).reminder.state).toBe("expired");
  });

  it("BUG3: with --report-to, a long (clipped-to-limit) answer makes collect fail, so the answer is lost", async () => {
    const t = await setup();
    await t.mutation(api.connector.remind, { machine: m1, as: "c", target: "a", text: "status", everyMs: MIN, reportTo: "lee" });
    at(MIN);
    await tick(t);
    const [fire] = await pendingFor(t, "a");
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: fire!.id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: fire!.id, claimId: claim.claimId, turnId: "t1" });
    const answer = "y".repeat(31_990); // under MAX_TEXT_CHARS (32000); the report adds a header and "> "
    expect(await errorCode(t.mutation(api.connector.collect, { machine: m1, deliveryId: fire!.id, claimId: claim.claimId, turnId: "t1", answer }))).toBe("no error");
  });

  it("BUG3b: comms reply completing an ambiguous fire with a long answer is refused when the reminder reports", async () => {
    const t = await setup();
    await t.mutation(api.connector.remind, { machine: m1, as: "c", target: "a", text: "status", everyMs: MIN, reportTo: "b" });
    at(MIN);
    await tick(t);
    const [fire] = await pendingFor(t, "a");
    const { claim, delivery } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: fire!.id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: fire!.id, claimId: claim.claimId, turnId: "t1" });
    await t.mutation(api.connector.ambiguous, { machine: m1, deliveryId: fire!.id, claimId: claim.claimId, turnId: "t1", entered: [{ origin: "composer" }] });
    const text = "z".repeat(31_990);
    expect(await errorCode(t.mutation(api.connector.reply, { machine: m1, as: "a", messageId: delivery.message.id, text }))).toBe("no error");
  });

  it("BUG4: a retired --watch agent still reads as idle, so the reminder keeps firing", async () => {
    const t = await setup();
    await t.mutation(api.connector.presence, { machine: m1, participant: "b", status: "idle" });
    const r = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "c", text: "check on b", everyMs: 10 * MIN, idleForMs: 5 * MIN, watch: "b" });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "b", state: "retired" });
    for (let m = 10; m <= 40; m += 10) {
      at(m * MIN);
      await heartbeat(t);
      await tick(t);
      for (const d of await pendingFor(t, "c")) {
        const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: d.id });
        await t.mutation(api.connector.delivered, { machine: m1, deliveryId: d.id, claimId: claim.claimId, turnId: `t-${d.id}` });
        await t.mutation(api.connector.collect, { machine: m1, deliveryId: d.id, claimId: claim.claimId, turnId: `t-${d.id}`, answer: "b is idle" });
      }
    }
    const shown = (await get(t, r.reminder.id)).reminder;
    expect({ state: shown.state, fires: shown.fires }).toEqual({ state: "cancelled", fires: 0 });
  });

  it("BUG5: a retired creator's reminder keeps firing (and its ended notice is silently dropped)", async () => {
    const t = await setup();
    const r = await t.mutation(api.connector.remind, { machine: m1, as: "c", target: "a", text: "ping", everyMs: MIN });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "c", state: "retired" });
    at(MIN);
    await tick(t);
    expect((await get(t, r.reminder.id)).reminder.state).not.toBe("active");
  });

  it("BUG6: a one-time --at reminder ends (done) without telling its creator", async () => {
    const t = await setup();
    await t.mutation(api.connector.remind, { machine: m1, as: "c", target: "a", text: "once", at: NOW + 5 * MIN });
    at(5 * MIN);
    await tick(t);
    expect(await pendingFor(t, "c")).toHaveLength(1);
  });

  it("SOUND: resume after a long pause fires once, not a burst, and keeps the rhythm", async () => {
    const t = await setup();
    const r = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 30 * MIN });
    await t.mutation(api.reminders.update, { adminToken: ADMIN, id: r.reminder.id, action: "pause" });
    at(5 * 60 * MIN + 7 * MIN);
    await t.mutation(api.reminders.update, { adminToken: ADMIN, id: r.reminder.id, action: "resume" });
    await tick(t);
    await tick(t);
    const shown = (await get(t, r.reminder.id)).reminder;
    expect(shown.fires).toBe(1);
    expect(shown.nextFireAt).toBe(NOW + 5 * 60 * MIN + 30 * MIN);
    expect(await pendingFor(t, "a")).toHaveLength(1);
  });

  it("PROBE: an --at equal to the expiry never fires (expired first)", async () => {
    const t = await setup();
    const r = await t.mutation(api.connector.remind, { machine: m1, as: "c", target: "a", text: "once", at: NOW + 5 * MIN, expiresMs: 5 * MIN });
    at(5 * MIN);
    await tick(t);
    expect((await get(t, r.reminder.id)).reminder).toMatchObject({ state: "done", fires: 1 });
  });
});

describe("review alerts", () => {
  it("BUG7: once 500 reminders have expired, a new expiry gets no reminder-expired alert", async () => {
    const t = await setup();
    for (let i = 0; i < 500; i++) {
      await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: `old ${i}`, everyMs: 10 * MIN, expiresMs: MIN });
    }
    at(MIN);
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("reminders").collect()) await ctx.db.patch(r._id, { state: "expired", stateAt: Date.now(), nextFireAt: undefined });
    });
    at(25 * 60 * MIN);
    const fresh = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "fresh", everyMs: 10 * MIN, expiresMs: MIN });
    at(26 * 60 * MIN);
    // (BUG1 stops tick expiring it; expire it as a fixed tick would)
    await t.run(async (ctx) => ctx.db.patch(fresh.reminder.id as any, { state: "expired", stateAt: Date.now(), nextFireAt: undefined }));
    await t.mutation(internal.alerts.scan, {});
    const alerts = await t.run(async (ctx) => (await ctx.db.query("alerts").collect()).filter((a) => a.subjectId === fresh.reminder.id));
    expect(alerts).toHaveLength(1);
  });
});
