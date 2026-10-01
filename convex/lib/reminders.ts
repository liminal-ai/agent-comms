// Reminders (capabilities pass §4): creation rules, state changes, and the
// protocol shapes. Firing (the minute cron) is R3.

import {
  formatDuration,
  type Reminder,
  type ReminderAction,
  REMINDER_DEFAULT_EXPIRY_MS,
  REMINDER_MAX_EXPIRY_MS,
  REMINDER_MIN_INTERVAL_MS,
  type ReminderFire,
  type ReminderSkip,
  type ReminderState,
} from "@agent-comms/protocol";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fail, participantByName, refById } from "./core";

/** How many skips a reminder keeps (newest). */
export const MAX_SKIPS_KEPT = 50;
const MAX_NAME_CHARS = 80;

export interface ReminderInput {
  target: string;
  text: string;
  everyMs?: number;
  at?: number;
  name?: string;
  idleForMs?: number;
  watch?: string;
  max?: number;
  reportTo?: string;
  expiresMs?: number;
}

/** Checks a new reminder (the loopback decoder checks shapes; this checks meaning) and inserts it `active`. */
export async function createReminder(ctx: MutationCtx, creator: Doc<"participants">, input: ReminderInput, now: number): Promise<Doc<"reminders">> {
  if ((input.everyMs === undefined) === (input.at === undefined)) fail("bad_request", "give exactly one of --every and --at");
  if (input.everyMs !== undefined && input.everyMs < REMINDER_MIN_INTERVAL_MS) {
    fail("bad_request", `--every is at least ${formatDuration(REMINDER_MIN_INTERVAL_MS)}`);
  }
  const expiresMs = input.expiresMs ?? REMINDER_DEFAULT_EXPIRY_MS;
  if (expiresMs < REMINDER_MIN_INTERVAL_MS || expiresMs > REMINDER_MAX_EXPIRY_MS) {
    fail("bad_request", `--expires is between ${formatDuration(REMINDER_MIN_INTERVAL_MS)} and ${formatDuration(REMINDER_MAX_EXPIRY_MS)}`);
  }
  const expiresAt = now + expiresMs;
  if (input.at !== undefined && (input.at <= now || input.at > expiresAt)) fail("bad_request", "--at must be in the future and before the reminder expires");
  if (input.text.trim().length === 0) fail("bad_request", "a reminder needs text");
  if (input.max !== undefined && (!Number.isInteger(input.max) || input.max < 1)) fail("bad_request", "--max is at least 1");
  if (input.idleForMs !== undefined && input.idleForMs < 0) fail("bad_request", "--idle-for can't be negative");

  const target = await participantByName(ctx, input.target);
  if (target.kind !== "agent") fail("bad_request", `@${target.name} isn't an agent; reminders wake agents`);
  if (target.state === "retired") fail("bad_request", `@${target.name} is retired`);
  const watch = input.watch !== undefined ? await participantByName(ctx, input.watch) : undefined;
  if (watch && watch.kind !== "agent") fail("bad_request", `@${watch.name} isn't an agent; only agents have presence to watch`);
  const reportTo = input.reportTo !== undefined ? await participantByName(ctx, input.reportTo) : undefined;
  if (reportTo && reportTo.kind === "system") fail("bad_request", `@${reportTo.name} can't be reported to`);

  const name = (input.name ?? input.text.split(/\s+/).slice(0, 4).join(" ")).trim().slice(0, MAX_NAME_CHARS);
  const id = await ctx.db.insert("reminders", {
    name,
    text: input.text,
    targetId: target._id,
    createdById: creator._id,
    ...(input.everyMs !== undefined ? { everyMs: input.everyMs } : {}),
    ...(input.at !== undefined ? { at: input.at } : {}),
    ...(input.idleForMs !== undefined ? { idleForMs: input.idleForMs } : {}),
    ...(watch ? { watchId: watch._id } : {}),
    ...(input.max !== undefined ? { max: input.max } : {}),
    ...(reportTo ? { reportToId: reportTo._id } : {}),
    state: "active",
    stateAt: now,
    fires: 0,
    nextFireAt: input.at ?? now + input.everyMs!,
    expiresAt,
    skips: [],
    createdAt: now,
  });
  return (await ctx.db.get(id))!;
}

