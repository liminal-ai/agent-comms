// Posting a message: the one path every send, reply, collected answer and web
// post goes through. Creates the addressed deliveries.

import { type AttachmentRef, MAX_TEXT_CHARS, type Origin, type SendResult } from "@agent-comms/protocol";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { advanceRead, envelope, fail, membership, stateRef } from "./core";

export interface PostInput {
  sender: Doc<"participants">;
  conversation: Doc<"conversations">;
  recipients: Doc<"participants">[];
  kind: "request" | "answer";
  inReplyTo?: Id<"messages">;
  collectedFrom?: Id<"deliveries">;
  idempotencyKey?: string;
  /** A collected answer to a request accepted earlier: posted even if the sender has since been retired or left (2.4). */
  inFlight?: boolean;
  text: string;
  attachments?: AttachmentRef[];
  origin: Origin;
}

export async function post(ctx: MutationCtx, input: PostInput): Promise<SendResult> {
  const { sender, conversation, recipients } = input;
  if (sender.state === "retired" && !input.inFlight) fail("conflict", `@${sender.name} is retired`);
  if (input.text.length > MAX_TEXT_CHARS) {
    fail("bad_request", `message text is ${input.text.length} characters; the limit is ${MAX_TEXT_CHARS}. Shorten it, or put the long part in a file and send a reference.`);
  }
  const attachments = input.attachments ?? [];
  if (attachments.length > 20) fail("bad_request", `${attachments.length} attachments; the limit is 20`);
  for (const a of attachments) {
    if (a.name.length > 512 || a.url.length > 4096) fail("bad_request", "an attachment's name (512) or url (4096) is too long");
  }
  if (input.kind === "answer" && !input.inReplyTo) fail("bad_request", "an answer needs inReplyTo");
  if (input.kind === "request" && input.inReplyTo) fail("bad_request", "a request can't have inReplyTo");
  if (new Set(recipients.map((r) => r._id)).size !== recipients.length) fail("bad_request", "a recipient is named twice");
  if (recipients.some((r) => r._id === sender._id)) fail("bad_request", "can't address yourself");
  const system = recipients.find((r) => r.kind === "system");
  if (system) fail("bad_request", `@${system.name} is a system participant; it sends, and can't be addressed`);
  if (!input.inFlight) await membership(ctx, conversation._id, sender);
  for (const r of recipients) await membership(ctx, conversation._id, r);

  const now = Date.now();
  const seq = conversation.lastSeq + 1;
  const messageId = await ctx.db.insert("messages", {
    conversationId: conversation._id,
    seq,
    senderId: sender._id,
    recipientIds: recipients.map((r) => r._id),
    kind: input.kind,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.collectedFrom ? { collectedFrom: input.collectedFrom } : {}),
    text: input.text,
    attachments: input.attachments ?? [],
    origin: input.origin,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    createdAt: now,
  });
  await ctx.db.patch(conversation._id, { lastSeq: seq, lastAt: now });
  await advanceRead(ctx, conversation._id, sender._id, seq); // no-op for a sender who has left

  const result: SendResult = {
    message: await envelope(ctx, (await ctx.db.get(messageId))!),
    deliveries: [],
    skipped: [],
  };
  // Addressed wakes: one delivery per addressed agent. Retired get none, paused
  // ones wait as pending. People get an inbox row instead, and read in the web view.
  for (const r of recipients) {
    if (r.state === "retired") {
      result.skipped.push({ name: r.name, reason: "retired" });
      continue;
    }
    if (r.kind === "human") {
      await ctx.db.insert("inbox", { humanId: r._id, messageId, conversationId: conversation._id, createdAt: now });
      continue;
    }
    const deliveryId = await ctx.db.insert("deliveries", {
      messageId,
      conversationId: conversation._id,
      recipientId: r._id,
      collect: input.kind === "request",
      state: "pending",
      at: now,
      createdAt: now,
    });
    result.deliveries.push(await stateRef(ctx, (await ctx.db.get(deliveryId))!));
  }
  return result;
}

/** The earlier result of a send or reply with this key from this sender, if any (fix pass 3.1). */
export async function replayed(ctx: MutationCtx, sender: Doc<"participants">, key: string | undefined): Promise<SendResult | null> {
  if (key === undefined) return null;
  const m = await ctx.db
    .query("messages")
    .withIndex("by_sender_key", (q) => q.eq("senderId", sender._id).eq("idempotencyKey", key))
    .first();
  if (!m) return null;
  const deliveries = await ctx.db
    .query("deliveries")
    .withIndex("by_message", (q) => q.eq("messageId", m._id))
    .collect();
  const skipped = [];
  for (const id of m.recipientIds) {
    const r = await ctx.db.get(id);
    if (r && r.kind === "agent" && !deliveries.some((d) => d.recipientId === id)) skipped.push({ name: r.name, reason: "retired" as const });
  }
  return {
    message: await envelope(ctx, m),
    deliveries: await Promise.all(deliveries.map((d) => stateRef(ctx, d))),
    skipped,
  };
}

/** The DM between two participants, opened if new. */
export async function openDm(
  ctx: MutationCtx,
  a: Doc<"participants">,
  b: Doc<"participants">,
): Promise<Doc<"conversations">> {
  if (a._id === b._id) fail("bad_request", "a DM needs two different participants");
  const dmKey = [a._id, b._id].sort().join(":");
  const existing = await ctx.db
    .query("conversations")
    .withIndex("by_dmKey", (q) => q.eq("dmKey", dmKey))
    .unique();
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("conversations", { kind: "dm", dmKey, lastSeq: 0, lastAt: now, createdAt: now });
  for (const p of [a, b]) {
    await ctx.db.insert("members", { conversationId: id, participantId: p._id, readSeq: 0, joinedAt: now });
  }
  return (await ctx.db.get(id))!;
}
