// The capabilities pass, R0: the Convex functions the web view calls (registry,
// inbox, reminders, alerts and their config). Rows the later steps write (inbox
// entries from post, fires, alerts from the cron) are seeded directly here.

import { DEFAULT_ALERT_CONFIG, MAX_DUTIES } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { post } from "./lib/post";
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
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${name}` } });
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
    expect(busy).toEqual({ status: "busy", at: NOW + 60_000, busySince: NOW + 60_000 });
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
    await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" }); // @reminders tells the creator when it ends
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
    const { messageId, conversationId } = await seedMessage(t, "Alert: …");
    await t.run(async (ctx) => {
      await ctx.db.insert("alerts", { cause: "connector-silent", subjectKind: "machine", subjectId: "m1", ownerId: lee, messageId, conversationId, openedAt: NOW - 2_000, resolvedAt: NOW - 1_000, summary: "down" });
      await ctx.db.insert("alerts", { cause: "connector-silent", subjectKind: "machine", subjectId: "m1", ownerId: lee, messageId, conversationId, openedAt: NOW, summary: "down again" });
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

describe("R0 review (Hazel)", () => {
  it("busySince moves only on the transition to busy (an ack counts only within the same busy stretch, R2)", async () => {
    const t = await setup();
    await t.mutation(api.connector.presence, { machine: m1, participant: "a", status: "busy" });
    vi.setSystemTime(new Date(NOW + 60_000));
    await t.mutation(api.connector.presence, { machine: m1, participant: "a", status: "busy" });
    const read = () => t.run(async (ctx) => (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "a")).unique())!.presence);
    expect(await read()).toEqual({ status: "busy", at: NOW + 60_000, busySince: NOW });
    await t.mutation(api.connector.presence, { machine: m1, participant: "a", status: "idle" });
    expect(await read()).toEqual({ status: "idle", at: NOW + 60_000, idleSince: NOW + 60_000 });
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    vi.setSystemTime(new Date(NOW + 70_000));
    await t.mutation(api.connector.presence, { machine: m1, participant: "a", status: "busy" });
    const { agents } = await t.query(api.registry.list, { adminToken: ADMIN });
    expect(agents.find((e) => e.participant.name === "a")!.presence).toEqual({ status: "busy", at: NOW + 70_000, busySince: NOW + 70_000, stale: false });
  });

  it("an alert carries its DM's conversation id, and a delivery subject's conversation too", async () => {
    const t = await setup();
    const lee = await idOf(t, "lee");
    const { messageId, conversationId } = await seedMessage(t, "Alert: …");
    await t.run(async (ctx) => {
      await ctx.db.insert("alerts", {
        cause: "uncertain-delivery", subjectKind: "delivery", subjectId: "d_x", subjectConversationId: conversationId,
        ownerId: lee, messageId, conversationId, openedAt: NOW, summary: "uncertain",
      });
    });
    const [alert] = (await t.query(api.alerts.list, { adminToken: ADMIN })).alerts;
    expect(alert).toMatchObject({ conversationId, subject: { kind: "delivery", id: "d_x", conversationId } });
  });

  it("reminders.list carries each reminder's last fire and last skip", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: 60_000 });
    const { messageId, conversationId } = await seedMessage(t, "fire");
    await t.run(async (ctx) => {
      const rid = ctx.db.normalizeId("reminders", reminder.id)!;
      const a = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "a")).unique())!;
      const deliveryId = await ctx.db.insert("deliveries", {
        messageId, conversationId, recipientId: a._id, collect: true, state: "delivered", at: NOW, createdAt: NOW,
      });
      await ctx.db.insert("reminderFires", { reminderId: rid, messageId, deliveryId, firedAt: NOW });
      await ctx.db.patch(rid, { skips: [{ at: NOW + 60_000, reason: "previous-fire-not-final" }] });
    });
    const [listed] = (await t.query(api.reminders.list, { adminToken: ADMIN })).reminders;
    expect(listed).toMatchObject({ lastFire: { messageId, deliveryState: "delivered", firedAt: NOW }, lastSkip: { at: NOW + 60_000, reason: "previous-fire-not-final" } });
  });
});

// ---------------------------------------------------------------------------
// R1: registry, owner, reserved names, @owner, inbox

const agentHome = (name: string) => ({ machine: "m1", harness: "t3" as const, locator: `loc-${name}` });
const byName = (t: T, name: string) =>
  t.run(async (ctx) => (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", name)).unique())!);
const inboxOf = (t: T, name: string) =>
  t.run(async (ctx) => {
    const h = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", name)).unique())!;
    return ctx.db.query("inbox").withIndex("by_human", (q) => q.eq("humanId", h._id)).collect();
  });

describe("R1 promotion: owner and reserved names", () => {
  it("requires a person as an agent's owner, stores it as ownerId, and refuses reserved names", async () => {
    const t = await setup();
    const promote = (args: Record<string, unknown>) => t.mutation(api.directory.promote, { adminToken: ADMIN, ...args } as never);
    expect(await errorCode(promote({ name: "x", kind: "agent", home: agentHome("x") }))).toBe("bad_request");
    expect(await errorCode(promote({ name: "x", kind: "agent", home: agentHome("x"), owner: "a" }))).toBe("bad_request");
    expect(await errorCode(promote({ name: "x", kind: "agent", home: agentHome("x"), owner: "nobody" }))).toBe("unknown_participant");
    for (const name of ["owner", "all", "reminders", "alerts"]) {
      expect(await errorCode(promote({ name, kind: "agent", home: agentHome(name), owner: "lee" })), name).toBe("bad_request");
      expect(await errorCode(promote({ name, kind: "human" })), name).toBe("bad_request");
    }
    const r = await promote({ name: "x", kind: "agent", home: agentHome("x"), owner: "lee", description: "does x", duties: ["one"] });
    expect(r.participant.name).toBe("x");
    const x = await byName(t, "x");
    expect(x.ownerId).toBe(await idOf(t, "lee"));
    const entry = (await t.query(api.registry.list, { adminToken: ADMIN })).agents.find((e) => e.participant.name === "x")!;
    expect(entry).toMatchObject({ owner: { name: "lee", kind: "human" }, description: "does x", duties: ["one"] });
    expect(await errorCode(promote({ name: "y", kind: "human", owner: "lee" }))).toBe("bad_request");
  });
});

describe("R1 upgrade: system participants and the owner backfill", () => {
  it("creates @reminders and @alerts and gives every agent without an owner the default, idempotently", async () => {
    const t = await setup();
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "sam", kind: "human" });
    await t.run(async (ctx) => {
      const now = Date.now();
      const base = { kind: "agent" as const, state: "active" as const, presence: { status: "offline" as const, at: now }, createdAt: now };
      await ctx.db.insert("participants", { ...base, name: "legacy-none", home: agentHome("legacy-none") });
      const sam = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "sam")).unique())!;
      await ctx.db.insert("participants", { ...base, name: "owned", ownerId: sam._id, home: agentHome("owned") });
    });
    const first = await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    expect(first).toEqual({ systemCreated: ["reminders", "alerts"], systemRepaired: [], ownersSet: 1 });
    expect((await byName(t, "legacy-none")).ownerId).toBe(await idOf(t, "lee"));
    expect((await byName(t, "owned")).ownerId).toBe(await idOf(t, "sam"));
    expect((await byName(t, "sam")).ownerId).toBeUndefined();
    const reminders = await byName(t, "reminders");
    expect(reminders).toMatchObject({ kind: "system", state: "active" });
    expect(reminders.home).toBeUndefined();
    expect(await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" })).toEqual({ systemCreated: [], systemRepaired: [], ownersSet: 0 });
    expect(await errorCode(t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "a" }))).toBe("bad_request");
  });

  it("refuses when a non-system participant holds a system name", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("participants", { name: "alerts", kind: "human", state: "active", presence: { status: "offline", at: NOW }, createdAt: NOW });
    });
    expect(await errorCode(t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" }))).toBe("conflict");
  });
});

describe("R1 addressing: @owner, system participants, the inbox", () => {
  it("@owner resolves to the sending agent's owner, and the message lands in their inbox, not as a delivery", async () => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["owner"], text: "need a decision" });
    expect(sent.message.recipients.map((r) => r.name)).toEqual(["lee"]);
    expect(sent.deliveries).toEqual([]);
    const inbox = await inboxOf(t, "lee");
    expect(inbox.map((i) => i.messageId)).toEqual([sent.message.id]);
    expect(inbox[0]!.readAt).toBeUndefined();
    expect((await t.query(api.inbox.unreadCount, { adminToken: ADMIN, human: "lee" })).unread).toBe(1);

    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["lee", "a", "b"] });
    const inGroup = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["owner", "b"], conversationId: g.conversation.id, text: "both" });
    expect(inGroup.message.recipients.map((r) => r.name)).toEqual(["lee", "b"]);
    expect(inGroup.deliveries.map((d) => d.recipient)).toEqual(["b"]);
    expect((await inboxOf(t, "lee")).length).toBe(2);
  });

  it("@owner without an owner is refused; system participants can't be addressed", async () => {
    const t = await setup();
    await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    await t.run(async (ctx) => {
      const b = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "b")).unique())!;
      await ctx.db.patch(b._id, { ownerId: undefined });
    });
    expect(await errorCode(t.mutation(api.connector.send, { machine: m1, as: "b", to: ["owner"], text: "x" }))).toBe("bad_request");
    for (const name of ["reminders", "alerts"]) {
      expect(await errorCode(t.mutation(api.connector.send, { machine: m1, as: "a", to: [name], text: "x" })), name).toBe("bad_request");
    }
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["lee", "a"] });
    expect(await errorCode(t.mutation(api.conversations.postAs, { adminToken: ADMIN, as: "lee", conversationId: g.conversation.id, to: ["owner"], text: "x" }))).toBe("unknown_participant");
  });

  it("a system participant's message to a person goes to their inbox, and an agent's answer to a system request addresses no one", async () => {
    const t = await setup();
    await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    const posted = await t.run(async (ctx) => {
      const alerts = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "alerts")).unique())!;
      const reminders = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "reminders")).unique())!;
      const lee = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "lee")).unique())!;
      const a = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "a")).unique())!;
      const { openDm } = await import("./lib/post");
      const alert = await post(ctx as never, { sender: alerts, conversation: await openDm(ctx as never, alerts, lee), recipients: [lee], kind: "request", text: "Alert: x", origin: { via: "web" } });
      const fire = await post(ctx as never, { sender: reminders, conversation: await openDm(ctx as never, reminders, a), recipients: [a], kind: "request", text: "check CI", origin: { via: "web" } });
      return { alert, fire };
    });
    expect(posted.alert.deliveries).toEqual([]);
    expect((await inboxOf(t, "lee")).map((i) => i.messageId)).toEqual([posted.alert.message.id]);

    const id = posted.fire.deliveries[0]!.id;
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId: claim.claimId, turnId: "t1" });
    const r = await t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId: claim.claimId, turnId: "t1", answer: "CI green" });
    expect(r.delivery.state).toBe("replied");
    const answer = await t.run(async (ctx) => ctx.db.get(r.answerMessageId as Id<"messages">));
    expect(answer!.recipientIds).toEqual([]);
    const toSystem = await t.run(async (ctx) => (await ctx.db.query("deliveries").collect()).filter((d) => d.messageId === answer!._id));
    expect(toSystem).toEqual([]);
    const replied = await t.mutation(api.connector.reply, { machine: m1, as: "a", messageId: posted.fire.message.id, text: "also" });
    expect(replied.message.recipients).toEqual([]);
  });

  it("a retired person gets no inbox row", async () => {
    const t = await setup();
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "sam", kind: "human" });
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["lee", "sam", "a"] });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "sam", state: "retired" });
    await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["lee", "sam"], conversationId: g.conversation.id, text: "hi" });
    expect((await inboxOf(t, "lee")).length).toBe(1);
    expect((await inboxOf(t, "sam")).length).toBe(0);
  });
});

describe("R1 registry over the connector", () => {
  it("lists non-retired participants (homes only with long), shows one, and lets an agent edit only itself", async () => {
    const t = await setup();
    await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "gone", kind: "agent", owner: "lee", home: agentHome("gone") });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "gone", state: "retired" });
    const all = await t.query(api.connector.agents, { machine: m1, as: "a" });
    expect(all.agents.map((e) => e.participant.name)).toEqual(["a", "alerts", "b", "lee", "reminders"]);
    expect(all.agents.find((e) => e.participant.name === "a")!.home).toBeUndefined();
    const one = await t.query(api.connector.agents, { machine: m1, as: "a", name: "b", long: true });
    expect(one.agents).toHaveLength(1);
    expect(one.agents[0]!.home).toEqual(agentHome("b"));
    expect(await errorCode(t.query(api.connector.agents, { machine: m1, as: "a", name: "nobody" }))).toBe("unknown_participant");

    const set = await t.mutation(api.connector.agentsSet, { machine: m1, as: "a", name: "a", description: "builds comms", duties: ["merge"] });
    expect(set.agent).toMatchObject({ description: "builds comms", duties: ["merge"] });
    expect(await errorCode(t.mutation(api.connector.agentsSet, { machine: m1, as: "a", name: "b", description: "x" }))).toBe("conflict");
  });
});

describe("fix pass 1.6: system participants are protected", () => {
  it("setState, rebind and setProfile refuse @alerts and @reminders; upgrade repairs one retired by a direct database edit", async () => {
    const t = await setup();
    await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    for (const name of ["alerts", "reminders"]) {
      expect(await errorCode(t.mutation(api.directory.setState, { adminToken: ADMIN, name, state: "retired" })), name).toBe("bad_request");
      expect(await errorCode(t.mutation(api.directory.setState, { adminToken: ADMIN, name, state: "paused" })), name).toBe("bad_request");
      expect(await errorCode(t.mutation(api.directory.rebind, { adminToken: ADMIN, name, home: agentHome(name) })), name).toBe("bad_request");
      expect(await errorCode(t.mutation(api.registry.setProfile, { adminToken: ADMIN, name, description: "x" })), name).toBe("bad_request");
    }
    await t.run(async (ctx) => {
      const p = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "alerts")).unique())!;
      await ctx.db.patch(p._id, { state: "retired" });
    });
    const r = await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    expect(r.systemRepaired).toEqual(["alerts"]);
    expect((await byName(t, "alerts")).state).toBe("active");
  });
});
