// Reminders for the web view (capabilities pass §4). Admin only; the web view
// acts as a person (`as`), who becomes the reminder's creator. The CLI's
// `remind`, `reminders`, `reminder` and `reminder-update` reach the same logic
// through the connector.

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { fail, getOr, participantByName, requireAdmin } from "./lib/core";
import { applyAction, createReminder, reminderDetail, reminderShape, tick as fireDue } from "./lib/reminders";
import { reminderAction, reminderState } from "./validators";

/** Every reminder, or those in one state, newest first. */
export const list = query({
  args: { adminToken: v.string(), state: v.optional(reminderState) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const rows = args.state
      ? await ctx.db
          .query("reminders")
          .withIndex("by_state_next", (q) => q.eq("state", args.state!))
          .collect()
      : await ctx.db.query("reminders").collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return { reminders: await Promise.all(rows.map((r) => reminderShape(ctx, r))) };
  },
});

/** One reminder with its fires and skips. */
export const get = query({
  args: { adminToken: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    return reminderDetail(ctx, await getOr(ctx, "reminders", args.id));
  },
});

export const create = mutation({
  args: {
    adminToken: v.string(),
    /** The person creating it. */
    as: v.string(),
    target: v.string(),
    text: v.string(),
    everyMs: v.optional(v.number()),
    at: v.optional(v.number()),
    name: v.optional(v.string()),
    idleForMs: v.optional(v.number()),
    watch: v.optional(v.string()),
    max: v.optional(v.number()),
    reportTo: v.optional(v.string()),
    expiresMs: v.optional(v.number()),
  },
  handler: async (ctx, { adminToken, as, ...input }) => {
    await requireAdmin(adminToken);
    const creator = await participantByName(ctx, as);
    if (creator.kind !== "human") fail("bad_request", `the web view creates reminders as a person, not @${as}`);
    return { reminder: await reminderShape(ctx, await createReminder(ctx, creator, input, Date.now())) };
  },
});

/** pause | resume | done | cancel | blocked (with `reason`). */
export const update = mutation({
  args: { adminToken: v.string(), id: v.string(), action: reminderAction, reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const r = await getOr(ctx, "reminders", args.id);
    return { reminder: await reminderShape(ctx, await applyAction(ctx, r, args.action, args.reason, Date.now())) };
  },
});

/** The minute cron (crons.ts): expiries, then due reminders. */
export const tick = internalMutation({
  args: {},
  handler: async (ctx) => fireDue(ctx, Date.now()),
});
