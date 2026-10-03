// SCRATCH ONLY (follow-up re-check): seeds the volume cases for items 2, 3 and 5 on a scratch
// deployment; never part of main's deployed functions.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const byName = async (ctx: any, name: string) => (await ctx.db.query("participants").withIndex("by_name", (q: any) => q.eq("name", name)).unique())!;

async function convo(ctx: any, title: string, ago: number) {
  const a = await byName(ctx, "a");
  const lee = await byName(ctx, "lee");
  const now = Date.now();
  const conversationId = await ctx.db.insert("conversations", { kind: "group", title, lastSeq: 1, lastAt: now, createdAt: now });
  const messageId = await ctx.db.insert("messages", { conversationId, seq: 1, senderId: lee._id, recipientIds: [a._id], kind: "request", text: title, attachments: [], origin: { via: "web" }, createdAt: now - ago });
  return { a, lee, conversationId, messageId, now };
}

/** Item 2: `n` in-flight deliveries with claimCount 1, or `n` uncertain ones each with its open incident (already reported). */
export const seed = internalMutation({
  args: { kind: v.string(), n: v.number() },
  handler: async (ctx, { kind, n }) => {
    const { a, lee, conversationId, messageId, now } = await convo(ctx, `followup ${kind}`, 60_000);
    for (let i = 0; i < n; i++) {
      if (kind === "inflight") {
        await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: a._id, collect: true, state: "delivered", at: now - i, claimCount: 1, turnId: "t", createdAt: now - i });
      } else if (kind === "open-uncertain") {
        const d = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: a._id, collect: true, state: "uncertain", at: now - 30 * 86_400_000, uncertainReported: true, createdAt: now - 30 * 86_400_000 });
        await ctx.db.insert("alerts", { cause: "uncertain-delivery", subjectKind: "delivery", subjectId: d, ownerId: lee._id, messageId, conversationId, openedAt: now - 30 * 86_400_000, summary: "followup history" });
      } else if (kind === "inbox-same-time") {
        for (let j = 0; j < 1; j++) {
          const m = await ctx.db.insert("messages", { conversationId, seq: 2 + i, senderId: a._id, recipientIds: [lee._id], kind: "notice", text: `same tick ${i}`, attachments: [], origin: { via: "system" }, createdAt: now });
          await ctx.db.insert("inbox", { humanId: lee._id, messageId: m, conversationId, createdAt: now });
        }
      } else throw new Error(kind);
    }
    return { kind, n, conversationId };
  },
});

/** Scope (a): `n` answered results in a wait still running (not yet due), and one answered result whose wait ended long enough ago to be due. */
export const answeredNotDue = internalMutation({
  args: { n: v.number() },
  handler: async (ctx, { n }) => {
    const { a, conversationId, messageId, now } = await convo(ctx, "followup sweep", 0);
    const d = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: a._id, collect: true, state: "replied", at: now, createdAt: now });
    const running = await ctx.db.insert("waits", { waiterId: a._id, messageId, until: now + 3_600_000, active: true, lastAwaitAt: now + 600_000, inInboxIds: [], createdAt: now });
    for (let i = 0; i < n; i++) await ctx.db.insert("waitResults", { waitId: running, recipientId: a._id, deliveryId: d, state: "answered", at: now - 1 });
    const answer = await ctx.db.insert("messages", { conversationId, seq: 2, senderId: a._id, recipientIds: [a._id], kind: "answer", inReplyTo: messageId, text: "due answer", attachments: [], origin: { via: "cli" }, createdAt: now });
    const ended = await ctx.db.insert("waits", { waiterId: a._id, messageId, until: now, active: false, lastAwaitAt: now - 300_000, inInboxIds: [], endedAt: now - 300_000, createdAt: now - 400_000 });
    const due = await ctx.db.insert("waitResults", { waitId: ended, recipientId: a._id, deliveryId: d, state: "answered", answerMessageId: answer, fallbackDueAt: now - 180_000, at: now - 300_000 });
    return { due, answer };
  },
});

export const dueOutcome = internalQuery({
  args: { due: v.string(), answer: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(ctx.db.normalizeId("waitResults", args.due)!);
    const fallbacks = (await ctx.db.query("deliveries").withIndex("by_message", (q: any) => q.eq("messageId", args.answer)).collect()).filter((d: any) => d.fallback).length;
    return { state: r?.state, fallbacks };
  },
});

/** The new items: a reclaimed delivery, an open incident whose delivery cleared, and an uncertain delivery 2 h old never reported. */
export const fresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { a, lee, conversationId, messageId, now } = await convo(ctx, "followup fresh", 0);
    const reclaimed = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: a._id, collect: true, state: "delivered", at: now, claimCount: 9, turnId: "t", createdAt: now });
    const cleared = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: a._id, collect: true, state: "replied", at: now, uncertainReported: true, createdAt: now - 86_400_000 });
    const clearedAlert = await ctx.db.insert("alerts", { cause: "uncertain-delivery", subjectKind: "delivery", subjectId: cleared, ownerId: lee._id, messageId, conversationId, openedAt: now - 86_400_000, summary: "followup cleared" });
    const outage = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: a._id, collect: true, state: "uncertain", at: now - 2 * 3_600_000, createdAt: now - 2 * 3_600_000 });
    return { reclaimed, clearedAlert, outage };
  },
});

export const outcome = internalQuery({
  args: { reclaimed: v.string(), clearedAlert: v.string(), outage: v.string() },
  handler: async (ctx, args) => {
    const alertsFor = async (subjectId: string) => (await ctx.db.query("alerts").withIndex("by_subject", (q: any) => q.eq("cause", "delivery-reclaimed").eq("subjectId", subjectId)).collect()).length
      + (await ctx.db.query("alerts").withIndex("by_subject", (q: any) => q.eq("cause", "uncertain-delivery").eq("subjectId", subjectId)).collect()).length;
    const cleared = await ctx.db.get(ctx.db.normalizeId("alerts", args.clearedAlert)!);
    return {
      reclaimedAlerts: await alertsFor(args.reclaimed),
      outageAlerts: await alertsFor(args.outage),
      clearedIncidentResolved: cleared?.resolvedAt !== undefined,
      openIncidents: (await ctx.db.query("alerts").withIndex("by_resolved", (q: any) => q.eq("resolvedAt", undefined)).collect()).length,
    };
  },
});
