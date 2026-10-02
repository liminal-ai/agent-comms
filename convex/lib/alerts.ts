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

/** How far back the scan looks for deliveries that entered `uncertain` and reminders that expired. Well over the cron period. */
const RECENT_MS = 60 * 60_000;

/**
 * The scan (fix pass 1.3: live rows only, never finished history). New incidents: deliveries
 * that became `uncertain` within RECENT_MS, in-flight deliveries claimed too often, silent
 * machines, reminders blocked too long, reminders expired within RECENT_MS. Each open
 * incident is then checked against its own subject, so one older than the scan window
 * stays open until its condition actually clears.
 */
export async function scan(ctx: MutationCtx, now: number): Promise<{ opened: number; resolved: number }> {
  const config = await alertConfig(ctx);
  const holding: Condition[] = [];
  const ownerOf = async (participantId: Id<"participants">) => (await ctx.db.get(participantId))?.ownerId;

  for (const d of await ctx.db
    .query("deliveries")
    .withIndex("by_state_at", (q) => q.eq("state", "uncertain").gte("at", now - RECENT_MS))
    .take(200)) {
    const ownerId = await ownerOf(d.recipientId);
    if (ownerId) holding.push({ cause: "uncertain-delivery", subjectKind: "delivery", subjectId: d._id, ownerId, subjectConversationId: d.conversationId, ...(d.detail ? { detail: d.detail } : {}) });
  }

  for (const [state, collect] of [["claimed", true], ["claimed", false], ["delivered", true]] as const) {
    for (const d of await ctx.db
      .query("deliveries")
      .withIndex("by_state_collect", (q) => q.eq("state", state).eq("collect", collect))
      .take(500)) {
      if ((d.claimCount ?? 0) <= config.maxClaims) continue;
      const ownerId = await ownerOf(d.recipientId);
      if (ownerId) {
        holding.push({ cause: "delivery-reclaimed", subjectKind: "delivery", subjectId: d._id, ownerId, subjectConversationId: d.conversationId, detail: `claimed ${d.claimCount} times` });
      }
    }
  }

  for (const m of await ctx.db.query("machines").collect()) {
    const silent = await silentMachine(ctx, m, config, now);
    if (!silent) continue;
    for (const ownerId of silent.owners) {
      holding.push({ cause: "connector-silent", subjectKind: "machine", subjectId: m.machineId, ownerId, detail: silent.detail });
    }
  }

  for (const r of await ctx.db
    .query("reminders")
    .withIndex("by_state_stateAt", (q) => q.eq("state", "blocked").lte("stateAt", now - config.reminderBlockedMs))
    .take(200)) {
    const ownerId = await ownerOf(r.targetId);
    if (ownerId) holding.push({ cause: "reminder-blocked", subjectKind: "reminder", subjectId: r._id, ownerId, ...(r.stateReason ? { detail: r.stateReason } : {}) });
  }
  for (const r of await ctx.db
    .query("reminders")
    .withIndex("by_state_stateAt", (q) => q.eq("state", "expired").gte("stateAt", now - RECENT_MS))
    .take(200)) {
    const ownerId = await ownerOf(r.targetId);
    if (ownerId) holding.push({ cause: "reminder-expired", subjectKind: "reminder", subjectId: r._id, ownerId, detail: `"${r.name}", ${r.fires} fire${r.fires === 1 ? "" : "s"}`, event: true });
  }

  let opened = 0;
  for (const c of holding) if (await open(ctx, c, now)) opened++;

  let resolved = 0;
  for (const a of await ctx.db
    .query("alerts")
    .withIndex("by_resolved", (q) => q.eq("resolvedAt", undefined))
    .take(500)) {
    if (await stillHolds(ctx, a, config, now)) continue;
    await ctx.db.patch(a._id, { resolvedAt: now });
    resolved++;
  }
  return { opened, resolved };
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
