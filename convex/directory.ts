// The participant directory and machines. Admin only (Lee's web view, setup scripts).

import { NAME_PATTERN, RESERVED_NAMES, SYSTEM_PARTICIPANTS } from "@agent-comms/protocol";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { fail, participantByName, ref, requireAdmin, sha256Hex } from "./lib/core";
import { profilePatch } from "./lib/registry";
import { endResult } from "./lib/waits";
import { home, promotableKind } from "./validators";

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

/**
 * Register a person or promote an agent where it already lives. Agents need a
 * home and an owner (a person: `@owner` resolves to them, and alerts go to them).
 * Reserved names (`owner`, `all`, and the system participants') are refused.
 */
export const promote = mutation({
  args: {
    adminToken: v.string(),
    name: v.string(),
    kind: promotableKind,
    home: v.optional(home),
    /** The owning person's name. Required for agents; people have none. */
    owner: v.optional(v.string()),
    description: v.optional(v.string()),
    duties: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    if (!NAME_PATTERN.test(args.name)) fail("bad_request", `@${args.name} isn't a valid name (lowercase [a-z0-9_-], 1-48)`);
    if (RESERVED_NAMES.includes(args.name)) fail("bad_request", `@${args.name} is a reserved name`);
    if (args.kind === "agent" && !args.home) fail("bad_request", "an agent needs a home");
    if (args.kind === "agent" && !args.owner) fail("bad_request", "an agent needs an owner (a person's name)");
    if (args.kind === "human" && args.owner) fail("bad_request", "people have no owner");
    const owner = args.owner ? await participantByName(ctx, args.owner) : undefined;
    if (owner && owner.kind !== "human") fail("bad_request", `@${owner.name} isn't a person; an agent's owner is a person`);
    const profile = profilePatch(args);
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
      ...(owner ? { ownerId: owner._id } : {}),
      ...(profile.description ? { description: profile.description } : {}),
      ...(profile.duties ? { duties: profile.duties } : {}),
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
      for (const d of pending) {
        await ctx.db.patch(d._id, { state: "failed", at: Date.now(), detail: "recipient retired" });
        await endResult(ctx, d._id, Date.now());
      }
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

/**
 * Brings an existing deployment up to the capabilities pass; idempotent, run
 * after each deploy (`scripts/upgrade.ts`). Creates the system participants
 * (`reminders`, `alerts`) and gives every agent without an owner `defaultOwner`.
 * (The owner migration's step 2 also moved old `owner` strings to `ownerId`;
 * step 3 dropped the field, on lim-builder after upgrading on 2026-10-01.)
 */
export const upgrade = mutation({
  args: { adminToken: v.string(), defaultOwner: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(args.adminToken);
    const fallback = await participantByName(ctx, args.defaultOwner);
    if (fallback.kind !== "human") fail("bad_request", `@${fallback.name} isn't a person`);
    const now = Date.now();
    const systemCreated: string[] = [];
    for (const name of SYSTEM_PARTICIPANTS) {
      const existing = await ctx.db
        .query("participants")
        .withIndex("by_name", (q) => q.eq("name", name))
        .unique();
      if (existing && existing.kind !== "system") fail("conflict", `@${name} is taken by a ${existing.kind}; rename it before upgrading`);
      if (existing) continue;
      await ctx.db.insert("participants", { name, kind: "system", state: "active", presence: { status: "offline", at: now }, createdAt: now });
      systemCreated.push(name);
    }
    let ownersSet = 0;
    for (const p of await ctx.db.query("participants").collect()) {
      if (p.kind !== "agent" || p.ownerId) continue;
      await ctx.db.patch(p._id, { ownerId: fallback._id });
      ownersSet++;
    }
    return { systemCreated, ownersSet };
  },
});
