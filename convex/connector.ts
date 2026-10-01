// What a machine's connector calls. Every function takes the machine's
// credential; `as` names are accepted only for participants homed there.
//
// Claims: a connector claims a delivery with a lease, renews it while working,
// and renews once more immediately before handing the message to the harness:
// `renew` is the compare-and-set on the claim id. A lease that expired is taken
// over only through `claim`, which says `takeover: true` so the new holder
// checks the harness before running anything.

import { clipAnswer, DEFAULT_READ_LIMIT, OWNER_ALIAS, type Responses } from "@agent-comms/protocol";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query, type QueryCtx } from "./_generated/server";
import {
  actingAs,
  advanceRead,
  envelope,
  fail,
  fullDelivery,
  getOr,
  membership,
  participantByName,
  ref,
  requireMachine,
  stateRef,
  summary,
} from "./lib/core";
import { machineSeen, nextPresence, profilePatch, registryEntry } from "./lib/registry";
import { openDm, post, replayed } from "./lib/post";
import { attachment, enteredInput, failureReason, machineAuth, via } from "./validators";

export const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Presence and directory

export const heartbeat = mutation({
  args: { machine: machineAuth },
  handler: async (ctx, args) => {
    const machine = await requireMachine(ctx, args.machine);
    await ctx.db.patch(machine._id, { lastSeenAt: Date.now() });
    return {};
  },
});

export const presence = mutation({
  args: { machine: machineAuth, participant: v.string(), status: v.union(v.literal("idle"), v.literal("busy"), v.literal("offline")) },
  handler: async (ctx, args) => {
    const machine = await requireMachine(ctx, args.machine);
    const p = await actingAs(ctx, machine, args.participant);
    await ctx.db.patch(p._id, { presence: nextPresence(p.presence, args.status, Date.now()) });
    return {};
  },
});

/** Who is homed on this machine, for the loopback `status` operation. */
export const homed = query({
  args: { machine: machineAuth },
  handler: async (ctx, args): Promise<Pick<Responses["status"], "participants">> => {
    const machine = await requireMachine(ctx, args.machine);
    const here = await homedOn(ctx, machine);
    return { participants: here.map((p) => ({ participant: ref(p), home: p.home!, state: p.state })) };
  },
});

async function homedOn(ctx: QueryCtx, machine: Doc<"machines">) {
  return ctx.db
    .query("participants")
    .withIndex("by_machine", (q) => q.eq("home.machine", machine.machineId))
    .collect();
}

// ---------------------------------------------------------------------------
// Deliveries

/**
 * The connector's subscription: deliveries for participants homed here that
 * need action. Pending ones only for active recipients (paused ones wait);
 * claimed ones (ours or expired); delivered requests whose answer hasn't been
 * collected. Oldest first.
 */
