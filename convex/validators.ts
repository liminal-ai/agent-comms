// Convex validators for the shapes in @agent-comms/protocol. The type
// assertions at the bottom fail to compile if the two drift apart.

import type * as P from "@agent-comms/protocol";
import { type Infer, v } from "convex/values";

export const participantKind = v.union(v.literal("human"), v.literal("agent"), v.literal("system"));
/** What `promote` creates: system participants are created at deploy, never promoted. */
export const promotableKind = v.union(v.literal("human"), v.literal("agent"));
export const participantState = v.union(v.literal("active"), v.literal("paused"), v.literal("retired"));
export const harness = v.union(v.literal("t3"), v.literal("claude-code"), v.literal("web"));
export const home = v.object({ machine: v.string(), harness, locator: v.string() });
export const presenceStatus = v.union(v.literal("idle"), v.literal("busy"), v.literal("offline"));
export const conversationKind = v.union(v.literal("dm"), v.literal("group"));
export const messageKind = v.union(v.literal("request"), v.literal("answer"), v.literal("notice"));
export const via = v.union(v.literal("t3"), v.literal("claude-code"), v.literal("cli"), v.literal("web"), v.literal("system"));
export const origin = v.object({ via, externalId: v.optional(v.string()) });
export const attachment = v.object({
  name: v.string(),
  url: v.string(),
  mimeType: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
});
export const deliveryState = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("delivered"),
  v.literal("replied"),
  v.literal("ambiguous"),
  v.literal("uncertain"),
  v.literal("failed"),
);
export const claim = v.object({ machine: v.string(), claimId: v.string(), leaseExpiresAt: v.number() });
export const enteredInput = v.object({ origin: v.string(), at: v.optional(v.number()) });
export const failureReason = v.union(
  v.literal("aborted"),
  v.literal("refusal"),
  v.literal("error"),
  v.literal("rejected"),
);

export const presence = v.object({
  status: presenceStatus,
  at: v.number(),
  idleSince: v.optional(v.number()),
  busySince: v.optional(v.number()),
});

// ---------------------------------------------------------------------------
// Capabilities pass (docs/04-capabilities.md)

export const messageMeta = v.union(
  v.object({
    type: v.literal("reminder"),
    reminderId: v.string(),
    name: v.string(),
    setBy: v.string(),
    schedule: v.string(),
    fire: v.number(),
  }),
  v.object({ type: v.literal("reminder-report"), reminderId: v.string(), name: v.string(), target: v.string(), fireMessageId: v.string() }),
  v.object({
    type: v.literal("reminder-ended"),
    reminderId: v.string(),
    name: v.string(),
    state: v.union(v.literal("done"), v.literal("cancelled"), v.literal("expired")),
    reason: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("alert"),
    alertId: v.string(),
    cause: v.string(),
    subject: v.object({ kind: v.string(), id: v.string() }),
  }),
);
export const waitResultState = v.union(
  v.literal("open"),
  v.literal("answered"),
  v.literal("expired"),
  v.literal("ended"),
  v.literal("acknowledged"),
  v.literal("fell-back"),
);
export const reminderState = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("blocked"),
  v.literal("done"),
  v.literal("cancelled"),
  v.literal("expired"),
);
export const reminderAction = v.union(v.literal("pause"), v.literal("resume"), v.literal("done"), v.literal("cancel"), v.literal("blocked"));
export const reminderSkipReason = v.union(v.literal("previous-fire-not-final"), v.literal("not-idle"), v.literal("presence-stale"));
export const reminderSkip = v.object({ at: v.number(), reason: reminderSkipReason, detail: v.optional(v.string()) });
export const alertCause = v.union(
  v.literal("uncertain-delivery"),
  v.literal("connector-silent"),
  v.literal("reminder-blocked"),
  v.literal("reminder-expired"),
  v.literal("delivery-reclaimed"),
);
export const alertSubjectKind = v.union(v.literal("delivery"), v.literal("machine"), v.literal("reminder"));

/** Every connector call carries its machine credential. */
export const machineAuth = v.object({ id: v.string(), secret: v.string() });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertSame<T extends true>(_: T) {}
assertSame<Same<Infer<typeof participantKind>, P.ParticipantKind>>(true);
assertSame<Same<Infer<typeof participantState>, P.ParticipantState>>(true);
assertSame<Same<Infer<typeof harness>, P.Harness>>(true);
assertSame<Same<Infer<typeof conversationKind>, P.ConversationKind>>(true);
assertSame<Same<Infer<typeof messageKind>, P.MessageKind>>(true);
assertSame<Same<Infer<typeof via>, P.Via>>(true);
assertSame<Same<Infer<typeof deliveryState>, P.DeliveryState>>(true);
assertSame<Same<Infer<typeof claim>, P.Claim>>(true);
assertSame<Same<Infer<typeof home>, P.Home>>(true);
assertSame<Same<Infer<typeof waitResultState>, P.WaitResultState>>(true);
assertSame<Same<Infer<typeof reminderState>, P.ReminderState>>(true);
assertSame<Same<Infer<typeof reminderAction>, P.ReminderAction>>(true);
assertSame<Same<Infer<typeof reminderSkip>["reason"], P.ReminderSkip["reason"]>>(true);
assertSame<Same<Infer<typeof alertCause>, P.AlertCause>>(true);
assertSame<Same<Infer<typeof alertSubjectKind>, P.Alert["subject"]["kind"]>>(true);
assertSame<Same<Infer<typeof messageMeta>, P.MessageMeta>>(true);