const FINAL: readonly ReminderState[] = ["done", "cancelled", "expired"];

/** The state an action moves a reminder to, or a `conflict`. Pausing or cancelling stops future fires only. */
export function afterAction(r: Doc<"reminders">, action: ReminderAction, reason: string | undefined): { state: ReminderState; stateReason?: string } {
  if (FINAL.includes(r.state)) fail("conflict", `reminder ${r._id} is ${r.state}`);
  switch (action) {
    case "pause":
      return { state: "paused" };
    case "resume":
      if (r.state === "active") fail("conflict", `reminder ${r._id} is already active`);
      return { state: "active" };
    case "blocked":
      if (!reason || reason.trim().length === 0) fail("bad_request", "say why it's blocked");
      return { state: "blocked", stateReason: reason.trim().slice(0, 2000) };
    case "done":
      return { state: "done", ...(reason ? { stateReason: reason.trim().slice(0, 2000) } : {}) };
    case "cancel":
      return { state: "cancelled", ...(reason ? { stateReason: reason.trim().slice(0, 2000) } : {}) };
  }
}

export async function applyAction(ctx: MutationCtx, r: Doc<"reminders">, action: ReminderAction, reason: string | undefined, now: number) {
  const next = afterAction(r, action, reason);
  await ctx.db.patch(r._id, { state: next.state, stateReason: next.stateReason, stateAt: now });
  return (await ctx.db.get(r._id))!;
}

export async function reminderShape(ctx: QueryCtx, r: Doc<"reminders">): Promise<Reminder> {
  const last = await ctx.db
    .query("reminderFires")
    .withIndex("by_reminder", (q) => q.eq("reminderId", r._id))
    .order("desc")
    .first();
  const lastDelivery = last ? await ctx.db.get(last.deliveryId) : null;
  const lastSkip = r.skips[r.skips.length - 1];
  return {
    ...(last ? { lastFire: { messageId: last.messageId, deliveryState: lastDelivery?.state ?? "failed", firedAt: last.firedAt } } : {}),
    ...(lastSkip ? { lastSkip } : {}),
    id: r._id,
    name: r.name,
    text: r.text,
    target: await refById(ctx, r.targetId),
    createdBy: await refById(ctx, r.createdById),
    schedule: r.everyMs !== undefined ? { everyMs: r.everyMs } : { at: r.at! },
    ...(r.idleForMs !== undefined ? { idleForMs: r.idleForMs } : {}),
    ...(r.watchId ? { watch: await refById(ctx, r.watchId) } : {}),
    ...(r.max !== undefined ? { max: r.max } : {}),
    ...(r.reportToId ? { reportTo: await refById(ctx, r.reportToId) } : {}),
    state: r.state,
    ...(r.stateReason !== undefined ? { stateReason: r.stateReason } : {}),
    stateAt: r.stateAt,
    fires: r.fires,
    ...(r.nextFireAt !== undefined ? { nextFireAt: r.nextFireAt } : {}),
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  };
}

/** A reminder with its fires (newest first, up to `limit`) and kept skips (newest first). */
export async function reminderDetail(ctx: QueryCtx, r: Doc<"reminders">, limit = 50): Promise<{ reminder: Reminder; fires: ReminderFire[]; skips: ReminderSkip[] }> {
  const rows = await ctx.db
    .query("reminderFires")
    .withIndex("by_reminder", (q) => q.eq("reminderId", r._id))
    .order("desc")
    .take(limit);
  const fires: ReminderFire[] = [];
  for (const f of rows) {
    const delivery = await ctx.db.get(f.deliveryId);
    const answer = f.answerMessageId ? await ctx.db.get(f.answerMessageId) : null;
    fires.push({
      reminderId: r._id,
      messageId: f.messageId,
      deliveryId: f.deliveryId,
      deliveryState: delivery?.state ?? "failed",
      firedAt: f.firedAt,
      ...(answer ? { answer: { messageId: answer._id, text: answer.text, at: f.answeredAt ?? answer.createdAt } } : {}),
    });
  }
  return { reminder: await reminderShape(ctx, r), fires, skips: [...r.skips].reverse() };
}

export type ReminderId = Id<"reminders">;
