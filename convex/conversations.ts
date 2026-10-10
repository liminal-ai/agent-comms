import { MAX_TITLE_CHARS } from "@agent-comms/protocol";
// Conversations, membership, deleting groups and Lee's posts. Admin only (the web view).

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
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

const MAX_DELETE_BATCH = 100;
/**
 * How much one purge pass may touch, in reads and writes (each query or delete counts one),
 * and in bytes of message text, well under Convex's 4,096 index ranges and 16 MiB per
 * transaction. A larger group is finished by the minute cron.
 */
const PURGE_OPS = 2_000;
const PURGE_BYTES = 6 * 1024 * 1024;
const encoder = new TextEncoder();

/**
 * Delete groups as a person, all or nothing: they're gone to every caller at once (list, view,
 * sends, replies, inbox). Their members, messages, deliveries, inbox rows, and the waits and
 * reminder fires on their messages are purged newest first, so undelivered work goes in the
 * first pass; whatever doesn't fit one transaction is purged by the minute cron.
 */
export const deleteConversation = mutation({
  args: { adminToken: v.string(), as: v.string(), conversationIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const person = await participantByName(ctx, args.as);
    if (person.kind !== "human") fail("bad_request", "only a person deletes conversations");
    if (args.conversationIds.length > MAX_DELETE_BATCH)
      fail("bad_request", `${args.conversationIds.length} conversations; the limit is ${MAX_DELETE_BATCH} per call`);
    const groups = new Map<Id<"conversations">, Doc<"conversations">>();
    for (const id of args.conversationIds) {
      const c = await getOr(ctx, "conversations", id);
      if (c.kind !== "group") fail("bad_request", "DMs can't be deleted");
      groups.set(c._id, c);
    }
    const now = Date.now();
    for (const id of groups.keys()) await ctx.db.patch(id, { deletingAt: now });
    // Every delivery still in play goes now, whatever its age, so nothing claims, hands off
    // or wakes into a deleted group (sends and replies into it are refused in `post`).
    for (const state of LIVE_STATES)
      for (const d of await ctx.db.query("deliveries").withIndex("by_state_at", (q) => q.eq("state", state)).collect())
        if (groups.has(d.conversationId)) await removeDelivery(ctx, d._id);
    await purgePass(ctx, [...groups.keys()]);
    return { deleted: groups.size };
  },
});

/** Delivery states an agent, connector or relay can still act on. */
const LIVE_STATES = ["pending", "claimed", "delivered", "ambiguous", "uncertain"] as const;

async function removeDelivery(ctx: MutationCtx, id: Id<"deliveries">): Promise<void> {
  for (const r of await ctx.db.query("waitResults").withIndex("by_delivery", (q) => q.eq("deliveryId", id)).collect())
    await ctx.db.delete(r._id);
  await ctx.db.delete(id);
}

/** The minute cron: one bounded pass over groups whose delete didn't fit its own transaction. */
export const purge = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("conversations")
      .withIndex("by_deletingAt", (q) => q.gt("deletingAt", 0))
      .take(MAX_DELETE_BATCH);
    if (pending.length) await purgePass(ctx, pending.map((c) => c._id));
  },
});

/** Purge what fits one transaction; returns the groups not yet fully gone. */
async function purgePass(ctx: MutationCtx, ids: Id<"conversations">[]): Promise<Id<"conversations">[]> {
  let ops = 0;
  let bytes = 0;
  const full = () => ops >= PURGE_OPS || bytes >= PURGE_BYTES;
  const take = async <T>(q: { take(n: number): Promise<T[]> }) => {
    ops++;
    return q.take(Math.max(1, Math.min(100, PURGE_OPS - ops)));
  };
  const remove = async (id: Id<"messages" | "deliveries" | "waits" | "waitResults" | "reminderFires" | "inbox" | "members" | "conversations">) => {
    ops++;
    await ctx.db.delete(id);
  };
  const humans = (await ctx.db.query("participants").collect()).filter((p) => p.kind === "human");
  ops++;
  const left: Id<"conversations">[] = [];
  for (const id of ids) {
    if (full()) {
      left.push(id);
      continue;
    }
    let done = false;
    while (!full()) {
      const messages = await take(ctx.db.query("messages").withIndex("by_conversation_seq", (q) => q.eq("conversationId", id)).order("desc"));
      if (!messages.length) {
        done = true;
        break;
      }
      for (const m of messages) {
        if (full()) break;
        bytes += encoder.encode(m.text).length + 1_024;
        // A delivery or wait goes only once none of its wait results are left (the fallback sweep reads them).
        for (const d of await take(ctx.db.query("deliveries").withIndex("by_message", (q) => q.eq("messageId", m._id)))) {
          for (const r of await take(ctx.db.query("waitResults").withIndex("by_delivery", (q) => q.eq("deliveryId", d._id)))) await remove(r._id);
          if (!(await take(ctx.db.query("waitResults").withIndex("by_delivery", (q) => q.eq("deliveryId", d._id)))).length) await remove(d._id);
        }
        for (const w of await take(ctx.db.query("waits").withIndex("by_message", (q) => q.eq("messageId", m._id)))) {
          for (const r of await take(ctx.db.query("waitResults").withIndex("by_wait", (q) => q.eq("waitId", w._id)))) await remove(r._id);
          if (!(await take(ctx.db.query("waitResults").withIndex("by_wait", (q) => q.eq("waitId", w._id)))).length) await remove(w._id);
        }
        for (const f of await take(ctx.db.query("reminderFires").withIndex("by_message", (q) => q.eq("messageId", m._id)))) await remove(f._id);
        for (const h of humans)
          for (const i of await take(ctx.db.query("inbox").withIndex("by_human_message", (q) => q.eq("humanId", h._id).eq("messageId", m._id))))
            await remove(i._id);
        // Only once nothing points at it (a long reply chain may leave some for the next pass).
        const rest = await take(ctx.db.query("deliveries").withIndex("by_message", (q) => q.eq("messageId", m._id)));
        const waiting = await take(ctx.db.query("waits").withIndex("by_message", (q) => q.eq("messageId", m._id)));
        if (!rest.length && !waiting.length) await remove(m._id);
      }
    }
    if (done) {
      const members = await take(ctx.db.query("members").withIndex("by_conversation", (q) => q.eq("conversationId", id)));
      for (const m of members) await remove(m._id);
      if (members.length && full()) done = false;
      else if (!(await take(ctx.db.query("members").withIndex("by_conversation", (q) => q.eq("conversationId", id)))).length) await remove(id);
      else done = false;
    }
    if (!done) left.push(id);
  }
  return left;
}

/** Every conversation, most recent first. */
export const list = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const all = (await ctx.db.query("conversations").collect()).filter((c) => c.deletingAt === undefined);
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
