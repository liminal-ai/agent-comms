// Reminders (capabilities pass §4): creation rules, state changes, and the
// protocol shapes. Firing (the minute cron) is R3.

import {
  formatDuration,
  formatSchedule,
  MAX_TEXT_CHARS,
  type MessageMeta,
  PRESENCE_STALE_MS,
  renderReminderEnded,
  renderReminderReport,
  type Reminder,
  type ReminderAction,
  REMINDER_DEFAULT_EXPIRY_MS,
  REMINDER_MAX_EXPIRY_MS,
  REMINDER_MIN_INTERVAL_MS,
  type ReminderFire,
  type ReminderSkip,
  type ReminderState,
} from "@agent-comms/protocol";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fail, participantByName, refById } from "./core";
import { openDm, post } from "./post";

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
  // Fix pass 2: finite whole numbers before any range check (NaN and Infinity pass `<` checks).
  for (const [flag, value] of [["--every", input.everyMs], ["--at", input.at], ["--idle-for", input.idleForMs], ["--max", input.max], ["--expires", input.expiresMs]] as const) {
    if (value !== undefined && !Number.isSafeInteger(value)) fail("bad_request", `${flag} must be a whole number`);
  }
  // Fix pass 2: a name is one line of printable characters, at most 80.
  if (input.name !== undefined && (/[\u0000-\u001f\u007f\u2028\u2029]/.test(input.name) || input.name.trim().length === 0 || input.name.length > MAX_NAME_CHARS)) {
    fail("bad_request", `a reminder's name is one line of 1-${MAX_NAME_CHARS} printable characters`);
  }
  if (input.text.trim().length === 0) fail("bad_request", "a reminder needs text");
  if (input.text.length > MAX_TEXT_CHARS) fail("bad_request", `a reminder's text is at most ${MAX_TEXT_CHARS} characters (this is ${input.text.length})`);
  if (input.max !== undefined && (!Number.isInteger(input.max) || input.max < 1)) fail("bad_request", "--max is at least 1");
  if (input.idleForMs !== undefined && input.idleForMs < 0) fail("bad_request", "--idle-for can't be negative");

  const target = await participantByName(ctx, input.target);
  if (target.kind !== "agent") fail("bad_request", `@${target.name} isn't an agent; reminders wake agents`);
  if (target.state === "retired") fail("bad_request", `@${target.name} is retired`);
  const watch = input.watch !== undefined ? await participantByName(ctx, input.watch) : undefined;
  if (watch && watch.kind !== "agent") fail("bad_request", `@${watch.name} isn't an agent; only agents have presence to watch`);
  if (watch && watch.state === "retired") fail("bad_request", `@${watch.name} is retired`);
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

/**
 * Applies an action. `actor` is who did it (absent from the web view): the
 * creator is told when a reminder ends, unless they ended it themselves.
 */
