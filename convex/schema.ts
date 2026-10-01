import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  attachment,
  claim,
  conversationKind,
  deliveryState,
  home,
  messageKind,
  origin,
  participantKind,
  participantState,
  presenceStatus,
} from "./validators";

export default defineSchema({
  participants: defineTable({
    /** Unique, addressable (`@name`). */
    name: v.string(),
    kind: participantKind,
    owner: v.optional(v.string()),
    state: participantState,
    /** Agents have a home; humans read and post in the web view. */
    home: v.optional(home),
    presence: v.object({ status: presenceStatus, at: v.number() }),
    createdAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_machine", ["home.machine"]),

  conversations: defineTable({
    kind: conversationKind,
    title: v.optional(v.string()),
    /** DMs only: the two participant ids, sorted and joined, so each pair has one DM. */
    dmKey: v.optional(v.string()),
    lastSeq: v.number(),
    lastAt: v.number(),
    createdAt: v.number(),
  }).index("by_dmKey", ["dmKey"]),

  members: defineTable({
    conversationId: v.id("conversations"),
    participantId: v.id("participants"),
    /** Messages up to this seq count as read. */
    readSeq: v.number(),
    joinedAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_participant", ["participantId"])
    .index("by_conversation_participant", ["conversationId", "participantId"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    seq: v.number(),
    senderId: v.id("participants"),
    recipientIds: v.array(v.id("participants")),
    kind: messageKind,
    inReplyTo: v.optional(v.id("messages")),
    collectedFrom: v.optional(v.id("deliveries")),
    text: v.string(),
    attachments: v.array(attachment),
    origin,
    /** The sender's idempotency key, if the send carried one (fix pass 3.1). */
    idempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_conversation_seq", ["conversationId", "seq"])
    .index("by_sender_key", ["senderId", "idempotencyKey"])
    .index("by_collectedFrom", ["collectedFrom"])
    .index("by_inReplyTo", ["inReplyTo"]),

  deliveries: defineTable({
    messageId: v.id("messages"),
    conversationId: v.id("conversations"),
    recipientId: v.id("participants"),
    /** False for deliveries of an answer: they end at `delivered` and are never collected from. */
    collect: v.boolean(),
    state: deliveryState,
    at: v.number(),
    detail: v.optional(v.string()),
    /** Held from `claimed` through `delivered`; cleared when the delivery is finished. */
    claim: v.optional(claim),
    turnId: v.optional(v.string()),
    /** The adapter's resume point in the harness, for recovery after a restart. Opaque. */
    cursor: v.optional(v.string()),
    /**
     * The home this delivery was handed to, recorded before the handoff (fix pass
     * 2.5). An in-flight delivery stays with it through a rebind: that machine's
     * connector finishes or recovers it, against that home.
     */
    target: v.optional(home),
    answerMessageId: v.optional(v.id("messages")),
    createdAt: v.number(),
  })
    .index("by_recipient_state", ["recipientId", "state"])
    // `delivered` work is only collectable deliveries; finished answers stay out of the scan (2.6).
    .index("by_recipient_state_collect", ["recipientId", "state", "collect"])
    .index("by_target_state_collect", ["target.machine", "state", "collect"])
    .index("by_message", ["messageId"]),

  machines: defineTable({
    machineId: v.string(),
    /** SHA-256 of the connector secret, hex. The secret itself is never stored. */
    secretHash: v.string(),
    lastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_machineId", ["machineId"]),
});
