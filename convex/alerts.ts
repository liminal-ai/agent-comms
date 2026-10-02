// Alerts for the web view (capabilities pass §5): incidents and the thresholds.
// Admin only. The cron that opens and resolves incidents is R4.

import type { Alert } from "@agent-comms/protocol";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, type QueryCtx, query } from "./_generated/server";
import { alertConfig, scan as scanAlerts } from "./lib/alerts";
import { fail, refById, requireAdmin } from "./lib/core";

const MAX_LIST = 200;

async function alertShape(ctx: QueryCtx, a: Doc<"alerts">): Promise<Alert> {
  return {
    id: a._id,
    cause: a.cause,
    subject: {
      kind: a.subjectKind,
      id: a.subjectId,
      ...(a.subjectConversationId ? { conversationId: a.subjectConversationId } : {}),
    },
    owner: await refById(ctx, a.ownerId),
    messageId: a.messageId,
    conversationId: a.conversationId,
    openedAt: a.openedAt,
    ...(a.resolvedAt !== undefined ? { resolvedAt: a.resolvedAt } : {}),
    summary: a.summary,
  };
}


/** Incidents, newest first (at most `limit`, default 100): all, or only those still open. */
export const list = query({
  args: { adminToken: v.string(), openOnly: v.optional(v.boolean()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const limit = Math.max(1, Math.min(args.limit ?? 100, MAX_LIST));
    const rows = args.openOnly
      ? await ctx.db
          .query("alerts")
          .withIndex("by_resolved", (q) => q.eq("resolvedAt", undefined))
          .order("desc")
          .take(limit)
      : await ctx.db.query("alerts").withIndex("by_opened").order("desc").take(limit);
    return { alerts: await Promise.all(rows.map((a) => alertShape(ctx, a))) };
  },
});

export const config = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    return alertConfig(ctx);
  },
});

const MINUTE = 60_000;

/** Change any of the thresholds; the rest keep their values. Returns the whole config. */
export const setConfig = mutation({
  args: {
    adminToken: v.string(),
    connectorSilentMs: v.optional(v.number()),
    reminderBlockedMs: v.optional(v.number()),
    maxClaims: v.optional(v.number()),
  },
  handler: async (ctx, { adminToken, ...change }) => {
    await requireAdmin(adminToken);
    // Fix pass 2: finite whole numbers before the range checks (NaN fails every comparison).
    for (const [key, value] of Object.entries(change)) {
      if (value !== undefined && !Number.isSafeInteger(value)) fail("bad_request", `${key} must be a whole number`);
    }
    if (change.connectorSilentMs !== undefined && (change.connectorSilentMs < 2 * MINUTE || change.connectorSilentMs > 7 * 24 * 60 * MINUTE)) {
      fail("bad_request", "connectorSilentMs is between 2 minutes and 7 days");
    }
    if (change.reminderBlockedMs !== undefined && (change.reminderBlockedMs < MINUTE || change.reminderBlockedMs > 30 * 24 * 60 * MINUTE)) {
      fail("bad_request", "reminderBlockedMs is between 1 minute and 30 days");
    }
    if (change.maxClaims !== undefined && (!Number.isInteger(change.maxClaims) || change.maxClaims < 2 || change.maxClaims > 100)) {
      fail("bad_request", "maxClaims is a whole number from 2 to 100");
    }
    const next = { ...(await alertConfig(ctx)), ...change };
    const row = await ctx.db.query("alertConfig").first();
    if (row) await ctx.db.replace(row._id, next);
    else await ctx.db.insert("alertConfig", next);
    return next;
  },
});

/** The minute cron (crons.ts): open and resolve incidents. */
export const scan = internalMutation({
  args: {},
  handler: async (ctx) => {
    return scanAlerts(ctx, Date.now());
  },
});
