// The capabilities pass, R0: the Convex functions the web view calls (registry,
// inbox, reminders, alerts and their config). Rows the later steps write (inbox
// entries from post, fires, alerts from the cron) are seeded directly here.

import { DEFAULT_ALERT_CONFIG, MAX_DUTIES } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-01T12:00:00Z").getTime();

type T = Awaited<ReturnType<typeof setup>>;

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const name of ["a", "b"]) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", home: { machine: "m1", harness: "t3", locator: `loc-${name}` } });
  }
  return t;
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    return `plain: ${(error as Error).message}`;
  }
  return "no error";
}

const idOf = (t: T, name: string) =>
  t.run(async (ctx) => (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", name)).unique())!._id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

describe("R0 schema", () => {
  it("accepts the system kind, ownerId, description, duties and idleSince, but promotion refuses system", async () => {
    const t = await setup();
    const lee = await idOf(t, "lee");
    await t.run(async (ctx) => {
      await ctx.db.insert("participants", { name: "reminders", kind: "system", state: "active", presence: { status: "offline", at: NOW }, createdAt: NOW });
      const a = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "a")).unique())!;
      await ctx.db.patch(a._id, { ownerId: lee, description: "builds", duties: ["merge"], presence: { status: "idle", at: NOW, idleSince: NOW } });
    });
    expect(await errorCode(t.mutation(api.directory.promote, { adminToken: ADMIN, name: "x", kind: "system" } as never))).toMatch(/^plain: /);
  });
});

describe("R0 registry (web)", () => {
  it("lists every participant as a registry entry, with presence staleness from the machine's heartbeat", async () => {
    const t = await setup();
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    await t.mutation(api.connector.presence, { machine: m1, participant: "a", status: "idle" });
    const { agents } = await t.query(api.registry.list, { adminToken: ADMIN });
    const a = agents.find((e) => e.participant.name === "a")!;
    expect(a.state).toBe("active");
    expect(a.harness).toBe("t3");
    expect(a.home).toEqual({ machine: "m1", harness: "t3", locator: "loc-a" });
    expect(a.presence).toMatchObject({ status: "idle", stale: false, idleSince: NOW });
    const lee = agents.find((e) => e.participant.name === "lee")!;
    expect(lee.presence).toBeNull();
    expect(lee.harness).toBeUndefined();

    vi.setSystemTime(new Date(NOW + 10 * 60_000));
    const later = await t.query(api.registry.list, { adminToken: ADMIN });
    expect(later.agents.find((e) => e.participant.name === "a")!.presence!.stale).toBe(true);
  });

  it("idleSince moves only on the transition to idle, not on repeated idle writes", async () => {
    const t = await setup();
    await t.mutation(api.connector.presence, { machine: m1, participant: "a", status: "idle" });
    vi.setSystemTime(new Date(NOW + 60_000));
    await t.mutation(api.connector.presence, { machine: m1, participant: "a", status: "idle" });
    const p = await t.run(async (ctx) => (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "a")).unique())!.presence);
    expect(p).toEqual({ status: "idle", at: NOW + 60_000, idleSince: NOW });
    await t.mutation(api.connector.presence, { machine: m1, participant: "a", status: "busy" });
    const busy = await t.run(async (ctx) => (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "a")).unique())!.presence);
    expect(busy).toEqual({ status: "busy", at: NOW + 60_000 });
  });

  it("edits description and duties within their caps; empty clears", async () => {
    const t = await setup();
    const r = await t.mutation(api.registry.setProfile, { adminToken: ADMIN, name: "a", description: "Builds comms", duties: ["merge hazel", "keep services up"] });
    expect(r.agent).toMatchObject({ description: "Builds comms", duties: ["merge hazel", "keep services up"] });
    expect(await errorCode(t.mutation(api.registry.setProfile, { adminToken: ADMIN, name: "a", description: "x".repeat(201) }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.registry.setProfile, { adminToken: ADMIN, name: "a", duties: Array(MAX_DUTIES + 1).fill("d") }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.registry.setProfile, { adminToken: ADMIN, name: "a", duties: ["line\nbreak"] }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.registry.setProfile, { adminToken: ADMIN, name: "nobody", description: "x" }))).toBe("unknown_participant");
    const cleared = await t.mutation(api.registry.setProfile, { adminToken: ADMIN, name: "a", description: "", duties: [] });
    expect(cleared.agent.description).toBeUndefined();
    expect(cleared.agent.duties).toBeUndefined();
    expect(await errorCode(t.query(api.registry.list, { adminToken: "wrong" }))).toBe("plain: admin token rejected");
  });
});

