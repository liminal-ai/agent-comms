// SCRATCH ONLY (fix pass section 4 scale run): copied into a scratch deployment's convex/
// folder to seed thousands of finished rows; never part of main's deployed functions.
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

const DAY = 24 * 60 * 60_000;

async function byName(ctx: any, name: string) {
  return (await ctx.db.query("participants").withIndex("by_name", (q: any) => q.eq("name", name)).unique())!;
}

/** One batch of finished history of one kind. */
export const seed = internalMutation({
  args: { kind: v.string(), n: v.number(), offset: v.number() },
  handler: async (ctx, { kind, n, offset }) => {
    const now = Date.now();
    const a = await byName(ctx, "a");
    const b = await byName(ctx, "b");
    const lee = await byName(ctx, "lee");
    const conversationId = await ctx.db.insert("conversations", { kind: "group", title: `history ${kind} ${offset}`, lastSeq: 1, lastAt: now, createdAt: now });
    const messageId = await ctx.db.insert("messages", {
      conversationId, seq: 1, senderId: a._id, recipientIds: [b._id], kind: "request", text: "history", attachments: [], origin: { via: "cli" }, createdAt: now - 3 * DAY,
    });
    for (let i = 0; i < n; i++) {
      const old = now - 2 * DAY - (offset + i) * 1_000;
      switch (kind) {
        case "answers":
          await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: b._id, collect: false, state: "delivered", at: old, createdAt: old });
          break;
        case "replied":
          await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: b._id, collect: true, state: "replied", at: old, claimCount: 9, createdAt: old });
          break;
        case "uncertain":
          await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: b._id, collect: true, state: "uncertain", at: old, createdAt: old });
          break;
        case "reminders":
          await ctx.db.insert("reminders", {
            name: `old ${offset + i}`, text: "history", targetId: a._id, createdById: lee._id, everyMs: 60_000,
            state: (["expired", "done", "cancelled"] as const)[i % 3], stateAt: old, fires: 3, expiresAt: old, skips: [], createdAt: old - DAY,
          });
          break;
        case "alerts":
          await ctx.db.insert("alerts", {
            cause: "uncertain-delivery", subjectKind: "delivery", subjectId: `old-${offset + i}`, ownerId: lee._id, messageId, conversationId,
            openedAt: old, resolvedAt: old + 60_000, summary: "history",
          });
          break;
        case "waits": {
          const d = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: b._id, collect: true, state: "replied", at: old, createdAt: old });
          const waitId = await ctx.db.insert("waits", { waiterId: a._id, messageId, until: old, active: false, lastAwaitAt: old, inInboxIds: [], endedAt: old, createdAt: old });
          await ctx.db.insert("waitResults", { waitId, recipientId: b._id, deliveryId: d, state: i % 2 ? "fell-back" : "acknowledged", at: old });
          break;
        }
        default:
          throw new Error(`unknown kind ${kind}`);
      }
    }
    return { kind, n };
  },
});

/** The new things that must not be hidden: an uncertain delivery and a reclaimed one, now. */
export const fresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const a = await byName(ctx, "a");
    const b = await byName(ctx, "b");
    const conversationId = await ctx.db.insert("conversations", { kind: "group", title: "fresh", lastSeq: 1, lastAt: now, createdAt: now });
    const messageId = await ctx.db.insert("messages", {
      conversationId, seq: 1, senderId: a._id, recipientIds: [b._id], kind: "request", text: "fresh", attachments: [], origin: { via: "cli" }, createdAt: now,
    });
    const uncertain: Id<"deliveries"> = await ctx.db.insert("deliveries", { messageId, conversationId, recipientId: b._id, collect: true, state: "uncertain", at: now, createdAt: now });
    const reclaimed: Id<"deliveries"> = await ctx.db.insert("deliveries", {
      messageId, conversationId, recipientId: b._id, collect: true, state: "delivered", at: now, claimCount: 9, turnId: "t", createdAt: now,
    });
    return { uncertain, reclaimed };
  },
});

export const counts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const count = async (table: any) => (await ctx.db.query(table).collect()).length;
    return {
      deliveries: await count("deliveries"), reminders: await count("reminders"), alerts: await count("alerts"),
      waits: await count("waits"), waitResults: await count("waitResults"), messages: await count("messages"),
    };
  },
});

export const stateOf = internalQuery({
  args: { reminderIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.reminderIds) {
      const r = await ctx.db.get(ctx.db.normalizeId("reminders", id)!);
      out.push({ id, state: r?.state, fires: r?.fires });
    }
    const open = await ctx.db.query("alerts").withIndex("by_resolved", (q: any) => q.eq("resolvedAt", undefined)).collect();
    return { reminders: out, openAlerts: open.map((a: any) => ({ cause: a.cause, subjectId: a.subjectId })) };
  },
});
