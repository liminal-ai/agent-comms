// Send-and-wait (capabilities pass §3). A wait is registered in the send's own
// mutation. An answer is taken into the wait in the mutation that collects it
// (or that completes the delivery with `comms reply`): the result goes `open` →
// `answered` and the answer's delivery to the waiter is created and finished in
// that one transaction, so it's never pending, never claimed, and never seen by
// the dispatcher. Every result transition is a compare-and-set on one row.

import {
  ACK_WINDOW_MS,
  type AnswerProof,
  type NoWait,
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
  return waits.some((w) => w.until > now && now - w.lastAwaitAt <= WAIT_HELD_MS);
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
  waiterTurnId?: string,
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
    ...(waiterTurnId !== undefined ? { waiterTurnId } : {}),
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

/**
 * Ends a wait once (fix pass 0.2): it stops counting as busy waiting, its open results
 * expire, and `endedAt`, from which the fallback window runs, is set and never moved.
 */
async function end(ctx: MutationCtx, wait: Doc<"waits">, endedAt: number): Promise<void> {
  if (!wait.active) return;
  for (const r of await results(ctx, wait._id)) {
    if (r.state === "open") await ctx.db.patch(r._id, { state: "expired", at: endedAt });
  }
  await ctx.db.patch(wait._id, { active: false, endedAt });
  // Follow-up (a): each answered result's fallback falls due a window after the wait ended.
  for (const r of await results(ctx, wait._id)) {
    if (r.state === "answered") await ctx.db.patch(r._id, { fallbackDueAt: endedAt + ACK_WINDOW_MS });
  }
}

/** A wait ends once no result is open. */
async function settle(ctx: MutationCtx, wait: Doc<"waits">, now: number): Promise<void> {
  if (!wait.active) return;
  if ((await results(ctx, wait._id)).some((r) => r.state === "open")) return;
  await end(ctx, wait, now);
}

/** Ends a wait whose `until` has passed, or whose CLI stopped checking in (no `await` for WAIT_HELD_MS). */
export async function expireIfDue(ctx: MutationCtx, wait: Doc<"waits">, now: number): Promise<void> {
  if (!wait.active) return;
  const stale = wait.lastAwaitAt + WAIT_HELD_MS;
  if (now >= wait.until || now > stale) await end(ctx, wait, Math.min(wait.until, stale));
}

/** 32 random hex characters. */
function proofToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
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
  await expireIfDue(ctx, wait, now);
  if (!(await ctx.db.get(wait._id))!.active) return; // ended: its open results expired, and the answer goes to the thread
  await ctx.db.patch(result._id, { state: "answered", answerMessageId: answerId, proofToken: proofToken(), at: now });
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

/**
 * `await`: the CLI is still there. A wait that already ended (its `until`, or a gap in
 * check-ins longer than WAIT_HELD_MS) stays ended; its `endedAt` doesn't move.
 */
export async function touch(ctx: MutationCtx, wait: Doc<"waits">, now: number): Promise<Doc<"waits">> {
  await expireIfDue(ctx, wait, now);
  const current = (await ctx.db.get(wait._id))!;
  if (current.active) await ctx.db.patch(wait._id, { lastAwaitAt: now });
  return (await ctx.db.get(wait._id))!;
}

/** The CLI's `ack` (fix pass 0.1): provisional. Records that it printed the answers; the state doesn't change. */
export async function markPrinted(ctx: MutationCtx, wait: Doc<"waits">, names: string[] | undefined, now: number): Promise<void> {
  for (const r of await results(ctx, wait._id)) {
    if (r.state !== "answered" || r.printedAt !== undefined) continue;
    if (names && !names.includes((await ctx.db.get(r.recipientId))!.name)) continue;
    await ctx.db.patch(r._id, { printedAt: now });
  }
}

/**
 * The harness saw these proofs in a tool result of main turn `turnId` (fix pass 0.1).
 * Each confirms its result only if the wait is the waiter's, was created in that turn,
 * the token matches, and the result is still `answered` (then `acknowledged`). Anything
 * else is ignored. Harness-neutral: it doesn't know who reported.
 */
export async function confirm(ctx: MutationCtx, waiter: Doc<"participants">, turnId: string, proofs: AnswerProof[], now: number): Promise<number> {
  let confirmed = 0;
  for (const p of proofs) {
    const waitId = ctx.db.normalizeId("waits", p.waitId);
    const wait = waitId ? await ctx.db.get(waitId) : null;
    if (!wait || wait.waiterId !== waiter._id || wait.waiterTurnId === undefined || wait.waiterTurnId !== turnId) continue;
    for (const r of await results(ctx, wait._id)) {
      if (r.state !== "answered" || r.answerMessageId !== p.messageId || r.proofToken !== p.token) continue;
      await ctx.db.patch(r._id, { state: "acknowledged", at: now });
      confirmed++;
    }
  }
  return confirmed;
}

/**
 * The minute sweep: ends waits past `until` or whose CLI stopped checking in; makes
 * each `answered` result whose wait ended at least ACK_WINDOW_MS ago fall back once
 * into the waiter's thread (compare-and-set `answered` → `fell-back` with the delivery
 * in the same transaction); deletes ended waits past the retention period. Every scan
 * reads live rows only (the `answered` and active indexes), never the finished history.
 */
export async function sweep(ctx: MutationCtx, now: number): Promise<{ fellBack: number; expired: number; deleted: number }> {
  let expired = 0;
  for (const w of await ctx.db
    .query("waits")
    .withIndex("by_active_until", (q) => q.eq("active", true).lte("until", now))
    .take(200)) {
    await expireIfDue(ctx, w, now);
    expired++;
  }
  for (const w of await ctx.db
    .query("waits")
    .withIndex("by_active_lastAwait", (q) => q.eq("active", true).lt("lastAwaitAt", now - WAIT_HELD_MS))
    .take(200)) {
    await expireIfDue(ctx, w, now);
    expired++;
  }
  let fellBack = 0;
  // Follow-up (a): only results that are due; answered results of waits still running have no due time.
  for (const r of await ctx.db
    .query("waitResults")
    .withIndex("by_state_due", (q) => q.eq("state", "answered").gt("fallbackDueAt", 0).lte("fallbackDueAt", now))
    .take(500)) {
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

/** A wait as the protocol shows it. `withProofTokens` only for the waiter's own `send` and `await` (fix pass 0.1). */
export async function waitShape(ctx: QueryCtx, wait: Doc<"waits">, options: { withProofTokens?: boolean } = {}): Promise<Wait> {
  const rows = await results(ctx, wait._id);
  return {
    id: wait._id,
    messageId: wait.messageId,
    waiter: await refById(ctx, wait.waiterId),
    until: wait.until,
    active: wait.active && wait.until > Date.now() && Date.now() - wait.lastAwaitAt <= WAIT_HELD_MS,
    ...(wait.endedAt !== undefined ? { endedAt: wait.endedAt } : {}),
    ...(wait.waiterTurnId !== undefined ? { waiterTurnId: wait.waiterTurnId } : {}),
    results: await Promise.all(
      rows.map(async (r) => {
        const d = (await ctx.db.get(r.deliveryId))!;
        const answer = r.answerMessageId ? await ctx.db.get(r.answerMessageId) : null;
        return {
          recipient: ref((await ctx.db.get(r.recipientId))!),
          state: r.state,
          delivery: { id: d._id, state: d.state, ...(d.detail !== undefined ? { detail: d.detail } : {}) },
          ...(answer ? { answer: await envelope(ctx, answer) } : {}),
          ...(options.withProofTokens && r.state === "answered" && r.proofToken ? { proofToken: r.proofToken } : {}),
          ...(r.printedAt !== undefined ? { printedAt: r.printedAt } : {}),
          at: r.at,
        };
      }),
    ),
    inInbox: await Promise.all(wait.inInboxIds.map((id) => refById(ctx, id))),
    createdAt: wait.createdAt,
  };
}

/**
 * Follow-up (a), for `directory.upgrade`: answered results from before due times existed,
 * whose wait has ended, get theirs. Few at any time (they live minutes). Returns how many.
 */
export async function backfillFallbackDue(ctx: MutationCtx): Promise<number> {
  let n = 0;
  for (const r of await ctx.db
    .query("waitResults")
    .withIndex("by_state_due", (q) => q.eq("state", "answered").eq("fallbackDueAt", undefined))
    .take(500)) {
    const wait = await ctx.db.get(r.waitId);
    if (wait?.endedAt === undefined) continue;
    await ctx.db.patch(r._id, { fallbackDueAt: wait.endedAt + ACK_WINDOW_MS });
    n++;
  }
  return n;
}