async function seedMessage(t: T, text: string, conversation?: Id<"conversations">) {
  const lee = await idOf(t, "lee");
  const a = await idOf(t, "a");
  return t.run(async (ctx) => {
    const conversationId =
      conversation ?? (await ctx.db.insert("conversations", { kind: "dm", dmKey: `${a}:${lee}`, lastSeq: 0, lastAt: NOW, createdAt: NOW }));
    const c = (await ctx.db.get(conversationId))!;
    const seq = c.lastSeq + 1;
    await ctx.db.patch(conversationId, { lastSeq: seq, lastAt: Date.now() });
    const messageId = await ctx.db.insert("messages", {
      conversationId, seq, senderId: a, recipientIds: [lee], kind: "request", text, attachments: [], origin: { via: "cli" }, createdAt: Date.now(),
    });
    await ctx.db.insert("inbox", { humanId: lee, messageId, conversationId, createdAt: Date.now() });
    return { conversationId, messageId };
  });
}

describe("R0 inbox (web)", () => {
  it("lists a person's inbox newest first with the unread count, and marks read by message or conversation", async () => {
    const t = await setup();
    const first = await seedMessage(t, "one");
    vi.setSystemTime(new Date(NOW + 1_000));
    const second = await seedMessage(t, "two", first.conversationId);
    vi.setSystemTime(new Date(NOW + 2_000));
    await seedMessage(t, "elsewhere");

    const listed = await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee" });
    expect(listed.items.map((i) => i.message.text)).toEqual(["elsewhere", "two", "one"]);
    expect(listed.items.every((i) => i.readAt === null)).toBe(true);
    expect(listed.unread).toBe(3);
    expect((await t.query(api.inbox.unreadCount, { adminToken: ADMIN, human: "lee" })).unread).toBe(3);

    expect((await t.mutation(api.inbox.markRead, { adminToken: ADMIN, human: "lee", messageIds: [second.messageId] })).marked).toBe(1);
    expect((await t.mutation(api.inbox.markRead, { adminToken: ADMIN, human: "lee", messageIds: [second.messageId] })).marked).toBe(0);
    expect((await t.query(api.inbox.unreadCount, { adminToken: ADMIN, human: "lee" })).unread).toBe(2);
    expect((await t.mutation(api.inbox.markRead, { adminToken: ADMIN, human: "lee", conversationId: first.conversationId })).marked).toBe(1);
    const after = await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee", unreadOnly: true });
    expect(after.items.map((i) => i.message.text)).toEqual(["elsewhere"]);
    expect(after.unread).toBe(1);
    expect(await errorCode(t.query(api.inbox.list, { adminToken: ADMIN, human: "a" }))).toBe("bad_request");
  });
});

