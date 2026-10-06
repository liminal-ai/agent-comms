// Pure rules: what an inbox item looks like for a delivery, what to answer a
// restart check, and how Grok Bot answers each kind of item. No I/O, so the
// unit tests cover them directly.

import {
  type Delivery,
  type DeliveryCheck,
  MAX_REPORTED_ANSWER_CHARS,
  MAX_TEXT_CHARS,
  type OutcomeBody,
  renderDelivery,
  renderUnmatchedNotice,
} from "@agent-comms/protocol";
import { DONE_STATES, type InboxItem, type ItemState } from "./store.ts";

/** The turn id the bridge reports for a delivery: one "turn" per delivery. */
export function turnIdFor(deliveryId: string): string {
  return `grok-${deliveryId}`;
}

/** The `ambiguous` origin reported when a request isn't answered in time. */
export const TIMEOUT_ORIGIN = "grokbot-answer-timeout";

/** Idempotency key for a late answer sent with `reply`, so a retried send posts once. */
export function replyKeyFor(deliveryId: string): string {
  return `grokbot-${deliveryId}`.slice(0, 128);
}

export function commsReplyHint(item: Pick<InboxItem, "recipient" | "messageId">): string {
  return `comms reply --as ${item.recipient} ${item.messageId} "<your answer>"`;
}

export function newItem(delivery: Delivery, options: { now: number; answerTimeoutMs: number }): InboxItem {
  const request = delivery.message.kind === "request";
  const at = new Date(options.now).toISOString();
  return {
    v: 1,
    deliveryId: delivery.id,
    messageId: delivery.message.id,
    kind: delivery.message.kind,
    expectsReply: request,
    from: delivery.message.sender,
    recipient: delivery.recipient.name,
    conversation: delivery.conversation,
    ...(delivery.message.inReplyTo ? { inReplyTo: delivery.message.inReplyTo } : {}),
    text: delivery.message.text,
    // Grok Bot's harness doesn't label where text came from, so the rendering carries its own source line.
    rendered: renderDelivery(delivery, { harnessLabelsSource: false }),
    receivedAt: at,
    turnId: turnIdFor(delivery.id),
    state: request ? "awaiting-answer" : "unread",
    deliveredReported: false,
    ...(request ? { deadlineAt: new Date(options.now + options.answerTimeoutMs).toISOString() } : {}),
    delivery,
    events: [{ at, event: "received", detail: `${delivery.message.kind} from @${delivery.message.sender.name}` }],
  };
}

export function addEvent(item: InboxItem, now: number, event: string, detail?: string): void {
  item.events.push({ at: new Date(now).toISOString(), event, ...(detail !== undefined ? { detail } : {}) });
  if (item.events.length > 50) item.events.splice(0, item.events.length - 50);
}

export function isOverdue(item: InboxItem, now: number): boolean {
  return item.state === "awaiting-answer" && item.deadlineAt !== undefined && Date.parse(item.deadlineAt) <= now;
}

/** Marks a request timed out: reported `ambiguous`, kept in the inbox to answer with `comms reply`. */
export function timeOut(item: InboxItem, now: number): void {
  item.state = "timed-out";
  item.outcome = { outcome: "ambiguous", entered: [{ origin: TIMEOUT_ORIGIN, at: now }] };
  item.outcomeReported = false;
  item.notice = renderUnmatchedNotice(item.delivery, { harnessLabelsSource: false });
  addEvent(item, now, "timed-out", "no answer in time; reporting ambiguous");
}

/** Whether the item keeps Grok Bot "busy": a request whose answer is still owed in its turn. */
export function keepsBusy(item: InboxItem): boolean {
  return item.state === "awaiting-answer";
}

/**
 * A `check-result` body (without the session) as it goes on the wire: a completed
 * turn's outcome fields sit flat beside `found`, as the mod sends them. (The
 * decoded `Requests["check-result"]` type nests them under `outcome`, so it
 * can't be used to build the request.)
 */
export type CheckAnswer =
  | { deliveryId: string; found: "no" }
  | { deliveryId: string; found: "unknown"; detail?: string }
  | { deliveryId: string; found: "yes"; turnId: string; turn: "running" }
  | ({ deliveryId: string; found: "yes"; turnId: string; turn: "completed" } & (OutcomeBody | { outcome?: undefined }));

/**
 * The answer to a restart check, from what the inbox knows. Deliveries are
 * written to the inbox before `delivered` is reported, so a claimed delivery
 * the inbox doesn't have (and that's younger than this inbox) never reached
 * Grok Bot: `no` makes the connector offer it again. Anything else the inbox
 * can't account for is `unknown`, which never re-runs it.
 */
export function checkAnswer(check: DeliveryCheck, item: InboxItem | null, historyStartedAt: number): CheckAnswer {
  const base = { deliveryId: check.deliveryId };
  if (!item) {
    if (check.state === "claimed" && check.createdAt >= historyStartedAt) return { ...base, found: "no" };
    return { ...base, found: "unknown", detail: "not in grokbot's inbox, which can't rule it out" };
  }
  if (item.kind !== "request") return { ...base, found: "yes", turnId: item.turnId, turn: "completed" };
  if (item.outcome) return { ...base, found: "yes", turnId: item.turnId, turn: "completed", ...item.outcome };
  return { ...base, found: "yes", turnId: item.turnId, turn: "running" };
}

export type AnswerPlan =
  | { ok: true; kind: "outcome"; outcome: OutcomeBody }
  | { ok: true; kind: "reply" }
  | { ok: false; message: string };

/** How an answer to this item is sent, or why it can't be. */
export function planAnswer(item: InboxItem, text: string): AnswerPlan {
  if (!text.trim()) return { ok: false, message: "the answer is empty" };
  if (item.kind !== "request") {
    return {
      ok: false,
      message: `${item.deliveryId} is ${item.kind === "answer" ? "an answer" : "a notice"}; no reply is expected. Mark it read with \`grokbot ack ${item.deliveryId}\`, or follow up with \`comms send\`/\`comms reply\`.`,
    };
  }
  switch (item.state) {
    case "awaiting-answer":
      if (text.length > MAX_REPORTED_ANSWER_CHARS) return { ok: false, message: `the answer is over ${MAX_REPORTED_ANSWER_CHARS} characters` };
      return { ok: true, kind: "outcome", outcome: { outcome: "replied", answer: text } };
    case "timed-out":
    case "reply-failed":
      if (text.length > MAX_TEXT_CHARS) return { ok: false, message: `a late answer (sent as comms reply) may be at most ${MAX_TEXT_CHARS} characters` };
      return { ok: true, kind: "reply" };
    default:
      return {
        ok: false,
        message: `${item.deliveryId} is already ${item.state}. For a follow-up use \`${commsReplyHint(item)}\`.`,
      };
  }
}

export type AckPlan = { ok: true; state: ItemState; note?: string } | { ok: false; message: string };

export function planAck(item: InboxItem): AckPlan {
  if (DONE_STATES.has(item.state)) return { ok: true, state: item.state, note: `already ${item.state}` };
  switch (item.state) {
    case "unread":
      return { ok: true, state: "acknowledged" };
    case "timed-out":
    case "reply-failed":
      return { ok: true, state: "acknowledged", note: "closed without an answer; the request stays unanswered in comms" };
    case "awaiting-answer":
      return { ok: false, message: `${item.deliveryId} is a request awaiting your answer: \`grokbot answer ${item.deliveryId} "<answer>"\`` };
    default:
      return { ok: false, message: `${item.deliveryId} is ${item.state}; its answer is being sent` };
  }
}