export const work = query({
  args: { machine: machineAuth },
  handler: async (ctx, args) => {
    const machine = await requireMachine(ctx, args.machine);
    const here = machine.machineId;
    type Row = Doc<"deliveries">;
    const seen = new Set<string>();
    const items: {
      id: string;
      recipient: string;
      harness: Doc<"participants">["home"] extends infer H ? (H extends { harness: infer K } ? K : never) : never;
      locator: string;
      state: Row["state"];
      collect: boolean;
      claim?: NonNullable<Row["claim"]>;
      turnId?: string;
      cursor?: string;
      createdAt: number;
    }[] = [];
    const push = (d: Row, p: Doc<"participants">) => {
      if (seen.has(d._id)) return;
      seen.add(d._id);
      // In-flight work goes to the home it was handed to (2.5); new work to the current home.
      const home = d.target ?? p.home!;
      items.push({
        id: d._id,
        recipient: p.name,
        harness: home.harness,
        locator: home.locator,
        state: d.state,
        collect: d.collect,
        ...(d.claim ? { claim: d.claim } : {}),
        ...(d.turnId !== undefined ? { turnId: d.turnId } : {}),
        ...(d.cursor !== undefined ? { cursor: d.cursor } : {}),
        createdAt: d.createdAt,
      });
    };
    const ours = (d: Row) => (d.target ? d.target.machine === here : true);

    for (const p of await homedOn(ctx, machine)) {
      if (p.state === "retired") continue;
      if (p.state === "active") {
        for (const d of await ctx.db
          .query("deliveries")
          .withIndex("by_recipient_state", (q) => q.eq("recipientId", p._id).eq("state", "pending"))
          .collect()) push(d, p);
      }
      for (const d of await ctx.db
        .query("deliveries")
        .withIndex("by_recipient_state", (q) => q.eq("recipientId", p._id).eq("state", "claimed"))
        .collect()) if (ours(d)) push(d, p);
      for (const d of await ctx.db
        .query("deliveries")
        .withIndex("by_recipient_state_collect", (q) => q.eq("recipientId", p._id).eq("state", "delivered").eq("collect", true))
        .collect()) if (ours(d)) push(d, p);
    }
    // In-flight work handed to this machine for participants since moved elsewhere (2.5).
    const moved = [
      ...(await ctx.db.query("deliveries").withIndex("by_target_state_collect", (q) => q.eq("target.machine", here).eq("state", "claimed")).collect()),
      ...(await ctx.db
        .query("deliveries")
        .withIndex("by_target_state_collect", (q) => q.eq("target.machine", here).eq("state", "delivered").eq("collect", true))
        .collect()),
    ];
    for (const d of moved) {
      if (seen.has(d._id)) continue;
      const p = await ctx.db.get(d.recipientId);
      if (p) push(d, p);
    }
    items.sort((a, b) => a.createdAt - b.createdAt);
    return { deliveries: items };
  },
});

/** A delivery this machine may act on: handed to a home here, or (not yet handed over) for a participant homed here. */
async function deliveryForMachine(ctx: QueryCtx, machine: Doc<"machines">, deliveryId: string) {
  const d = await getOr(ctx, "deliveries", deliveryId);
  const recipient = (await ctx.db.get(d.recipientId))!;
  const owner = d.target?.machine ?? recipient.home?.machine;
  if (owner !== machine.machineId) {
    fail("not_homed_here", `delivery ${d._id} is for @${recipient.name}, handled by ${owner ?? "no machine"}, not ${machine.machineId}`);
  }
  return { d, recipient };
}

function leaseMs(requested: number | undefined): number {
  return Math.max(1_000, Math.min(requested ?? DEFAULT_LEASE_MS, MAX_LEASE_MS));
}

/**
 * Claim a delivery. `pending` → `claimed`. A `claimed` or undelivered-answer
 * `delivered` one whose lease has expired is taken over (`takeover: true`):
 * the new holder must ask the harness before running it. Returns the full
 * delivery (message, bounded history) for rendering.
 */
export const claim = mutation({
  args: { machine: machineAuth, deliveryId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const machine = await requireMachine(ctx, args.machine);
    const { d, recipient } = await deliveryForMachine(ctx, machine, args.deliveryId);
    const now = Date.now();
    const claim = { machine: machine.machineId, claimId: crypto.randomUUID(), leaseExpiresAt: now + leaseMs(args.leaseMs) };
    let takeover = false;
    if (d.state === "pending") {
      if (recipient.state !== "active") fail("conflict", `@${recipient.name} is ${recipient.state}`);
      await ctx.db.patch(d._id, { state: "claimed", at: now, claim });
    } else if (d.state === "claimed" || (d.state === "delivered" && d.collect)) {
      if (d.claim && d.claim.leaseExpiresAt > now) {
        fail("conflict", `delivery ${d._id} is claimed by ${d.claim.machine} until ${new Date(d.claim.leaseExpiresAt).toISOString()}`);
      }
      takeover = true;
      await ctx.db.patch(d._id, { claim });
    } else {
      fail("conflict", `delivery ${d._id} is ${d.state}`);
    }
    return { claim, takeover, delivery: await fullDelivery(ctx, (await ctx.db.get(d._id))!) };
  },
});

function holdsClaim(d: Doc<"deliveries">, machine: Doc<"machines">, claimId: string): void {
  if (!d.claim || d.claim.claimId !== claimId || d.claim.machine !== machine.machineId) {
    fail("conflict", `claim ${claimId} on delivery ${d._id} is no longer held`);
  }
}