describe("R0 reminders (web)", () => {
  it("creates a reminder as a person, with its first fire one interval out and the default expiry", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "check CI", everyMs: 30 * 60_000, name: "ci" });
    expect(reminder).toMatchObject({
      name: "ci", text: "check CI", state: "active", fires: 0, schedule: { everyMs: 1_800_000 },
      nextFireAt: NOW + 1_800_000, expiresAt: NOW + 7 * 86_400_000, createdAt: NOW,
    });
    expect(reminder.target.name).toBe("a");
    expect(reminder.createdBy.name).toBe("lee");
    expect(await errorCode(t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 30_000 }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x" }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "lee", text: "x", at: NOW + 60_000 }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", at: NOW - 1 }))).toBe("bad_request");
    const once = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", at: NOW + 3_600_000, watch: "b", idleForMs: 1_200_000, reportTo: "lee", max: 3 });
    expect(once.reminder).toMatchObject({ schedule: { at: NOW + 3_600_000 }, nextFireAt: NOW + 3_600_000, idleForMs: 1_200_000, max: 3 });
    expect(once.reminder.watch?.name).toBe("b");
    expect(once.reminder.reportTo?.name).toBe("lee");
  });

  it("lists, shows with fires and skips, and moves through pause, resume, blocked, done", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 60_000 });
    const listed = await t.query(api.reminders.list, { adminToken: ADMIN });
    expect(listed.reminders.map((r) => r.id)).toEqual([reminder.id]);
    expect((await t.query(api.reminders.list, { adminToken: ADMIN, state: "paused" })).reminders).toEqual([]);

    const shown = await t.query(api.reminders.get, { adminToken: ADMIN, id: reminder.id });
    expect(shown).toMatchObject({ fires: [], skips: [] });

    const step = (action: "pause" | "resume" | "done" | "cancel" | "blocked", reason?: string) =>
      t.mutation(api.reminders.update, { adminToken: ADMIN, id: reminder.id, action, ...(reason ? { reason } : {}) });
    expect((await step("pause")).reminder.state).toBe("paused");
    expect((await step("resume")).reminder.state).toBe("active");
    expect(await errorCode(step("blocked"))).toBe("bad_request");
    expect((await step("blocked", "CI creds expired")).reminder).toMatchObject({ state: "blocked", stateReason: "CI creds expired" });
    expect((await step("resume")).reminder.state).toBe("active");
    expect((await step("done")).reminder.state).toBe("done");
    expect(await errorCode(step("resume"))).toBe("conflict");
    expect(await errorCode(t.query(api.reminders.get, { adminToken: ADMIN, id: "nope" }))).toBe("unknown_reminder");
  });
});

describe("R0 alerts (web)", () => {
  it("lists incidents newest first, open only on request, and reads and sets the thresholds", async () => {
    const t = await setup();
    const lee = await idOf(t, "lee");
    const { messageId } = await seedMessage(t, "Alert: …");
    await t.run(async (ctx) => {
      await ctx.db.insert("alerts", { cause: "connector-silent", subjectKind: "machine", subjectId: "m1", ownerId: lee, messageId, openedAt: NOW - 2_000, resolvedAt: NOW - 1_000, summary: "down" });
      await ctx.db.insert("alerts", { cause: "connector-silent", subjectKind: "machine", subjectId: "m1", ownerId: lee, messageId, openedAt: NOW, summary: "down again" });
    });
    const all = await t.query(api.alerts.list, { adminToken: ADMIN });
    expect(all.alerts.map((a) => a.summary)).toEqual(["down again", "down"]);
    expect(all.alerts[0]).toMatchObject({ cause: "connector-silent", subject: { kind: "machine", id: "m1" }, openedAt: NOW, owner: { name: "lee" } });
    expect(all.alerts[0]!.resolvedAt).toBeUndefined();
    expect((await t.query(api.alerts.list, { adminToken: ADMIN, openOnly: true })).alerts.map((a) => a.summary)).toEqual(["down again"]);

    expect(await t.query(api.alerts.config, { adminToken: ADMIN })).toEqual(DEFAULT_ALERT_CONFIG);
    const set = await t.mutation(api.alerts.setConfig, { adminToken: ADMIN, maxClaims: 8 });
    expect(set).toEqual({ ...DEFAULT_ALERT_CONFIG, maxClaims: 8 });
    expect(await t.query(api.alerts.config, { adminToken: ADMIN })).toEqual(set);
    expect(await errorCode(t.mutation(api.alerts.setConfig, { adminToken: ADMIN, connectorSilentMs: 1_000 }))).toBe("bad_request");
  });
});
