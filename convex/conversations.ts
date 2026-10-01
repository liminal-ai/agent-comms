import { MAX_TITLE_CHARS } from "@agent-comms/protocol";
// Conversations, membership and Lee's posts. Admin only (the web view).

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { conversationRef, envelope, fail, getOr, participantByName, refById, requireAdmin, stateRef, summary } from "./lib/core";
import { openDm as openDmBetween, post } from "./lib/post";

export const createGroup = mutation({
  args: { adminToken: v.string(), title: v.string(), members: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    if (!args.title.trim()) fail("bad_request", "a group needs a title");
    if (args.title.length > MAX_TITLE_CHARS) fail("bad_request", `the title is ${args.title.length} characters; the limit is ${MAX_TITLE_CHARS}`);
    const people = [];
    for (const name of new Set(args.members)) people.push(await participantByName(ctx, name));
    if (people.length < 2) fail("bad_request", "a group needs at least two members");
    const now = Date.now();
    const id = await ctx.db.insert("conversations", { kind: "group", title: args.title, lastSeq: 0, lastAt: now, createdAt: now });
    for (const p of people) await ctx.db.insert("members", { conversationId: id, participantId: p._id, readSeq: 0, joinedAt: now });
    return { conversation: conversationRef((await ctx.db.get(id))!) };
  },
});

export const openDm = mutation({
  args: { adminToken: v.string(), a: v.string(), b: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const c = await openDmBetween(ctx, await participantByName(ctx, args.a), await participantByName(ctx, args.b));
    return { conversation: conversationRef(c) };
  },
});

async function group(ctx: Parameters<typeof getOr>[0], id: string): Promise<Doc<"conversations">> {
  const c = await getOr(ctx, "conversations", id);
  if (c.kind !== "group") fail("bad_request", "DM membership is fixed");
  return c;
}

/** A new member starts with everything so far counted as read; older messages are there for `comms read`. */
export const addMember = mutation({
  args: { adminToken: v.string(), conversationId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const c = await group(ctx, args.conversationId);
    const p = await participantByName(ctx, args.name);
    const existing = await ctx.db
      .query("members")
      .withIndex("by_conversation_participant", (q) => q.eq("conversationId", c._id).eq("participantId", p._id))
      .unique();
    if (!existing) {
      await ctx.db.insert("members", { conversationId: c._id, participantId: p._id, readSeq: c.lastSeq, joinedAt: Date.now() });
    }
    return {};
  },
});

/** Removing a member leaves their deliveries as they are; new messages can't address them. */
export const removeMember = mutation({
  args: { adminToken: v.string(), conversationId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const c = await group(ctx, args.conversationId);
    const p = await participantByName(ctx, args.name);
    const existing = await ctx.db
      .query("members")
      .withIndex("by_conversation_participant", (q) => q.eq("conversationId", c._id).eq("participantId", p._id))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return {};
  },
});

/** Lee (or another person) posts from the web view. Only people post here; agents post through their connector. */
export const postAs = mutation({
  args: { adminToken: v.string(), as: v.string(), conversationId: v.string(), to: v.array(v.string()), text: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const sender = await participantByName(ctx, args.as);
    if (sender.kind !== "human") fail("bad_request", "the web view posts as a person");
    if (!args.text.trim()) fail("bad_request", "empty message");
    const conversation = await getOr(ctx, "conversations", args.conversationId);
    const recipients = [];
    for (const name of args.to) recipients.push(await participantByName(ctx, name));
    return post(ctx, { sender, conversation, recipients, kind: "request", text: args.text, origin: { via: "web" } });
  },
});

/** Every conversation, most recent first. */
export const list = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const all = await ctx.db.query("conversations").collect();
    all.sort((a, b) => b.lastAt - a.lastAt);
    return { conversations: await Promise.all(all.map((c) => summary(ctx, c, c.lastSeq))) };
  },
});

/** A conversation's latest messages, each with the state of every delivery it created. */
export const view = query({
  args: { adminToken: v.string(), conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const c = await getOr(ctx, "conversations", args.conversationId);
    const page = await ctx.db
      .query("messages")
      .withIndex("by_conversation_seq", (q) => q.eq("conversationId", c._id))
      .order("desc")
      .take(Math.max(1, Math.min(args.limit ?? 100, 500)));
    page.reverse();
    const messages = [];
    for (const m of page) {
      const deliveries = await ctx.db
        .query("deliveries")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      messages.push({
        message: await envelope(ctx, m),
        deliveries: await Promise.all(
          deliveries.map(async (d) => ({
            ...(await stateRef(ctx, d)),
            at: d.at,
            ...(d.detail !== undefined ? { detail: d.detail } : {}),
          })),
        ),
      });
    }
    return {
      conversation: await summary(ctx, c, c.lastSeq),
      members: await Promise.all(
        (
          await ctx.db
            .query("members")
            .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
            .collect()
        ).map((m) => refById(ctx, m.participantId)),
      ),
      messages,
    };
  },
});
