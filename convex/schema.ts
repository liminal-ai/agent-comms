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
  alertCause,
  alertSubjectKind,
  messageMeta,
  participantKind,
  participantState,
  presence,
  reminderSkip,
  reminderState,
  waitResultState,
} from "./validators";

export default defineSchema({
  participants: defineTable({
    /** Unique, addressable (`@name`). */
    name: v.string(),
    kind: participantKind,
    /** Agents: the person who owns them (`@owner` resolves to this; alerts go here). */
    ownerId: v.optional(v.id("participants")),
    state: participantState,
    /** Agents have a home; humans read and post in the web view; system participants have neither. */
    home: v.optional(home),
    /** `idleSince` is set only on the transition to idle. System participants stay `offline`. */
    presence,
    /** Agent registry: one line. */
    description: v.optional(v.string()),
    /** Agent registry: a few lines. */
    duties: v.optional(v.array(v.string())),
    createdAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_machine", ["home.machine"])
    .index("by_owner", ["ownerId"]),

  conversations: defineTable({
    kind: conversationKind,
    title: v.optional(v.string()),
    /** DMs only: the two participant ids, sorted and joined, so each pair has one DM. */
    dmKey: v.optional(v.string()),
    lastSeq: v.number(),
    lastAt: v.number(),
    createdAt: v.number(),
    /** Groups only: when a person archived it. Archived groups leave the web list; posting still works. */
    archivedAt: v.optional(v.number()),
    archivedBy: v.optional(v.id("participants")),
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
    /** What a system participant's message is (reminder fire, report, notice, alert). */
    meta: v.optional(messageMeta),
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
    /** Push: held through delivered. Oaidot: cleared at explicit receipt. */
    claim: v.optional(claim),
    /** Durable proof of an explicit oaidot receipt. Never exposed as an active claim. */
    received: v.optional(v.object({ machine: v.string(), claimId: v.string(), at: v.number() })),
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
    /** How many times it has been claimed (alerts: reclaimed too often). Absent means 0 or 1 before R4. */
    claimCount: v.optional(v.number()),
    /** The one fallback delivery of an answer already returned to a waiting send, unacknowledged. */
    fallback: v.optional(v.boolean()),
    /** Follow-up 3: the alert scan has seen this delivery as uncertain / reclaimed (alerted, or an incident was already open). */
    uncertainReported: v.optional(v.boolean()),
    reclaimReported: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_recipient_state", ["recipientId", "state"])
    // `delivered` work is only collectable deliveries; finished answers stay out of the scan (2.6).
    .index("by_recipient_state_collect", ["recipientId", "state", "collect"])
    .index("by_target_state_collect", ["target.machine", "state", "collect"])
    .index("by_message", ["messageId"])
    .index("by_state_at", ["state", "at"])
    // Alerts (follow-up 2, 3): what hasn't been reported yet, so every scan makes progress.
    .index("by_state_uncertainReported", ["state", "uncertainReported"])
    .index("by_reclaim_unreported", ["state", "collect", "reclaimReported", "claimCount"])
    // Alerts (fix pass 1.3): in-flight deliveries only (answers end at `delivered` and are never in flight).
    .index("by_state_collect", ["state", "collect"]),

  // -------------------------------------------------------------------------
  // Capabilities pass (docs/04-capabilities.md)

  /** A person's inbox: one row per message addressed to them (people get no deliveries). */
  inbox: defineTable({
    humanId: v.id("participants"),
    messageId: v.id("messages"),
    conversationId: v.id("conversations"),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_human", ["humanId", "createdAt"])
    .index("by_human_read", ["humanId", "readAt"])
    // Fix pass 2: unread, newest first, a page at a time.
    .index("by_human_read_created", ["humanId", "readAt", "createdAt"])
    .index("by_human_conversation", ["humanId", "conversationId", "readAt"])
    .index("by_human_message", ["humanId", "messageId"]),

  /** A waiting send. Kept WAIT_RETENTION_MS after it stops being active, for `await` and `comms status`. */
  waits: defineTable({
    waiterId: v.id("participants"),
    messageId: v.id("messages"),
    until: v.number(),
    /** Counts as busy waiting: false once no result is `open`, or `until` passed. */
    active: v.boolean(),
    /** The last `await` from the waiting CLI (or the send): answers are taken only while it's recent (WAIT_HELD_MS). */
    lastAwaitAt: v.number(),
    /** Fix pass 0.1: the waiter's main turn when the wait was created; only proofs from it confirm. */
    waiterTurnId: v.optional(v.string()),
    /** People addressed by the request: in their inbox, never waited on. */
    inInboxIds: v.array(v.id("participants")),
    endedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_waiter_active", ["waiterId", "active"])
    .index("by_message", ["messageId"])
    .index("by_active_until", ["active", "until"])
    // Fix pass 0.2: active waits whose CLI stopped checking in.
    .index("by_active_lastAwait", ["active", "lastAwaitAt"])
    .index("by_endedAt", ["endedAt"]),

  /** One addressed agent's result in a wait. Every transition is a compare-and-set (WaitResultState). */
  waitResults: defineTable({
    waitId: v.id("waits"),
    recipientId: v.id("participants"),
    /** The recipient's delivery of the request. */
    deliveryId: v.id("deliveries"),
    state: waitResultState,
    answerMessageId: v.optional(v.id("messages")),
    /** Fix pass 0.1: the proof token for this answer's markers, made when it's answered. */
    proofToken: v.optional(v.string()),
    /** Fix pass 0.1: when the CLI said it printed the answer (provisional). */
    printedAt: v.optional(v.number()),
    /** Follow-up (a): for an answered result once its wait ended, when its fallback is due. */
    fallbackDueAt: v.optional(v.number()),
    at: v.number(),
  })
    .index("by_wait", ["waitId"])
    .index("by_delivery", ["deliveryId"])
    .index("by_state_at", ["state", "at"])
    // Follow-up (a): the fallback pass reads only results that are due.
    .index("by_state_due", ["state", "fallbackDueAt"]),

  reminders: defineTable({
    name: v.string(),
    text: v.string(),
    targetId: v.id("participants"),
    createdById: v.id("participants"),
    everyMs: v.optional(v.number()),
    at: v.optional(v.number()),
    idleForMs: v.optional(v.number()),
    watchId: v.optional(v.id("participants")),
    max: v.optional(v.number()),
    reportToId: v.optional(v.id("participants")),
    state: reminderState,
    stateReason: v.optional(v.string()),
    stateAt: v.number(),
    fires: v.number(),
    nextFireAt: v.optional(v.number()),
    expiresAt: v.number(),
    /** The most recent skips, newest last (capped). */
    skips: v.array(reminderSkip),
    /** Follow-up 3: the alert scan has seen it expired / blocked (cleared when it leaves `blocked`). */
    expiryReported: v.optional(v.boolean()),
    blockedReported: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_state_next", ["state", "nextFireAt"])
    // Fix pass 1.3: expiry and alerts read live states only, never finished history.
    .index("by_state_expires", ["state", "expiresAt"])
    .index("by_state_stateAt", ["state", "stateAt"])
    .index("by_state_expiryReported", ["state", "expiryReported"])
    .index("by_blocked_unreported", ["state", "blockedReported", "stateAt"])
    .index("by_target", ["targetId"])
    .index("by_creator", ["createdById"])
    .index("by_reportTo", ["reportToId"])
    // Follow-up (c): lists read live reminders and a few recent finished ones, never all history.
    .index("by_target_state", ["targetId", "state"])
    .index("by_creator_state", ["createdById", "state"])
    .index("by_reportTo_state", ["reportToId", "state"]),

  /** One row per fire, keyed by the fire's request message. */
  reminderFires: defineTable({
    reminderId: v.id("reminders"),
    messageId: v.id("messages"),
    deliveryId: v.id("deliveries"),
    firedAt: v.number(),
    answerMessageId: v.optional(v.id("messages")),
    answeredAt: v.optional(v.number()),
    /** Fix pass 1.5: the report posted for the answer, or why it failed (tried once). */
    reportMessageId: v.optional(v.id("messages")),
    reportError: v.optional(v.string()),
  })
    .index("by_message", ["messageId"])
    .index("by_reminder", ["reminderId", "firedAt"]),

  /** Alert incidents, keyed by (cause, subject). One alert per incident; a recurrence is a new incident. */
  alerts: defineTable({
    cause: alertCause,
    subjectKind: alertSubjectKind,
    subjectId: v.string(),
    /** For a delivery subject: the conversation it's in. */
    subjectConversationId: v.optional(v.id("conversations")),
    ownerId: v.id("participants"),
    /** The alert message and its conversation (the DM between @alerts and the owner). */
    messageId: v.id("messages"),
    conversationId: v.id("conversations"),
    openedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    /** Follow-up 2: when the resolve pass last found it still holding (open incidents are checked least recently first). */
    checkedAt: v.optional(v.number()),
    summary: v.string(),
  })
    .index("by_subject", ["cause", "subjectId", "resolvedAt"])
    .index("by_resolved", ["resolvedAt", "openedAt"])
    .index("by_opened", ["openedAt"])
    .index("by_cause_resolved", ["cause", "resolvedAt"])
    .index("by_resolved_checked", ["resolvedAt", "checkedAt"]),

  /** One-time data migrations run by `directory.upgrade` (follow-up 3: "alert-history"). */
  migrations: defineTable({ name: v.string(), doneAt: v.number() }).index("by_name", ["name"]),

  /** The alert thresholds: at most one row; DEFAULT_ALERT_CONFIG when absent. */
  alertConfig: defineTable({
    connectorSilentMs: v.number(),
    reminderBlockedMs: v.number(),
    maxClaims: v.number(),
  }),

  machines: defineTable({
    machineId: v.string(),
    /** SHA-256 of the connector secret, hex. The secret itself is never stored. */
    secretHash: v.string(),
    /** SHA-256 of an optional watch secret: accepted only by `connector:work`, so a watcher (agent-wake-relay) never holds the power to act as the machine. */
    watchSecretHash: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_machineId", ["machineId"]),
});
