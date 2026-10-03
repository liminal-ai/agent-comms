// Alerts (capabilities pass §5). A minute scan opens an incident, keyed by
// (cause, subject, owner), and posts one alert from @alerts to the owner when a
// condition starts; the incident resolves when the condition clears, and a
// recurrence opens a new incident with a new alert. Recovery isn't announced.

import { type AlertCause, type AlertConfig, DEFAULT_ALERT_CONFIG, renderAlert } from "@agent-comms/protocol";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { openDm, post } from "./post";

/** The thresholds: the one config row, else the defaults. */
export async function alertConfig(ctx: QueryCtx): Promise<AlertConfig> {
  const row = await ctx.db.query("alertConfig").first();
  return row
    ? { connectorSilentMs: row.connectorSilentMs, reminderBlockedMs: row.reminderBlockedMs, maxClaims: row.maxClaims }
    : { ...DEFAULT_ALERT_CONFIG };
}

type SubjectKind = Doc<"alerts">["subjectKind"];

interface Condition {
  cause: AlertCause;
  subjectKind: SubjectKind;
  subjectId: string;
  ownerId: Id<"participants">;
  detail?: string;
  subjectConversationId?: Id<"conversations">;
  /** A one-off event (an expiry): alerted once per subject ever, and resolved at once. */
  event?: boolean;
}


async function alertsParticipant(ctx: MutationCtx): Promise<Doc<"participants">> {
  const p = await ctx.db
    .query("participants")
    .withIndex("by_name", (q) => q.eq("name", "alerts"))
    .unique();
  if (!p || p.kind !== "system") throw new Error("@alerts is missing: run scripts/upgrade.ts after deploying");
  return p;
}

async function open(ctx: MutationCtx, c: Condition, now: number): Promise<boolean> {
  const existing = await ctx.db
    .query("alerts")
    .withIndex("by_subject", (q) => q.eq("cause", c.cause).eq("subjectId", c.subjectId))
    .collect();
  const mine = existing.filter((a) => a.ownerId === c.ownerId);
  if (c.event ? mine.length > 0 : mine.some((a) => a.resolvedAt === undefined)) return false;
  const owner = await ctx.db.get(c.ownerId);
  if (!owner || owner.kind !== "human" || owner.state === "retired") return false;
  const from = await alertsParticipant(ctx);
  const conversation = await openDm(ctx, from, owner);
  const text = renderAlert({ cause: c.cause, subject: { kind: c.subjectKind, id: c.subjectId }, ...(c.detail ? { detail: c.detail } : {}) });
  const sent = await post(ctx, { sender: from, conversation, recipients: [owner], kind: "notice", text, origin: { via: "system" } });
  const messageId = sent.message.id as Id<"messages">;
  const alertId = await ctx.db.insert("alerts", {
    cause: c.cause,
    subjectKind: c.subjectKind,
    subjectId: c.subjectId,
    ...(c.subjectConversationId ? { subjectConversationId: c.subjectConversationId } : {}),
    ownerId: owner._id,
    messageId,
    conversationId: conversation._id,
    openedAt: now,
    ...(c.event ? { resolvedAt: now } : {}),
    summary: text,
  });
  await ctx.db.patch(messageId, { meta: { type: "alert", alertId, cause: c.cause, subject: { kind: c.subjectKind, id: c.subjectId } } });
  return true;
}

/** Rows handled per scan for each source; the rest are reached by later scans (each handled row leaves the unreported set). */
const BATCH = 200;
/** Open incidents rechecked per scan, least recently checked first. */
const RECHECK = 500;

/**
 * The scan (follow-up 2, 3). New incidents come from what hasn't been reported yet,
 * whatever its age: each row the scan handles is marked reported (alerted, or its
 * incident was already open), so every scan makes progress and an incident found after
 * a long outage still alerts once. Open incidents are rechecked on their own subject:
 * connector ones every scan, the rest least recently checked first.
 */
