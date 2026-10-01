// The capabilities pass, R4: alerts. A minute cron (`alerts.scan`) opens an
// incident, and posts one alert from @alerts to the affected agent's owner, when
// a condition starts; the incident resolves when it clears, and a recurrence is
// a new incident with a new alert. Recovery isn't announced.

import { convexTest } from "convex-test";
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
  for (const name of ["a", "b"]) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${name}` } });
  }
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;

const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const scan = (t: T) => t.mutation(internal.alerts.scan, {});
const alerts = async (t: T) => (await t.query(api.alerts.list, { adminToken: ADMIN })).alerts;
const inbox = async (t: T) => (await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee" })).items;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("R4 alerts", () => {
  it("an uncertain delivery alerts its recipient's owner once, with the delivery and its conversation; it resolves when completed", async () => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q" });
    const id = sent.deliveries[0]!.id;
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
    await t.mutation(api.connector.uncertain, { machine: m1, deliveryId: id, claimId: claim.claimId, detail: "restart" });
    await scan(t);
    await scan(t);
    const [alert] = await alerts(t);
    expect(await alerts(t)).toHaveLength(1);
    expect(alert).toMatchObject({
      cause: "uncertain-delivery",
      subject: { kind: "delivery", id, conversationId: sent.message.conversationId },
      owner: { name: "lee" },
      openedAt: NOW,
    });
    const [item] = await inbox(t);
    expect(item!.message).toMatchObject({ id: alert!.messageId, sender: { name: "alerts", kind: "system" }, meta: { type: "alert", alertId: alert!.id, cause: "uncertain-delivery" } });
    expect(item!.message.text).toMatch(new RegExp(`^Alert: delivery ${id} is uncertain`));
    expect(item!.conversation.id).toBe(alert!.conversationId);

    await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "it did run" });
    at(MIN);
    await scan(t);
    expect((await alerts(t))[0]!.resolvedAt).toBe(NOW + MIN);
  });

  it("a silent connector alerts once per incident: down, recovered, down gives two alerts", async () => {
    const t = await setup();
    at(9 * MIN);
    await scan(t);
    expect(await alerts(t)).toEqual([]);
    at(10 * MIN);
    await scan(t);
    await scan(t);
    expect((await alerts(t)).map((a) => [a.cause, a.subject.id])).toEqual([["connector-silent", "m1"]]);
    expect((await inbox(t))[0]!.message.text).toMatch(/^Alert: the connector on m1 hasn't been heard from/);
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    at(11 * MIN);
    await scan(t);
    expect((await alerts(t))[0]!.resolvedAt).toBe(NOW + 11 * MIN);
    at(21 * MIN);
    await scan(t);
    expect((await alerts(t)).map((a) => a.resolvedAt === undefined)).toEqual([true, false]);
    expect(await inbox(t)).toHaveLength(2);
  });

  it("a reminder blocked past the threshold alerts the target's owner; an expired one alerts once", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 30 * MIN, expiresMs: 3 * 60 * MIN, name: "r" });
    await t.mutation(api.reminders.update, { adminToken: ADMIN, id: reminder.id, action: "blocked", reason: "no creds" });
    const beat = () => t.mutation(api.connector.heartbeat, { machine: m1 });
    at(59 * MIN);
    await beat();
    await scan(t);
    expect(await alerts(t)).toEqual([]);
    at(60 * MIN);
    await beat();
    await scan(t);
    expect((await alerts(t)).map((a) => [a.cause, a.subject])).toEqual([["reminder-blocked", { kind: "reminder", id: reminder.id }]]);
    await t.mutation(api.reminders.update, { adminToken: ADMIN, id: reminder.id, action: "resume" });
    at(61 * MIN);
    await beat();
    await scan(t);
    expect((await alerts(t))[0]!.resolvedAt).toBe(NOW + 61 * MIN);

    at(3 * 60 * MIN);
    await beat();
    await t.mutation(internal.reminders.tick, {});
    await scan(t);
    await scan(t);
    const expired = (await alerts(t)).filter((a) => a.cause === "reminder-expired");
    expect(expired).toHaveLength(1);
  });

  it("counts claims, and a delivery claimed more than maxClaims times alerts", async () => {
    const t = await setup();
    await t.mutation(api.alerts.setConfig, { adminToken: ADMIN, maxClaims: 2 });
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q" });
    const id = sent.deliveries[0]!.id;
    for (let i = 0; i < 3; i++) {
      at(i * 2 * MIN);
      await t.mutation(api.connector.heartbeat, { machine: m1 });
      await t.mutation(api.connector.claim, { machine: m1, deliveryId: id, leaseMs: MIN });
    }
    expect(await t.run(async (ctx) => (await ctx.db.get(id as never) as { claimCount?: number } | null)?.claimCount)).toBe(3);
    await scan(t);
    expect((await alerts(t)).map((a) => [a.cause, a.subject.id])).toEqual([["delivery-reclaimed", id]]);
  });

  it("an agent with no owner (impossible after the migration) and a retired one raise nothing; no system participant gets a delivery", async () => {
    const t = await setup();
    at(10 * MIN);
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "a", state: "retired" });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "b", state: "retired" });
    await scan(t);
    expect(await alerts(t)).toEqual([]);
    const toSystem = await t.run(async (ctx) => {
      const system = (await ctx.db.query("participants").collect()).filter((p) => p.kind === "system").map((p) => p._id);
      return (await ctx.db.query("deliveries").collect()).filter((d) => system.includes(d.recipientId));
    });
    expect(toSystem).toEqual([]);
  });
});
