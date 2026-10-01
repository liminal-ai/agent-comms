// Send-and-wait (capabilities pass §3). A wait is registered in the send's own
// mutation. An answer is taken into the wait in the mutation that collects it
// (or that completes the delivery with `comms reply`): the result goes `open` →
// `answered` and the answer's delivery to the waiter is created and finished in
// that one transaction, so it's never pending, never claimed, and never seen by
// the dispatcher. Every result transition is a compare-and-set on one row.

import {
  ACK_WINDOW_MS,
  type NoWait,
  PRESENCE_STALE_MS,
  type Wait,
  WAIT_HELD_MS,
  WAIT_RETENTION_MS,
} from "@agent-comms/protocol";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { envelope, fail, ref, refById } from "./core";

export const RETURNED_DETAIL = "returned to the waiting send";

/** An agent in a wait that still counts: active, before `until`. */
async function busyWaiting(ctx: QueryCtx, participantId: Id<"participants">, now: number): Promise<boolean> {
  const waits = await ctx.db
    .query("waits")
    .withIndex("by_waiter_active", (q) => q.eq("waiterId", participantId).eq("active", true))
    .collect();
  return waits.some((w) => w.until > now);
}

/**
 * Registers a wait on a just-posted request, unless there's no agent to wait for
 * or an addressed agent is itself busy waiting (then the send goes ahead unwaited).
 */
export async function registerWait(
  ctx: MutationCtx,
  waiter: Doc<"participants">,
  messageId: Id<"messages">,
  waitMs: number,
  now: number,
): Promise<{ wait: Doc<"waits"> } | { noWait: NoWait }> {
  const message = (await ctx.db.get(messageId))!;
  const deliveries = await ctx.db
    .query("deliveries")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  if (deliveries.length === 0) return { noWait: { reason: "nobody-to-wait-for" } };
  const busy: string[] = [];
  for (const d of deliveries) {
    if (await busyWaiting(ctx, d.recipientId, now)) busy.push((await ctx.db.get(d.recipientId))!.name);
  }
  if (busy.length > 0) return { noWait: { reason: "busy-waiting", busy } };
  const people = [];
  for (const id of message.recipientIds) {
    const p = (await ctx.db.get(id))!;
    if (p.kind === "human" && p.state !== "retired") people.push(p._id);
  }
  const waitId = await ctx.db.insert("waits", {
    waiterId: waiter._id,
    messageId,
    until: now + waitMs,
    active: true,
    lastAwaitAt: now,
    inInboxIds: people,
    createdAt: now,
  });
  for (const d of deliveries) {
    await ctx.db.insert("waitResults", { waitId, recipientId: d.recipientId, deliveryId: d._id, state: "open", at: now });
  }
  return { wait: (await ctx.db.get(waitId))! };
}

export async function waitOn(ctx: QueryCtx, waiter: Doc<"participants">, messageId: Id<"messages">): Promise<Doc<"waits"> | null> {
  const waits = await ctx.db
    .query("waits")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  return waits.find((w) => w.waiterId === waiter._id) ?? null;
}

export async function requireWait(ctx: QueryCtx, waiter: Doc<"participants">, messageId: string): Promise<Doc<"waits">> {
  const id = ctx.db.normalizeId("messages", messageId);
  if (!id || !(await ctx.db.get(id))) fail("unknown_message", `no message ${messageId}`);
  const wait = await waitOn(ctx, waiter, id);
  if (!wait) fail("conflict", `@${waiter.name} isn't waiting on ${messageId}`);
  return wait;
}

async function results(ctx: QueryCtx, waitId: Id<"waits">): Promise<Doc<"waitResults">[]> {
  return ctx.db
    .query("waitResults")
    .withIndex("by_wait", (q) => q.eq("waitId", waitId))
    .collect();
}

/** A wait stops counting as busy waiting once no result is open. */
async function settle(ctx: MutationCtx, wait: Doc<"waits">, now: number): Promise<void> {
  if (!wait.active) return;
  if ((await results(ctx, wait._id)).some((r) => r.state === "open")) return;
  await ctx.db.patch(wait._id, { active: false, endedAt: now });
}

/** At or past `until`: every open result expires and the wait stops. */
export async function expireIfDue(ctx: MutationCtx, wait: Doc<"waits">, now: number): Promise<void> {
  if (now < wait.until) return;
  for (const r of await results(ctx, wait._id)) {
    if (r.state === "open") await ctx.db.patch(r._id, { state: "expired", at: now });
  }
  if (wait.active) await ctx.db.patch(wait._id, { active: false, endedAt: wait.endedAt ?? now });
}

/**
 * A request delivery's answer exists (collected, or a `comms reply` that completed
 * it). If a wait holds an open result for that delivery and its CLI is awaiting,
 * the result becomes `answered` and the answer's delivery to the waiter is finished
 * as returned; otherwise the result is `expired` and the answer goes to the thread.
 */
export async function takeAnswer(ctx: MutationCtx, requestDelivery: Doc<"deliveries">, answerId: Id<"messages">, now: number): Promise<void> {
  const result = await ctx.db
    .query("waitResults")
    .withIndex("by_delivery", (q) => q.eq("deliveryId", requestDelivery._id))
    .first();
  if (!result || result.state !== "open") return;
  const wait = (await ctx.db.get(result.waitId))!;
  const held = wait.active && now < wait.until && now - wait.lastAwaitAt <= WAIT_HELD_MS;
  if (!held) {
    await ctx.db.patch(result._id, { state: "expired", at: now });
    await settle(ctx, wait, now);
    return;
  }
  await ctx.db.patch(result._id, { state: "answered", answerMessageId: answerId, at: now });
  const toWaiter = await ctx.db
    .query("deliveries")
    .withIndex("by_message", (q) => q.eq("messageId", answerId))
    .collect();
  for (const d of toWaiter) {
    if (d.recipientId === wait.waiterId && d.state === "pending" && !d.fallback) {
      await ctx.db.patch(d._id, { state: "delivered", at: now, detail: RETURNED_DETAIL });
    }
  }
  await settle(ctx, wait, now);
}

