// Convex validators for the shapes in @agent-comms/protocol. The type
// assertions at the bottom fail to compile if the two drift apart.

import type * as P from "@agent-comms/protocol";
import { type Infer, v } from "convex/values";

export const participantKind = v.union(v.literal("human"), v.literal("agent"));
export const participantState = v.union(v.literal("active"), v.literal("paused"), v.literal("retired"));
export const harness = v.union(v.literal("t3"), v.literal("claude-code"), v.literal("web"));
export const home = v.object({ machine: v.string(), harness, locator: v.string() });
export const presenceStatus = v.union(v.literal("idle"), v.literal("busy"), v.literal("offline"));
export const conversationKind = v.union(v.literal("dm"), v.literal("group"));
export const messageKind = v.union(v.literal("request"), v.literal("answer"));
export const via = v.union(v.literal("t3"), v.literal("claude-code"), v.literal("cli"), v.literal("web"));
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
