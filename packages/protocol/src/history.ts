import type { BoundedHistory, MessageEnvelope } from "./model.ts";

export interface HistoryLimits {
  /** Most messages carried. */
  maxMessages: number;
  /** Most characters of message text carried, summed. */
  maxChars: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { maxMessages: 20, maxChars: 8000 };

const CLIPPED = " […]";

/**
 * Bounds the history attached to a delivery. `unread` is every message after
 * the recipient's read position and before the delivered one, in any order.
 * Keeps the newest that fit both caps; if even the newest alone is over the
 * character cap, it is kept with its text clipped so the recipient sees the
 * message right before theirs.
 */
export function boundHistory(
  unread: readonly MessageEnvelope[],
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
): BoundedHistory {
  const newestFirst = [...unread].sort((a, b) => b.seq - a.seq);
  const kept: MessageEnvelope[] = [];
  let chars = 0;
  for (const message of newestFirst) {
    if (kept.length >= limits.maxMessages) break;
    const length = message.text.length;
    if (chars + length <= limits.maxChars) {
      kept.push(message);
      chars += length;
      continue;
    }
    if (kept.length === 0 && limits.maxChars > CLIPPED.length) {
      kept.push({ ...message, text: message.text.slice(0, limits.maxChars - CLIPPED.length) + CLIPPED });
    }
    break;
  }
  return { messages: kept.reverse(), omitted: newestFirst.length - kept.length };
}