export async function scan(ctx: MutationCtx, now: number): Promise<{ opened: number; resolved: number }> {
  const config = await alertConfig(ctx);
  const ownerOf = async (participantId: Id<"participants">) => (await ctx.db.get(participantId))?.ownerId;
  let opened = 0;
  const raise = async (c: Condition | null) => {
    if (c && (await open(ctx, c, now))) opened++;
  };
  // History from before tracking is marked by `directory.upgrade` first (no flood on deploy).
  const tracking = !!(await ctx.db
    .query("migrations")
    .withIndex("by_name", (q) => q.eq("name", ALERT_HISTORY))
    .first());

  if (tracking) {
    for (const d of await ctx.db
      .query("deliveries")
      .withIndex("by_state_uncertainReported", (q) => q.eq("state", "uncertain").eq("uncertainReported", undefined))
      .take(BATCH)) {
      const ownerId = await ownerOf(d.recipientId);
      await raise(ownerId ? { cause: "uncertain-delivery", subjectKind: "delivery", subjectId: d._id, ownerId, subjectConversationId: d.conversationId, ...(d.detail ? { detail: d.detail } : {}) } : null);
      await ctx.db.patch(d._id, { uncertainReported: true });
    }
    for (const r of await ctx.db
      .query("reminders")
      .withIndex("by_state_expiryReported", (q) => q.eq("state", "expired").eq("expiryReported", undefined))
      .take(BATCH)) {
      const ownerId = await ownerOf(r.targetId);
      await raise(ownerId ? { cause: "reminder-expired", subjectKind: "reminder", subjectId: r._id, ownerId, detail: `"${r.name}", ${r.fires} fire${r.fires === 1 ? "" : "s"}`, event: true } : null);
      await ctx.db.patch(r._id, { expiryReported: true });
    }
  }

  for (const [state, collect] of [["claimed", true], ["claimed", false], ["delivered", true]] as const) {
    for (const d of await ctx.db
      .query("deliveries")
      .withIndex("by_reclaim_unreported", (q) => q.eq("state", state).eq("collect", collect).eq("reclaimReported", undefined).gt("claimCount", config.maxClaims))
      .take(BATCH)) {
      const ownerId = await ownerOf(d.recipientId);
      await raise(ownerId ? { cause: "delivery-reclaimed", subjectKind: "delivery", subjectId: d._id, ownerId, subjectConversationId: d.conversationId, detail: `claimed ${d.claimCount} times` } : null);
      await ctx.db.patch(d._id, { reclaimReported: true });
    }
  }

  for (const r of await ctx.db
    .query("reminders")
    .withIndex("by_blocked_unreported", (q) => q.eq("state", "blocked").eq("blockedReported", undefined).lte("stateAt", now - config.reminderBlockedMs))
    .take(BATCH)) {
    const ownerId = await ownerOf(r.targetId);
    await raise(ownerId ? { cause: "reminder-blocked", subjectKind: "reminder", subjectId: r._id, ownerId, ...(r.stateReason ? { detail: r.stateReason } : {}) } : null);
    await ctx.db.patch(r._id, { blockedReported: true });
  }

  for (const m of await ctx.db.query("machines").collect()) {
    const silent = await silentMachine(ctx, m, config, now);
    if (!silent) continue;
    for (const ownerId of silent.owners) await raise({ cause: "connector-silent", subjectKind: "machine", subjectId: m.machineId, ownerId, detail: silent.detail });
  }

  let resolved = 0;
  const recheck = async (a: Doc<"alerts">) => {
    if (await stillHolds(ctx, a, config, now)) await ctx.db.patch(a._id, { checkedAt: now });
    else {
      await ctx.db.patch(a._id, { resolvedAt: now });
      resolved++;
    }
  };
  // Connector incidents every scan (machines are few); the rest in rotation.
  for (const a of await ctx.db
    .query("alerts")
    .withIndex("by_cause_resolved", (q) => q.eq("cause", "connector-silent").eq("resolvedAt", undefined))
    .take(100)) {
    await recheck(a);
  }
  for (const a of await ctx.db
    .query("alerts")
    .withIndex("by_resolved_checked", (q) => q.eq("resolvedAt", undefined))
    .take(RECHECK)) {
    if (a.cause !== "connector-silent") await recheck(a);
  }
  return { opened, resolved };
}

