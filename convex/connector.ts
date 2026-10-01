// What a machine's connector calls. Every function takes the machine's
// credential; `as` names are accepted only for participants homed there.
//
// Claims: a connector claims a delivery with a lease, renews it while working,
// and renews once more immediately before handing the message to the harness:
// `renew` is the compare-and-set on the claim id. A lease that expired is taken
// over only through `claim`, which says `takeover: true` so the new holder
// checks the harness before running anything.

import { clipAnswer, DEFAULT_READ_LIMIT, type Responses } from "@agent-comms/protocol";
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
  ref,
  requireMachine,
  stateRef,
  summary,
} from "./lib/core";
import { openDm, post } from "./lib/post";
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
    await ctx.db.patch(p._id, { presence: { status: args.status, at: Date.now() } });
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
    const items = [];
    for (const p of await homedOn(ctx, machine)) {
      if (p.state === "retired") continue;
      const states = p.state === "active" ? (["pending", "claimed", "delivered"] as const) : (["claimed", "delivered"] as const);
      for (const state of states) {
        const rows = await ctx.db
          .query("deliveries")
          .withIndex("by_recipient_state", (q) => q.eq("recipientId", p._id).eq("state", state))
          .collect();
        for (const d of rows) {
          if (state === "delivered" && !d.collect) continue;
          items.push({
            id: d._id,
            recipient: p.name,
            harness: p.home!.harness,
            locator: p.home!.locator,
            state: d.state,
            collect: d.collect,
            ...(d.claim ? { claim: d.claim } : {}),
            ...(d.turnId !== undefined ? { turnId: d.turnId } : {}),
            createdAt: d.createdAt,
          });
        }
      }
    }
    items.sort((a, b) => a.createdAt - b.createdAt);
    return { deliveries: items };
  },
});

async function deliveryForMachine(ctx: QueryCtx, machine: Doc<"machines">, deliveryId: string) {
  const d = await getOr(ctx, "deliveries", deliveryId);
  const recipient = (await ctx.db.get(d.recipientId))!;
  if (recipient.home?.machine !== machine.machineId) {
    fail("not_homed_here", `delivery ${d._id} is for @${recipient.name}, not homed on ${machine.machineId}`);
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
    const requesterStillMember = await isMember(ctx, conversation._id, requester);
    const result = await post(ctx, {
      sender: recipient,
      conversation,
      recipients: requesterStillMember ? [requester] : [],
      kind: "answer",
      inReplyTo: request._id,
      collectedFrom: d._id,
      text: clipAnswer(args.answer),
      origin: { via: recipient.home!.harness === "t3" ? "t3" : "claude-code" },
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
    return finish(ctx, args, "ambiguous", `other input entered the turn: ${what}`);
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
  },
  handler: async (ctx, args): Promise<Responses["send"]> => {
    const machine = await requireMachine(ctx, args.machine);
    const sender = await actingAs(ctx, machine, args.as);
    const recipients = [];
    for (const name of args.to) {
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
  },
  handler: async (ctx, args): Promise<Responses["reply"]> => {
    const machine = await requireMachine(ctx, args.machine);
    const me = await actingAs(ctx, machine, args.as);
    const original = await getOr(ctx, "messages", args.messageId);
    const conversation = (await ctx.db.get(original.conversationId))!;
    await membership(ctx, conversation._id, me);
    const originalSender = (await ctx.db.get(original.senderId))!;
    const addressable = originalSender._id !== me._id && (await isMember(ctx, conversation._id, originalSender));
    const result: Responses["reply"] = await post(ctx, {
      sender: me,
      conversation,
      recipients: addressable ? [originalSender] : [],
      kind: "answer",
      inReplyTo: original._id,
      text: args.text,
      ...(args.attachments ? { attachments: args.attachments } : {}),
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