export async function applyAction(
  ctx: MutationCtx,
  r: Doc<"reminders">,
  action: ReminderAction,
  reason: string | undefined,
  now: number,
  actor?: Doc<"participants">,
) {
  const next = afterAction(r, action, reason);
  await ctx.db.patch(r._id, {
    state: next.state,
    stateReason: next.stateReason,
    stateAt: now,
    ...(next.state === "done" || next.state === "cancelled" ? { nextFireAt: undefined } : {}),
  });
  const updated = (await ctx.db.get(r._id))!;
  if ((next.state === "done" || next.state === "cancelled") && actor?._id !== r.createdById) await tellEnded(ctx, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Firing (the minute cron)

const MINUTE = 60_000;

async function system(ctx: MutationCtx, name: "reminders"): Promise<Doc<"participants">> {
  const p = await ctx.db
    .query("participants")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (!p || p.kind !== "system") throw new Error(`@${name} is missing: run scripts/upgrade.ts after deploying`);
  return p;
}

/**
 * Posts a notice from @reminders to a participant in their DM: people get it in
 * their inbox, agents a delivery that ends at `delivered` and is never collected.
 */
async function notify(ctx: MutationCtx, to: Doc<"participants">, text: string, meta: MessageMeta): Promise<Id<"messages"> | undefined> {
  if (to.kind === "system" || to.state === "retired") return undefined;
  const from = await system(ctx, "reminders");
  const conversation = await openDm(ctx, from, to);
  const sent = await post(ctx, {
    sender: from,
    conversation,
    recipients: [to],
    kind: "notice",
    text,
    origin: { via: "system" },
    meta,
  });
  return sent.message.id as Id<"messages">;
}

async function tellEnded(ctx: MutationCtx, r: Doc<"reminders">): Promise<void> {
  if (r.state !== "done" && r.state !== "cancelled" && r.state !== "expired") return;
  const creator = (await ctx.db.get(r.createdById))!;
  const input = { reminderName: r.name, reminderId: r._id, state: r.state, ...(r.stateReason ? { reason: r.stateReason } : {}) };
  await notify(ctx, creator, renderReminderEnded(input), {
    type: "reminder-ended",
    reminderId: r._id,
    name: r.name,
    state: r.state,
    ...(r.stateReason ? { reason: r.stateReason } : {}),
  });
}

async function skip(ctx: MutationCtx, r: Doc<"reminders">, entry: ReminderSkip, nextFireAt: number): Promise<void> {
  const skips = [...r.skips, entry].slice(-MAX_SKIPS_KEPT);
  await ctx.db.patch(r._id, { skips, nextFireAt });
}

/** The next scheduled slot after `now` (repeating reminders keep their rhythm through skips). */
function nextSlot(r: Doc<"reminders">, now: number): number {
  let next = r.nextFireAt ?? now;
  while (next <= now) next += r.everyMs!;
  return next;
}

/** Final for the no-pile-up rule: not pending, claimed or delivered; ambiguous only after one interval. */
async function previousFireFinal(ctx: QueryCtx, r: Doc<"reminders">, now: number): Promise<boolean> {
  const last = await ctx.db
    .query("reminderFires")
    .withIndex("by_reminder", (q) => q.eq("reminderId", r._id))
    .order("desc")
    .first();
  if (!last) return true;
  const d = await ctx.db.get(last.deliveryId);
  if (!d) return true;
  if (d.state === "pending" || d.state === "claimed" || d.state === "delivered") return false;
  if (d.state === "ambiguous") return now - d.at >= (r.everyMs ?? MINUTE);
  return true;
}

/** Why the idle condition blocks a fire now, if it does. */
async function idleBlock(ctx: QueryCtx, r: Doc<"reminders">, now: number): Promise<ReminderSkip | null> {
  if (r.idleForMs === undefined) return null;
  const watched = (await ctx.db.get(r.watchId ?? r.targetId))!;
  const machine = watched.home
    ? await ctx.db
        .query("machines")
        .withIndex("by_machineId", (q) => q.eq("machineId", watched.home!.machine))
        .unique()
    : null;
  if (machine?.lastSeenAt === undefined || now - machine.lastSeenAt >= PRESENCE_STALE_MS) {
    return { at: now, reason: "presence-stale", detail: `@${watched.name}'s connector hasn't been heard from` };
  }
  const p = watched.presence;
  const since = p.status === "idle" ? (p.idleSince ?? p.at) : undefined;
  if (since === undefined || now - since < r.idleForMs) {
    return { at: now, reason: "not-idle", detail: `@${watched.name} is ${p.status}${since !== undefined ? ` for ${formatDuration(now - since)}` : ""}` };
  }
  return null;
}

async function fire(ctx: MutationCtx, r: Doc<"reminders">, target: Doc<"participants">, now: number): Promise<void> {
  const from = await system(ctx, "reminders");
  const creator = (await ctx.db.get(r.createdById))!;
  const conversation = await openDm(ctx, from, target);
  const fireNumber = r.fires + 1;
  const schedule = r.everyMs !== undefined ? { everyMs: r.everyMs } : { at: r.at! };
  const result = await post(ctx, {
    sender: from,
    conversation,
    recipients: [target],
    kind: "request",
    text: r.text,
    origin: { via: "system" },
    meta: {
      type: "reminder",
      reminderId: r._id,
      name: r.name,
      setBy: creator.name,
      schedule: formatSchedule(schedule),
      fire: fireNumber,
      ...(r.reportToId ? { reportTo: (await ctx.db.get(r.reportToId))!.name } : {}),
    },
  });
  // Test hook (fix pass 1.4): a failure after the fire's message and delivery are written.
  if (process.env.COMMS_TEST_FAULT === `reminder-fire-after-post:${r._id}`) throw new Error("injected failure after the fire's message was posted");
  const delivery = result.deliveries[0];
  if (delivery) {
    await ctx.db.insert("reminderFires", {
      reminderId: r._id,
      messageId: result.message.id as Id<"messages">,
      deliveryId: delivery.id as Id<"deliveries">,
      firedAt: now,
    });
  }
  const maxed = r.max !== undefined && fireNumber >= r.max;
  if (r.everyMs === undefined) {
    await ctx.db.patch(r._id, { fires: fireNumber, nextFireAt: undefined, state: "done", stateReason: "fired once", stateAt: now });
  } else if (maxed) {
    await ctx.db.patch(r._id, {
      fires: fireNumber,
      nextFireAt: undefined,
      state: "done",
      stateReason: `fired ${fireNumber} time${fireNumber === 1 ? "" : "s"} (--max ${r.max})`,
      stateAt: now,
    });
    await tellEnded(ctx, (await ctx.db.get(r._id))!);
  } else {
    await ctx.db.patch(r._id, { fires: fireNumber, nextFireAt: nextSlot(r, now) });
  }
}

async function expire(ctx: MutationCtx, r: Doc<"reminders">, now: number): Promise<void> {
  await ctx.db.patch(r._id, { state: "expired", stateAt: now, nextFireAt: undefined });
  await tellEnded(ctx, (await ctx.db.get(r._id))!);
}

/** The minute cron: expiries first, then due reminders (bounded per run). */
export async function tick(ctx: MutationCtx, now: number): Promise<{ fired: number; skipped: number; expired: number }> {
  let expired = 0;
  // Live states only (fix pass 1.3): finished reminders are never read here.
  for (const state of ["active", "paused", "blocked"] as const) {
    for (const r of await ctx.db
      .query("reminders")
      .withIndex("by_state_expires", (q) => q.eq("state", state).lte("expiresAt", now))
      .take(100)) {
      await expire(ctx, r, now);
      expired++;
    }
  }
  let fired = 0;
  let skipped = 0;
  const due = await ctx.db
    .query("reminders")
    .withIndex("by_state_next", (q) => q.eq("state", "active").lte("nextFireAt", now))
    .take(50);
  for (const r of due) {
    // Each reminder in its own sub-transaction (fix pass 1.4): if anything throws, all of that
    // reminder's writes are rolled back, it alone is blocked with the error, and the tick goes on.
    try {
      const outcome: Step = await ctx.runMutation(internal.reminders.step, { id: r._id });
      if (outcome === "fired") fired++;
      else if (outcome === "skipped") skipped++;
      else if (outcome === "expired") expired++;
    } catch (error) {
      const message = error instanceof ConvexError ? (error.data as { message?: string }).message : (error as Error).message;
      await ctx.db.patch(r._id, { state: "blocked", stateReason: `the fire failed: ${String(message ?? error).slice(0, 1_000)}`, stateAt: now });
    }
  }
  return { fired, skipped, expired };
}

export type Step = "fired" | "skipped" | "expired" | "ended" | "none";

/** One due reminder's turn in the tick: expire, cancel, skip or fire it. Run as its own sub-transaction. */
export async function step(ctx: MutationCtx, id: Id<"reminders">, now: number): Promise<Step> {
  const r = await ctx.db.get(id);
  if (!r || r.state !== "active" || r.nextFireAt === undefined || r.nextFireAt > now) return "none";
  // The firing loop checks expiry itself (fix pass 1.3), whatever the expiry scan reached.
  if (r.expiresAt <= now) {
    await expire(ctx, r, now);
    return "expired";
  }
  const target = (await ctx.db.get(r.targetId))!;
  if (target.state === "retired") {
    await ctx.db.patch(r._id, { state: "cancelled", stateReason: `@${target.name} was retired`, stateAt: now, nextFireAt: undefined });
    await tellEnded(ctx, (await ctx.db.get(r._id))!);
    return "ended";
  }
  const watched = r.watchId ? await ctx.db.get(r.watchId) : null;
  if (watched?.state === "retired") {
    await ctx.db.patch(r._id, { state: "cancelled", stateReason: `@${watched.name} (watched) was retired`, stateAt: now, nextFireAt: undefined });
    await tellEnded(ctx, (await ctx.db.get(r._id))!);
    return "ended";
  }
  if (!(await previousFireFinal(ctx, r, now))) {
    await skip(ctx, r, { at: now, reason: "previous-fire-not-final" }, r.everyMs !== undefined ? nextSlot(r, now) : now + MINUTE);
    return "skipped";
  }
  const blocked = await idleBlock(ctx, r, now);
  if (blocked) {
    await skip(ctx, r, blocked, now + MINUTE);
    return "skipped";
  }
  await fire(ctx, r, target, now);
  return "fired";
}

/** A fire's request was answered (collected, or completed with `comms reply`): record it, and report it. */
export async function recordFireAnswer(ctx: MutationCtx, requestDelivery: Doc<"deliveries">, answerId: Id<"messages">, now: number): Promise<void> {
  const f = await ctx.db
    .query("reminderFires")
    .withIndex("by_message", (q) => q.eq("messageId", requestDelivery.messageId))
    .first();
  if (!f || f.answerMessageId) return;
  await ctx.db.patch(f._id, { answerMessageId: answerId, answeredAt: now });
  const r = await ctx.db.get(f.reminderId);
  if (!r?.reportToId) return;
  // The report runs in its own sub-transaction (fix pass 1.5): if it fails, its writes are
  // rolled back and the answer (collected or replied) stands. It's tried once per answer.
  try {
    await ctx.runMutation(internal.reminders.report, { fireId: f._id });
  } catch (error) {
    const message = error instanceof ConvexError ? (error.data as { message?: string }).message : (error as Error).message;
    await ctx.db.patch(f._id, { reportError: String(message ?? error).slice(0, 1_000) });
  }
}

/** Posts a fire's answer to the reminder's report-to, clipped to fit (fix pass 1.5). */
export async function report(ctx: MutationCtx, fireId: Id<"reminderFires">): Promise<void> {
  const f = (await ctx.db.get(fireId))!;
  const r = (await ctx.db.get(f.reminderId))!;
  if (!r.reportToId || !f.answerMessageId || f.reportMessageId) return;
  const reportTo = (await ctx.db.get(r.reportToId))!;
  const target = (await ctx.db.get(r.targetId))!;
  const answer = (await ctx.db.get(f.answerMessageId))!;
  const text = clippedReport(r, target.name, answer);
  const posted = await notify(ctx, reportTo, text, {
    type: "reminder-report",
    reminderId: r._id,
    name: r.name,
    target: target.name,
    fireMessageId: f.messageId,
  });
  // Test hook (fix pass 1.5): a failure after the report is written.
  if (process.env.COMMS_TEST_FAULT === `reminder-report-after-post:${r._id}`) throw new Error("injected failure after the report was posted");
  if (posted) await ctx.db.patch(f._id, { reportMessageId: posted });
}

/** The report text, the answer cut so the whole fits MAX_TEXT_CHARS, saying where the full answer is. */
function clippedReport(r: Doc<"reminders">, target: string, answer: Doc<"messages">): string {
  const base = { reminderName: r.name, reminderId: r._id, target };
  let text = renderReminderReport({ ...base, answer: answer.text });
  if (text.length <= MAX_TEXT_CHARS) return text;
  let keep = answer.text.length - (text.length - MAX_TEXT_CHARS) - 400;
  for (;;) {
    const note = `[… ${answer.text.length - keep} more characters; the full answer is message ${answer._id} in conversation ${answer.conversationId}]`;
    text = `${renderReminderReport({ ...base, answer: answer.text.slice(0, Math.max(0, keep)) })}\n${note}`;
    if (text.length <= MAX_TEXT_CHARS || keep <= 0) return text.slice(0, MAX_TEXT_CHARS);
    keep -= text.length - MAX_TEXT_CHARS + 100;
  }
}

/** Who may read a reminder (fix pass 0.4): those who may change it, and its report-to. */
export async function mayRead(ctx: QueryCtx, r: Doc<"reminders">, who: Doc<"participants">): Promise<boolean> {
  return r.reportToId === who._id || (await mayChange(ctx, r, who));
}

/** Who may change a reminder: its creator, its target, and the target's owner. */
export async function mayChange(ctx: QueryCtx, r: Doc<"reminders">, who: Doc<"participants">): Promise<boolean> {
  if (who._id === r.createdById || who._id === r.targetId) return true;
  const target = await ctx.db.get(r.targetId);
  return target?.ownerId === who._id;
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