/** Extend the lease. Also the compare-and-set right before handing the message to the harness. */
export const renew = mutation({
  args: { machine: machineAuth, deliveryId: v.string(), claimId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const machine = await requireMachine(ctx, args.machine);
    const { d } = await deliveryForMachine(ctx, machine, args.deliveryId);
    holdsClaim(d, machine, args.claimId);
    const claim = { ...d.claim!, leaseExpiresAt: Date.now() + leaseMs(args.leaseMs) };
    await ctx.db.patch(d._id, { claim });
    return { claim, state: d.state };
  },
});

/**
 * Right before the handoff: confirm the claim is still ours (compare-and-set)
 * and record where the delivery is going (its home now) and the adapter's
 * resume point, so a crash or a rebind after this point is recovered against
 * that home (2.2, 2.5). A delivery already prepared keeps its recorded home.
 */
export const prepare = mutation({
  args: { machine: machineAuth, deliveryId: v.string(), claimId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const machine = await requireMachine(ctx, args.machine);
    const { d, recipient } = await deliveryForMachine(ctx, machine, args.deliveryId);
    if (d.state !== "claimed") fail("conflict", `delivery ${d._id} is ${d.state}`);
    holdsClaim(d, machine, args.claimId);
    if (!recipient.home) fail("conflict", `@${recipient.name} has no home`);
    await ctx.db.patch(d._id, {
      target: d.target ?? recipient.home,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    });
    return { target: d.target ?? recipient.home };
  },
});

/**
 * The harness accepted our message, in turn `turnId`. Idempotent for the same
 * turn. An answer's delivery is finished here: its claim is released and
 * nothing is ever collected from it.
 */
export const delivered = mutation({
  args: { machine: machineAuth, deliveryId: v.string(), claimId: v.string(), turnId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const machine = await requireMachine(ctx, args.machine);
    const { d } = await deliveryForMachine(ctx, machine, args.deliveryId);
    if (d.state !== "claimed") {
      if (d.turnId === args.turnId && d.state !== "pending") return { delivery: await stateRef(ctx, d) };
      fail("conflict", `delivery ${d._id} is ${d.state}${d.turnId ? ` in turn ${d.turnId}` : ""}`);
    }
    holdsClaim(d, machine, args.claimId);
    const message = (await ctx.db.get(d.messageId))!;
    await ctx.db.patch(d._id, {
      state: "delivered",
      at: Date.now(),
      turnId: args.turnId,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(d.collect ? {} : { claim: undefined }),
    });
    await advanceRead(ctx, d.conversationId, d.recipientId, message.seq);
    return { delivery: await stateRef(ctx, (await ctx.db.get(d._id))!) };
  },
});

/**
 * Collect our turn's answer: at most one per delivery. A repeat returns the
 * first answer with `duplicate: true`. Refused for an answer's delivery: an
 * answer wakes the requester, and nothing it does next is collected.
 */
export const collect = mutation({
  args: { machine: machineAuth, deliveryId: v.string(), claimId: v.string(), turnId: v.string(), answer: v.string() },
  handler: async (ctx, args): Promise<Responses["outcome"]> => {
    const machine = await requireMachine(ctx, args.machine);
    const { d, recipient } = await deliveryForMachine(ctx, machine, args.deliveryId);
    if (!d.collect) fail("conflict", `delivery ${d._id} carries an answer; answers are never collected`);
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_collectedFrom", (q) => q.eq("collectedFrom", d._id))
      .first();
    if (existing) return { delivery: await stateRef(ctx, d), answerMessageId: existing._id, duplicate: true };
    const turnId = await openTurn(d, machine, args.claimId, args.turnId);

    const request = (await ctx.db.get(d.messageId))!;
    const conversation = (await ctx.db.get(d.conversationId))!;
    const requester = (await ctx.db.get(request.senderId))!;
    // A system requester (a reminder fire) is never addressed; its fire records the answer (R3).
    const addressable = requester.kind !== "system" && (await isMember(ctx, conversation._id, requester));
    const result = await post(ctx, {
      sender: recipient,
      conversation,
      recipients: addressable ? [requester] : [],
      kind: "answer",
      inReplyTo: request._id,
      collectedFrom: d._id,
      // The request was accepted while the agent was active and a member: its answer still lands (2.4).
      inFlight: true,
      text: clipAnswer(args.answer),
      origin: { via: (d.target ?? recipient.home)?.harness === "t3" ? "t3" : "claude-code" },
    });
    await ctx.db.patch(d._id, {
      state: "replied",
      at: Date.now(),
      turnId,
      answerMessageId: result.message.id as Id<"messages">,
      claim: undefined,
    });
    return { delivery: await stateRef(ctx, (await ctx.db.get(d._id))!), answerMessageId: result.message.id, duplicate: false };
  },
});

