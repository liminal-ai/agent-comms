// A person's inbox for the web view (capabilities pass §2). People get no
// deliveries; post() writes an inbox row for each person a message addresses
// (R1), and the web view marks them read. Admin only.

import type { InboxItem } from "@agent-comms/protocol";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, type QueryCtx, query } from "./_generated/server";
import { conversationRef, envelope, fail, getOr, participantByName, requireAdmin } from "./lib/core";

const MAX_LIST = 200;

async function human(ctx: QueryCtx, name: string): Promise<Doc<"participants">> {
  const p = await participantByName(ctx, name);
  if (p.kind !== "human") fail("bad_request", `@${name} isn't a person; only people have an inbox`);
  return p;
}

async function unread(ctx: QueryCtx, humanId: Doc<"participants">["_id"]): Promise<number> {
  return (
    await ctx.db
      .query("inbox")
      .withIndex("by_human_read", (q) => q.eq("humanId", humanId).eq("readAt", undefined))
      .collect()
  ).length;
}

/** The newest `limit` (default 50, at most 200) inbox items, newest first, and the unread count. */
export const list = query({
  args: { adminToken: v.string(), human: v.string(), unreadOnly: v.optional(v.boolean()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const h = await human(ctx, args.human);
    const limit = Math.max(1, Math.min(args.limit ?? 50, MAX_LIST));
    const rows = args.unreadOnly
      ? (
          await ctx.db
            .query("inbox")
            .withIndex("by_human_read", (q) => q.eq("humanId", h._id).eq("readAt", undefined))
            .collect()
        )
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)
      : await ctx.db
          .query("inbox")
          .withIndex("by_human", (q) => q.eq("humanId", h._id))
          .order("desc")
          .take(limit);
    const items: InboxItem[] = [];
    for (const row of rows) {
      const message = await ctx.db.get(row.messageId);
      const conversation = await ctx.db.get(row.conversationId);
      if (!message || !conversation) continue;
      items.push({ message: await envelope(ctx, message), conversation: conversationRef(conversation), readAt: row.readAt ?? null });
    }
    return { items, unread: await unread(ctx, h._id) };
  },
});

export const unreadCount = query({
  args: { adminToken: v.string(), human: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    return { unread: await unread(ctx, (await human(ctx, args.human))._id) };
  },
});

/** Mark items read: these messages, or everything unread in one conversation. Idempotent; returns how many changed. */
export const markRead = mutation({
  args: { adminToken: v.string(), human: v.string(), messageIds: v.optional(v.array(v.string())), conversationId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const h = await human(ctx, args.human);
    if ((args.messageIds === undefined) === (args.conversationId === undefined)) {
      fail("bad_request", "give exactly one of messageIds and conversationId");
    }
    const now = Date.now();
    let marked = 0;
    if (args.conversationId !== undefined) {
      const c = await getOr(ctx, "conversations", args.conversationId);
      const rows = await ctx.db
        .query("inbox")
        .withIndex("by_human_conversation", (q) => q.eq("humanId", h._id).eq("conversationId", c._id).eq("readAt", undefined))
        .collect();
      for (const row of rows) await ctx.db.patch(row._id, { readAt: now });
      marked = rows.length;
    } else {
      for (const id of args.messageIds!.slice(0, MAX_LIST)) {
        const m = await getOr(ctx, "messages", id);
        const row = await ctx.db
          .query("inbox")
          .withIndex("by_human_message", (q) => q.eq("humanId", h._id).eq("messageId", m._id))
          .unique();
        if (row && row.readAt === undefined) {
          await ctx.db.patch(row._id, { readAt: now });
          marked++;
        }
      }
    }
    return { marked, unread: await unread(ctx, h._id) };
  },
});
