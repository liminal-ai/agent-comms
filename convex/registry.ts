// The agent registry for the web view (capabilities pass §1). Admin only. The
// CLI's `agents` and `agents-set` reach the same logic through the connector.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { participantByName, requireAdmin } from "./lib/core";
import { machineSeen, profilePatch, registryEntry } from "./lib/registry";

/** Every participant (any state, any kind) as a registry entry, with homes. */
export const list = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const rows = await ctx.db.query("participants").collect();
    const seen = await machineSeen(ctx);
    const now = Date.now();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return { agents: await Promise.all(rows.map((p) => registryEntry(ctx, p, seen, now, { long: true }))) };
  },
});

/** Set a participant's description and duties. An empty description or duty list clears it. */
export const setProfile = mutation({
  args: { adminToken: v.string(), name: v.string(), description: v.optional(v.string()), duties: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const p = await participantByName(ctx, args.name);
    await ctx.db.patch(p._id, profilePatch(args));
    const updated = (await ctx.db.get(p._id))!;
    return { agent: await registryEntry(ctx, updated, await machineSeen(ctx), Date.now(), { long: true }) };
  },
});
