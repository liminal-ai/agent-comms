// The participant directory and machines. Admin only (Lee's web view, setup scripts).

import { NAME_PATTERN } from "@agent-comms/protocol";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { fail, participantByName, ref, requireAdmin, sha256Hex } from "./lib/core";
import { home, participantKind } from "./validators";

/** Create or rotate a machine's connector credential. Only the hash is stored. */
export const registerMachine = mutation({
  args: { adminToken: v.string(), machineId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    if (args.secret.length < 16) fail("bad_request", "the connector secret must be at least 16 characters");
    const secretHash = await sha256Hex(args.secret);
    const existing = await ctx.db
      .query("machines")
      .withIndex("by_machineId", (q) => q.eq("machineId", args.machineId))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { secretHash });
    else await ctx.db.insert("machines", { machineId: args.machineId, secretHash, createdAt: Date.now() });
    return { machineId: args.machineId };
  },
});

/** Register a person or promote an agent where it already lives. Agents need a home. */
export const promote = mutation({
  args: {
    adminToken: v.string(),
    name: v.string(),
    kind: participantKind,
    home: v.optional(home),
    owner: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    if (!NAME_PATTERN.test(args.name)) fail("bad_request", `@${args.name} isn't a valid name (lowercase [a-z0-9_-], 1-48)`);
    if (args.kind === "agent" && !args.home) fail("bad_request", "an agent needs a home");
    const taken = await ctx.db
      .query("participants")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (taken) fail("conflict", `@${args.name} already exists`);
    const now = Date.now();
    const id = await ctx.db.insert("participants", {
      name: args.name,
      kind: args.kind,
      state: "active",
      ...(args.home ? { home: args.home } : {}),
      ...(args.owner ? { owner: args.owner } : {}),
      presence: { status: "offline", at: now },
      createdAt: now,
    });
    return { participant: ref((await ctx.db.get(id))!) };
  },
});

/** Move an agent: delivery follows the new home; its context stays where it was. */
export const rebind = mutation({
  args: { adminToken: v.string(), name: v.string(), home },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const p = await participantByName(ctx, args.name);
    if (p.kind !== "agent") fail("bad_request", `@${p.name} is a person; people have no home`);
    await ctx.db.patch(p._id, { home: args.home, presence: { status: "offline", at: Date.now() } });
    return { participant: ref(p) };
  },
});

/**
 * Pause, resume or retire. Paused: deliveries are created and wait as pending.
 * Retired: no new deliveries, and pending ones fail. In-flight ones (claimed or
 * delivered) finish on the machine they were handed to, and a request's
 * answer is still collected (fix pass 2.4).
 */
export const setState = mutation({
  args: { adminToken: v.string(), name: v.string(), state: v.union(v.literal("active"), v.literal("paused"), v.literal("retired")) },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const p = await participantByName(ctx, args.name);
    if (p.state === "retired" && args.state !== "retired") fail("conflict", `@${p.name} is retired`);
    await ctx.db.patch(p._id, { state: args.state });
    if (args.state === "retired") {
      const pending = await ctx.db
        .query("deliveries")
        .withIndex("by_recipient_state", (q) => q.eq("recipientId", p._id).eq("state", "pending"))
        .collect();
      for (const d of pending) await ctx.db.patch(d._id, { state: "failed", at: Date.now(), detail: "recipient retired" });
    }
    return { participant: ref(p), state: args.state };
  },
});

/** The directory with presence, for the web view. */
export const list = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const rows = await ctx.db.query("participants").collect();
    const machines = await ctx.db.query("machines").collect();
    return {
      participants: rows.map((p) => ({
        ...ref(p),
        state: p.state,
        ...(p.home ? { home: p.home } : {}),
        presence: p.presence,
      })),
      machines: machines.map((m) => ({ machineId: m.machineId, lastSeenAt: m.lastSeenAt ?? null })),
    };
  },
});