export const ALERT_HISTORY = "alert-history";

/**
 * One batch of the alert-history migration (follow-up 3): marks uncertain deliveries and
 * expired reminders that exist before tracking began as reported, so deploying tracking
 * doesn't alert old history. Until it's done the scan doesn't look for those two causes.
 */
export async function markAlertHistory(ctx: MutationCtx, now: number): Promise<{ marked: number; done: boolean }> {
  if (await ctx.db.query("migrations").withIndex("by_name", (q) => q.eq("name", ALERT_HISTORY)).first()) return { marked: 0, done: true };
  let marked = 0;
  const deliveries = await ctx.db
    .query("deliveries")
    .withIndex("by_state_uncertainReported", (q) => q.eq("state", "uncertain").eq("uncertainReported", undefined))
    .take(500);
  for (const d of deliveries) await ctx.db.patch(d._id, { uncertainReported: true });
  const reminders = await ctx.db
    .query("reminders")
    .withIndex("by_state_expiryReported", (q) => q.eq("state", "expired").eq("expiryReported", undefined))
    .take(500);
  for (const r of reminders) await ctx.db.patch(r._id, { expiryReported: true });
  marked = deliveries.length + reminders.length;
  const done = deliveries.length < 500 && reminders.length < 500;
  if (done) await ctx.db.insert("migrations", { name: ALERT_HISTORY, doneAt: now });
  return { marked, done };
}

async function silentMachine(ctx: MutationCtx, m: Doc<"machines">, config: AlertConfig, now: number) {
  const lastSeen = m.lastSeenAt ?? m.createdAt;
  if (now - lastSeen < config.connectorSilentMs) return null;
  const homed = (await ctx.db
    .query("participants")
    .withIndex("by_machine", (q) => q.eq("home.machine", m.machineId))
    .collect()).filter((p) => p.kind === "agent" && p.state !== "retired");
  if (homed.length === 0) return null;
  const minutes = Math.floor((now - lastSeen) / 60_000);
  return {
    owners: new Set(homed.flatMap((p) => (p.ownerId ? [p.ownerId] : []))),
    detail: `not heard from for ${minutes} minutes; ${homed.length} agent${homed.length === 1 ? "" : "s"} homed there`,
  };
}

/** Whether an open incident's condition still holds, checked on its own subject. */
async function stillHolds(ctx: MutationCtx, a: Doc<"alerts">, config: AlertConfig, now: number): Promise<boolean> {
  switch (a.cause) {
    case "uncertain-delivery": {
      const id = ctx.db.normalizeId("deliveries", a.subjectId);
      return (id ? await ctx.db.get(id) : null)?.state === "uncertain";
    }
    case "delivery-reclaimed": {
      const id = ctx.db.normalizeId("deliveries", a.subjectId);
      const d = id ? await ctx.db.get(id) : null;
      return !!d && (d.state === "claimed" || d.state === "delivered") && (d.claimCount ?? 0) > config.maxClaims;
    }
    case "connector-silent": {
      const m = await ctx.db
        .query("machines")
        .withIndex("by_machineId", (q) => q.eq("machineId", a.subjectId))
        .unique();
      const silent = m ? await silentMachine(ctx, m, config, now) : null;
      return !!silent && silent.owners.has(a.ownerId);
    }
    case "reminder-blocked": {
      const id = ctx.db.normalizeId("reminders", a.subjectId);
      return (id ? await ctx.db.get(id) : null)?.state === "blocked";
    }
    case "reminder-expired":
      return false;
  }
}
