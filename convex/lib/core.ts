// Shared by every Convex function: results, auth, lookups, and turning rows
// into the protocol's shapes.

import {
  boundHistory,
  type ConversationRef,
  type ConversationSummary,
  DEFAULT_HISTORY_LIMITS,
  type Delivery,
  type DeliveryStateRef,
  type ErrorCode,
  type MessageEnvelope,
  type ParticipantRef,
} from "@agent-comms/protocol";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// ---------------------------------------------------------------------------
// Errors: a protocol error is thrown as a ConvexError carrying {code, message},
// so the mutation rolls back and the connector passes the code straight
// through to its client. Anything else (auth, bugs) is a plain Error.

export type ProtocolErrorData = { code: ErrorCode; message: string };

export function fail(code: ErrorCode, message: string): never {
  throw new ConvexError<ProtocolErrorData>({ code, message });
}

// ---------------------------------------------------------------------------
// Auth (development): a secret per machine for connectors, one admin token for Lee's web view.

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two secrets in time that doesn't depend on where they differ (3.6). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function requireMachine(ctx: QueryCtx, auth: { id: string; secret: string }): Promise<Doc<"machines">> {
  const machine = await ctx.db
    .query("machines")
    .withIndex("by_machineId", (q) => q.eq("machineId", auth.id))
    .unique();
  const presented = await sha256Hex(auth.secret);
  let diff = machine ? presented.length ^ machine.secretHash.length : 1;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ (machine?.secretHash.charCodeAt(i) ?? 0);
  if (!machine || diff !== 0) {
    // Deliberately the same answer for an unknown machine and a wrong secret.
    throw new Error("machine credential rejected");
  }
  return machine;
}

export async function requireAdmin(token: string): Promise<void> {
  const expected = process.env.COMMS_ADMIN_TOKEN;
  if (!expected) throw new Error("COMMS_ADMIN_TOKEN is not set on this deployment");
  if (!(await sameSecret(token, expected))) throw new Error("admin token rejected");
}

// ---------------------------------------------------------------------------
// Lookups

export async function participantByName(ctx: QueryCtx, name: string): Promise<Doc<"participants">> {
  const p = await ctx.db
    .query("participants")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (!p) fail("unknown_participant", `no participant named @${name}`);
  return p;
}

/** `--as`: any participant homed on the calling machine. A trusted-machine shortcut, not proof of identity. */
export async function actingAs(ctx: QueryCtx, machine: Doc<"machines">, name: string): Promise<Doc<"participants">> {
  const p = await participantByName(ctx, name);
  if (p.home?.machine !== machine.machineId) {
    fail("not_homed_here", `@${name} is not homed on ${machine.machineId}`);
  }
  return p;
}

export async function getOr<T extends "conversations" | "messages" | "deliveries" | "participants" | "reminders">(
  ctx: QueryCtx,
  table: T,
  id: string,
): Promise<Doc<T>> {
  const code: ErrorCode =
    table === "conversations"
      ? "unknown_conversation"
      : table === "messages"
        ? "unknown_message"
        : table === "deliveries"
          ? "unknown_delivery"
          : table === "reminders"
            ? "unknown_reminder"
            : "unknown_participant";
  const normalized = ctx.db.normalizeId(table, id);
  const doc = normalized ? await ctx.db.get(normalized) : null;
  if (!doc) fail(code, `no ${table.replace(/s$/, "")} ${id}`);
  return doc as Doc<T>;
}

export async function membership(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
  participant: Doc<"participants">,
): Promise<Doc<"members">> {
  const m = await ctx.db
    .query("members")
    .withIndex("by_conversation_participant", (q) =>
      q.eq("conversationId", conversationId).eq("participantId", participant._id),
    )
    .unique();
  if (!m) fail("not_member", `@${participant.name} is not a member of ${conversationId}`);
  return m;
}

// ---------------------------------------------------------------------------
// Rows to protocol shapes

export function ref(p: Doc<"participants">): ParticipantRef {
  return { id: p._id, name: p.name, kind: p.kind };
}

export function conversationRef(c: Doc<"conversations">): ConversationRef {
  return { id: c._id, kind: c.kind, ...(c.title !== undefined ? { title: c.title } : {}) };
}