/** Checks for finishing a claimed or delivered delivery: the claim is ours, and the turn matches if one is known. */
async function openTurn(d: Doc<"deliveries">, machine: Doc<"machines">, claimId: string, turnId: string) {
  if (d.state !== "claimed" && d.state !== "delivered") fail("conflict", `delivery ${d._id} is already ${d.state}`);
  holdsClaim(d, machine, claimId);
  if (d.turnId !== undefined && d.turnId !== turnId) {
    fail("conflict", `delivery ${d._id} went into turn ${d.turnId}, not ${turnId}`);
  }
  return turnId;
}

async function isMember(ctx: QueryCtx, conversationId: Id<"conversations">, p: Doc<"participants">) {
  return (
    (await ctx.db
      .query("members")
      .withIndex("by_conversation_participant", (q) => q.eq("conversationId", conversationId).eq("participantId", p._id))
      .unique()) !== null
  );
}

async function finish(
  ctx: MutationCtx,
  args: { machine: { id: string; secret: string }; deliveryId: string; claimId: string; turnId?: string },
  state: "ambiguous" | "failed" | "uncertain",
  detail: string,
) {
  const machine = await requireMachine(ctx, args.machine);
  const { d } = await deliveryForMachine(ctx, machine, args.deliveryId);
  if (d.state === state && (args.turnId === undefined || d.turnId === args.turnId)) {
    return { delivery: await stateRef(ctx, d) };
  }
  if (state === "ambiguous" && !d.collect) fail("conflict", `delivery ${d._id} carries an answer; it can't be ambiguous`);
  if (d.state !== "claimed" && d.state !== "delivered") fail("conflict", `delivery ${d._id} is already ${d.state}`);
  holdsClaim(d, machine, args.claimId);
  const turnId = args.turnId;
  if (turnId !== undefined && d.turnId !== undefined && d.turnId !== turnId) {
    fail("conflict", `delivery ${d._id} went into turn ${d.turnId}, not ${turnId}`);
  }
  await ctx.db.patch(d._id, {
    state,
    at: Date.now(),
    detail,
    claim: undefined,
    ...(turnId !== undefined ? { turnId } : {}),
  });
  return { delivery: await stateRef(ctx, (await ctx.db.get(d._id))!) };
}

/** Something else entered our turn; the reply can't be matched. Records only the kinds of input, never their text. */
export const ambiguous = mutation({
  args: { machine: machineAuth, deliveryId: v.string(), claimId: v.string(), turnId: v.string(), entered: v.array(enteredInput) },
  handler: async (ctx, args) => {
    const what = args.entered.map((e) => e.origin).join(", ") || "other input";
    const result = await finish(ctx, args, "ambiguous", `other input entered the turn: ${what}`);
    // The agent may already have answered explicitly during the turn: then the request has its
    // answer and the delivery is complete (found in the fix pass 1 shared-checks rerun).
    const d = (await ctx.db.get(result.delivery.id as Id<"deliveries">))!;
    const earlier = await ctx.db
      .query("messages")
      .withIndex("by_inReplyTo", (q) => q.eq("inReplyTo", d.messageId))
      .filter((q) => q.and(q.eq(q.field("senderId"), d.recipientId), q.eq(q.field("collectedFrom"), undefined)))
      .first();
    if (d.state === "ambiguous" && earlier) {
      await ctx.db.patch(d._id, { state: "replied", at: Date.now(), detail: `${d.detail}; completed by comms reply ${earlier._id}, sent during the turn` });
      return { delivery: await stateRef(ctx, (await ctx.db.get(d._id))!) };
    }
    return result;
  },
});