/** A request delivery ended without an answer (failed, uncertain, or its recipient retired). */
export async function endResult(ctx: MutationCtx, deliveryId: Id<"deliveries">, now: number): Promise<void> {
  const result = await ctx.db
    .query("waitResults")
    .withIndex("by_delivery", (q) => q.eq("deliveryId", deliveryId))
    .first();
  if (!result || result.state !== "open") return;
  await ctx.db.patch(result._id, { state: "ended", at: now });
  await settle(ctx, (await ctx.db.get(result.waitId))!, now);
}

/** `await`: the CLI is still there. Expires the wait if its `until` has passed. */
export async function touch(ctx: MutationCtx, wait: Doc<"waits">, now: number): Promise<Doc<"waits">> {
  await ctx.db.patch(wait._id, { lastAwaitAt: now });
  await expireIfDue(ctx, (await ctx.db.get(wait._id))!, now);
  return (await ctx.db.get(wait._id))!;
}

/**
 * The CLI printed these answers. Counts only while the waiter's turn that ran the
 * CLI is still running: busy, not stale, and busy since no later than the wait
 * began. Otherwise ignored, and the result falls back after ACK_WINDOW_MS.
 */
export async function acknowledge(ctx: MutationCtx, wait: Doc<"waits">, names: string[] | undefined, now: number): Promise<void> {
  const waiter = (await ctx.db.get(wait.waiterId))!;
  const machine = waiter.home
    ? await ctx.db
        .query("machines")
        .withIndex("by_machineId", (q) => q.eq("machineId", waiter.home!.machine))
        .unique()
    : null;
  const fresh = machine?.lastSeenAt !== undefined && now - machine.lastSeenAt < PRESENCE_STALE_MS;
  const sameTurn =
    fresh && waiter.presence.status === "busy" && (waiter.presence.busySince ?? waiter.presence.at) <= wait.createdAt;
  if (!sameTurn) return;
  for (const r of await results(ctx, wait._id)) {
    if (r.state !== "answered") continue;
    if (names && !names.includes((await ctx.db.get(r.recipientId))!.name)) continue;
    await ctx.db.patch(r._id, { state: "acknowledged", at: now });
  }
}

/**
 * The minute sweep: answered results past the ack window fall back once into the
 * waiter's thread (compare-and-set `answered` → `fell-back` with the delivery in
 * the same transaction); waits past `until` stop; ended waits past the retention
 * period are deleted. Bounded per run.
 */
export async function sweep(ctx: MutationCtx, now: number): Promise<{ fellBack: number; expired: number; deleted: number }> {
  let fellBack = 0;
  const due = await ctx.db
    .query("waitResults")
    .withIndex("by_state_at", (q) => q.eq("state", "answered").lt("at", now - ACK_WINDOW_MS))
    .take(100);
  for (const r of due) {
    const wait = (await ctx.db.get(r.waitId))!;
    const waiter = (await ctx.db.get(wait.waiterId))!;
    const answer = r.answerMessageId ? await ctx.db.get(r.answerMessageId) : null;
    await ctx.db.patch(r._id, { state: "fell-back", at: now });
    if (answer && waiter.state !== "retired") {
      await ctx.db.insert("deliveries", {
        messageId: answer._id,
        conversationId: answer.conversationId,
        recipientId: waiter._id,
        collect: false,
        state: "pending",
        at: now,
        fallback: true,
        createdAt: now,
      });
    }
    fellBack++;
  }
  let expired = 0;
  const overdue = await ctx.db
    .query("waits")
    .withIndex("by_active_until", (q) => q.eq("active", true).lte("until", now))
    .take(100);
  for (const w of overdue) {
    await expireIfDue(ctx, w, now);
    expired++;
  }
  let deleted = 0;
  const old = await ctx.db
    .query("waits")
    .withIndex("by_endedAt", (q) => q.gt("endedAt", 0).lt("endedAt", now - WAIT_RETENTION_MS))
    .take(100);
  for (const w of old) {
    for (const r of await results(ctx, w._id)) await ctx.db.delete(r._id);
    await ctx.db.delete(w._id);
    deleted++;
  }
  return { fellBack, expired, deleted };
}

export async function waitShape(ctx: QueryCtx, wait: Doc<"waits">): Promise<Wait> {
  const rows = await results(ctx, wait._id);
  return {
    id: wait._id,
    messageId: wait.messageId,
    waiter: await refById(ctx, wait.waiterId),
    until: wait.until,
    active: wait.active && wait.until > Date.now(),
    results: await Promise.all(
      rows.map(async (r) => {
        const d = (await ctx.db.get(r.deliveryId))!;
        const answer = r.answerMessageId ? await ctx.db.get(r.answerMessageId) : null;
        return {
          recipient: ref((await ctx.db.get(r.recipientId))!),
          state: r.state,
          delivery: { id: d._id, state: d.state, ...(d.detail !== undefined ? { detail: d.detail } : {}) },
          ...(answer ? { answer: await envelope(ctx, answer) } : {}),
          at: r.at,
        };
      }),
    ),
    inInbox: await Promise.all(wait.inInboxIds.map((id) => refById(ctx, id))),
    createdAt: wait.createdAt,
  };
}