export async function refById(ctx: QueryCtx, id: Id<"participants">): Promise<ParticipantRef> {
  const p = await ctx.db.get(id);
  if (!p) throw new Error(`participant ${id} missing`);
  return ref(p);
}

export async function envelope(ctx: QueryCtx, m: Doc<"messages">): Promise<MessageEnvelope> {
  return {
    id: m._id,
    conversationId: m.conversationId,
    seq: m.seq,
    sender: await refById(ctx, m.senderId),
    recipients: await Promise.all(m.recipientIds.map((id) => refById(ctx, id))),
    kind: m.kind,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    ...(m.collectedFrom ? { collectedFrom: m.collectedFrom } : {}),
    text: m.text,
    attachments: m.attachments,
    createdAt: m.createdAt,
    origin: m.origin,
    ...(m.meta ? { meta: m.meta } : {}),
  };
}

export async function stateRef(ctx: QueryCtx, d: Doc<"deliveries">): Promise<DeliveryStateRef> {
  return { id: d._id, recipient: (await refById(ctx, d.recipientId)).name, state: d.state };
}

/** A delivery as the connector hands it to an adapter: the message, the request it answers, and bounded history. */
export async function fullDelivery(ctx: QueryCtx, d: Doc<"deliveries">): Promise<Delivery> {
  const message = await ctx.db.get(d.messageId);
  const conversation = await ctx.db.get(d.conversationId);
  const recipient = await ctx.db.get(d.recipientId);
  if (!message || !conversation || !recipient) throw new Error(`delivery ${d._id} is missing its rows`);
  const member = await ctx.db
    .query("members")
    .withIndex("by_conversation_participant", (q) =>
      q.eq("conversationId", conversation._id).eq("participantId", recipient._id),
    )
    .unique();
  const readSeq = Math.min(member?.readSeq ?? 0, message.seq - 1);
  const limits = DEFAULT_HISTORY_LIMITS;
  // Seqs have no gaps, so everything unread is (readSeq, message.seq); fetch only the newest that could be shown.
  const newest = await ctx.db
    .query("messages")
    .withIndex("by_conversation_seq", (q) =>
      q.eq("conversationId", conversation._id).gt("seq", readSeq).lt("seq", message.seq),
    )
    .order("desc")
    .take(limits.maxMessages);
  const bounded = boundHistory(await Promise.all(newest.map((m) => envelope(ctx, m))), limits);
  const unreadCount = message.seq - 1 - readSeq;
  const inReplyTo = message.inReplyTo ? await ctx.db.get(message.inReplyTo) : null;
  return {
    id: d._id,
    recipient: ref(recipient),
    conversation: conversationRef(conversation),
    message: await envelope(ctx, message),
    ...(inReplyTo ? { inReplyTo: await envelope(ctx, inReplyTo) } : {}),
    history: { messages: bounded.messages, omitted: unreadCount - bounded.messages.length },
    status: {
      state: d.state,
      at: d.at,
      ...(d.detail !== undefined ? { detail: d.detail } : {}),
      ...(d.claim ? { claim: d.claim } : {}),
      ...(d.turnId !== undefined ? { turnId: d.turnId } : {}),
      ...(d.cursor !== undefined ? { cursor: d.cursor } : {}),
    },
  };
}

export async function summary(
  ctx: QueryCtx,
  c: Doc<"conversations">,
  readSeq: number,
): Promise<ConversationSummary> {
  const members = await ctx.db
    .query("members")
    .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
    .collect();
  return {
    ...conversationRef(c),
    members: await Promise.all(members.map((m) => refById(ctx, m.participantId))),
    lastSeq: c.lastSeq,
    readSeq,
    unread: c.lastSeq - readSeq,
  };
}

export async function advanceRead(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  participantId: Id<"participants">,
  seq: number,
): Promise<void> {
  const m = await ctx.db
    .query("members")
    .withIndex("by_conversation_participant", (q) =>
      q.eq("conversationId", conversationId).eq("participantId", participantId),
    )
    .unique();
  if (m && m.readSeq < seq) await ctx.db.patch(m._id, { readSeq: seq });
}