export const failed = mutation({
  args: {
    machine: machineAuth,
    deliveryId: v.string(),
    claimId: v.string(),
    turnId: v.optional(v.string()),
    reason: failureReason,
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args) => finish(ctx, args, "failed", args.detail ? `${args.reason}: ${args.detail}` : args.reason),
});

/** After a restart or takeover the harness couldn't say whether it ran. Never re-run; Lee sees it. */
export const uncertain = mutation({
  args: { machine: machineAuth, deliveryId: v.string(), claimId: v.string(), detail: v.string() },
  handler: async (ctx, args) => finish(ctx, args, "uncertain", args.detail),
});

// ---------------------------------------------------------------------------
// The CLI's operations, passed through by the connector

export const send = mutation({
  args: {
    machine: machineAuth,
    as: v.string(),
    to: v.array(v.string()),
    conversationId: v.optional(v.string()),
    text: v.string(),
    attachments: v.optional(v.array(attachment)),
    via: v.optional(via),
    key: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Responses["send"]> => {
    const machine = await requireMachine(ctx, args.machine);
    const sender = await actingAs(ctx, machine, args.as);
    const earlier = await replayed(ctx, sender, args.key);
    if (earlier) return earlier;
    const recipients = [];
    for (const name of args.to) {
      if (name === OWNER_ALIAS) {
        // `@owner`: the sending agent's owner.
        if (!sender.ownerId) fail("bad_request", `@${sender.name} has no owner to address as @owner`);
        recipients.push((await ctx.db.get(sender.ownerId))!);
        continue;
      }
      const normalized = await ctx.db
        .query("participants")
        .withIndex("by_name", (q) => q.eq("name", name))
        .unique();
      if (!normalized) fail("unknown_participant", `no participant named @${name}`);
      recipients.push(normalized);
    }
    let conversation: Doc<"conversations">;
    if (args.conversationId !== undefined) {
      conversation = await getOr(ctx, "conversations", args.conversationId);
    } else {
      const [other, ...rest] = recipients;
      if (!other || rest.length > 0) fail("bad_request", "without a conversation id, address exactly one participant (a DM)");
      conversation = await openDm(ctx, sender, other);
    }
    return post(ctx, {
      sender,
      conversation,
      recipients,
      kind: "request",
      text: args.text,
      ...(args.attachments ? { attachments: args.attachments } : {}),
      ...(args.key !== undefined ? { idempotencyKey: args.key } : {}),
      origin: { via: args.via ?? "cli" },
    });
  },
});

/**
 * An explicit answer (`comms reply`): always allowed, never collected. Completes
 * the replier's `ambiguous` or `uncertain` delivery of that message.
 */
export const reply = mutation({
  args: {
    machine: machineAuth,
    as: v.string(),
    messageId: v.string(),
    text: v.string(),
    attachments: v.optional(v.array(attachment)),
    via: v.optional(via),
    key: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Responses["reply"]> => {
    const machine = await requireMachine(ctx, args.machine);
    const me = await actingAs(ctx, machine, args.as);
    const earlier = await replayed(ctx, me, args.key);
    if (earlier) return earlier;
    const original = await getOr(ctx, "messages", args.messageId);
    const conversation = (await ctx.db.get(original.conversationId))!;
    await membership(ctx, conversation._id, me);
    const originalSender = (await ctx.db.get(original.senderId))!;
    const addressable =
      originalSender._id !== me._id && originalSender.kind !== "system" && (await isMember(ctx, conversation._id, originalSender));
    const result: Responses["reply"] = await post(ctx, {
      sender: me,
      conversation,
      recipients: addressable ? [originalSender] : [],
      kind: "answer",
      inReplyTo: original._id,
      text: args.text,
      ...(args.attachments ? { attachments: args.attachments } : {}),
      ...(args.key !== undefined ? { idempotencyKey: args.key } : {}),
      origin: { via: args.via ?? "cli" },
    });
    for (const state of ["ambiguous", "uncertain"] as const) {
      const open = await ctx.db
        .query("deliveries")
        .withIndex("by_recipient_state", (q) => q.eq("recipientId", me._id).eq("state", state))
        .filter((q) => q.eq(q.field("messageId"), original._id))
        .first();
      if (open) {
        await ctx.db.patch(open._id, { state: "replied", at: Date.now(), detail: `completed by comms reply ${result.message.id}` });
        result.completed = open._id;
        break;
      }
    }
    return result;
  },
});

/** A page of a conversation, oldest first. Reading the newest page moves the reader's read position. */
export const read = mutation({
  args: {
    machine: machineAuth,
    as: v.string(),
    conversationId: v.string(),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Responses["read"]> => {
    const machine = await requireMachine(ctx, args.machine);
    const me = await actingAs(ctx, machine, args.as);
    const conversation = await getOr(ctx, "conversations", args.conversationId);
    const member = await membership(ctx, conversation._id, me);
    const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_READ_LIMIT, 100));
    const page = await ctx.db
      .query("messages")
      .withIndex("by_conversation_seq", (q) =>
        args.before !== undefined ? q.eq("conversationId", conversation._id).lt("seq", args.before) : q.eq("conversationId", conversation._id),
      )
      .order("desc")
      .take(limit + 1);
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse();
    let readSeq = member.readSeq;
    const newest = messages.at(-1);
    if (args.before === undefined && newest && newest.seq > readSeq) {
      readSeq = newest.seq;
      await ctx.db.patch(member._id, { readSeq });
    }
    return {
      conversation: await summary(ctx, conversation, readSeq),
      messages: await Promise.all(messages.map((m) => envelope(ctx, m))),
      hasMore,
    };
  },
});

export const list = query({
  args: { machine: machineAuth, as: v.string() },
  handler: async (ctx, args): Promise<Responses["list"]> => {
    const machine = await requireMachine(ctx, args.machine);
    const me = await actingAs(ctx, machine, args.as);
    const memberships = await ctx.db
      .query("members")
      .withIndex("by_participant", (q) => q.eq("participantId", me._id))
      .collect();
    const rows = [];
    for (const m of memberships) {
      const c = await ctx.db.get(m.conversationId);
      if (c) rows.push({ c, readSeq: m.readSeq });
    }
    rows.sort((a, b) => b.c.lastAt - a.c.lastAt);
    return { conversations: await Promise.all(rows.map(({ c, readSeq }) => summary(ctx, c, readSeq))) };
  },
});

// ---------------------------------------------------------------------------
// The agent registry (capabilities pass §1)

/** Every participant that isn't retired, or one by name (any state). Homes only with `long`. */
export const agents = query({
  args: { machine: machineAuth, as: v.string(), name: v.optional(v.string()), long: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Responses["agents"]> => {
    const machine = await requireMachine(ctx, args.machine);
    await actingAs(ctx, machine, args.as);
    const rows =
      args.name !== undefined
        ? [await participantByName(ctx, args.name)]
        : (await ctx.db.query("participants").collect()).filter((p) => p.state !== "retired");
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const seen = await machineSeen(ctx);
    const now = Date.now();
    return { agents: await Promise.all(rows.map((p) => registryEntry(ctx, p, seen, now, { long: args.long ?? false }))) };
  },
});

/** An agent sets its own description and duties (its owner edits them in the web view). */
export const agentsSet = mutation({
  args: {
    machine: machineAuth,
    as: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    duties: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<Responses["agents-set"]> => {
    const machine = await requireMachine(ctx, args.machine);
    const me = await actingAs(ctx, machine, args.as);
    const target = await participantByName(ctx, args.name);
    if (target._id !== me._id && target.ownerId !== me._id) {
      fail("conflict", `@${me.name} can set only its own registry entry (or one it owns), not @${target.name}'s`);
    }
    await ctx.db.patch(target._id, profilePatch(args));
    const updated = (await ctx.db.get(target._id))!;
    return { agent: await registryEntry(ctx, updated, await machineSeen(ctx), Date.now(), { long: true }) };
  },
});
