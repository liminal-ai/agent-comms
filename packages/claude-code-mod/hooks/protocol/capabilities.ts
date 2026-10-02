// Copied from packages/protocol/src by scripts/sync-protocol.ts. Do not edit.
// The capabilities pass (docs/04-capabilities.md): the agent registry, people
// and @owner, send-and-wait, reminders and alerts. Shapes shared by Convex, the
// connector, the CLI, the mod and the web view. The operations that carry them
// are in loopback.ts; the renderings in render.ts.

import type {
  ConversationId,
  ConversationRef,
  DeliveryId,
  DeliveryState,
  Home,
  MessageEnvelope,
  MessageId,
  ParticipantName,
  ParticipantRef,
  ParticipantState,
} from "./model.ts";

// ---------------------------------------------------------------------------
// Names

/** The system participants, created at deploy. They send; they're never addressed and never get deliveries. */
export const SYSTEM_PARTICIPANTS = ["reminders", "alerts"] as const;
export type SystemParticipant = (typeof SYSTEM_PARTICIPANTS)[number];

/**
 * Names promotion refuses. `owner` resolves to the sender's owner in any send;
 * `all` is kept for later; the system participants' names are taken at deploy.
 */
export const RESERVED_NAMES: readonly string[] = ["owner", "all", ...SYSTEM_PARTICIPANTS];

/** In a send's `to`, resolves to the sending agent's owner. */
export const OWNER_ALIAS = "owner";

// ---------------------------------------------------------------------------
// 1. Agent registry

export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_DUTIES = 10;
export const MAX_DUTY_CHARS = 300;

/**
 * A machine whose connector hasn't heartbeated (every 30 s) for this long is
 * stale: its participants' presence can't be trusted and never counts as idle.
 */
export const PRESENCE_STALE_MS = 90_000;

export interface Presence {
  status: "idle" | "busy" | "offline";
  /** When the status was last written. */
  at: number;
  /** When it last changed to `idle` (not on repeated idle writes). Absent unless idle. */
  idleSince?: number;
  /**
   * When it last changed to `busy` (not on repeated busy writes). Absent unless busy.
   * A waiter whose `busySince` is after its wait began is in a later turn than the
   * one that ran the CLI, so its `ack` doesn't count.
   */
  busySince?: number;
  /** The participant's machine hasn't been heard from: the status can't be trusted, and never counts as idle. */
  stale: boolean;
}

export interface RegistryEntry {
  participant: ParticipantRef;
  state: ParticipantState;
  presence: Presence | null;
  description?: string;
  duties?: string[];
  /** Agents only. */
  owner?: ParticipantRef;
  harness?: Home["harness"];
  /** Only with `long` (thread ids and machines aren't listed by default). */
  home?: Home;
}

// ---------------------------------------------------------------------------
// 3. Send and wait

/**
 * The default bound for a waiting send, below the shortest default shell
 * timeout of the harnesses agents run in (Claude Code's Bash tool: 120 s;
 * Codex in T3: Hazel's H0). Revised from H0 before R2 ships.
 */
export const DEFAULT_WAIT_MS = 100_000;
/** The longest bound `--wait` accepts. Waits past a harness's shell timeout need the shell timeout raised too. */
export const MAX_WAIT_MS = 60 * 60_000;
/** An answered result not confirmed within this long after its wait ended gets its one fallback into the requester's thread (fix pass 0.2). */
export const ACK_WINDOW_MS = 2 * 60_000;
/**
 * A wait is held while its CLI keeps calling `await` (each call holds ≤ 25 s). An
 * answer arriving when no `await` came for this long goes into the thread as
 * normal, and its result is `expired`: nobody is there to print it.
 */
export const WAIT_HELD_MS = 60_000;
/** How long a wait and its results are kept (for `await` and `comms status`) after the wait ends. */
export const WAIT_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * One addressed agent's result in a wait. Every transition is a compare-and-set:
 * - `open` → `answered` (the answer was returned to the wait; its message is stored)
 * - `open` → `expired` (the wait's `until` passed first, or the answer came while no CLI was
 *   awaiting (WAIT_HELD_MS); the answer goes to the thread as normal)
 * - `open` → `ended` (the delivery ended `failed` or `uncertain`, or the agent was retired: no answer is coming)
 * - `answered` → `acknowledged` (fix pass 0.1: the harness confirmed, with `answer-seen`, that a tool
 *   result of the main turn the wait was created in (`waiterTurnId`) carried this answer's complete
 *   proof markers. The CLI's own `ack` only records `printedAt`: printed isn't seen)
 * - `answered` → `fell-back` (fix pass 0.2: not confirmed within ACK_WINDOW_MS after the wait ended
 *   (`endedAt`); delivered once into the thread)
 * `ambiguous` keeps the result `open`: the agent will finish it with `comms reply`.
 */
export type WaitResultState = "open" | "answered" | "expired" | "ended" | "acknowledged" | "fell-back";

export const FINAL_WAIT_RESULT_STATES: readonly WaitResultState[] = ["expired", "ended", "acknowledged", "fell-back"];

export interface WaitResult {
  recipient: ParticipantRef;
  state: WaitResultState;
  /** The recipient's delivery of the request. */
  delivery: { id: DeliveryId; state: DeliveryState; detail?: string };
  /** Present once `answered` (and after): the answer returned to the wait. */
  answer?: MessageEnvelope;
  /**
   * Fix pass 0.1: the proof token for this answer's markers. Only in the waiter's own `send`
   * and `await` responses, so only the waiting CLI can print a proof; never in `message-status`,
   * the web view or the thread.
   */
  proofToken?: string;
  /** When the CLI said it printed this answer (`ack`). Provisional: it doesn't change the state. */
  printedAt?: number;
  /** When the result last changed. */
  at: number;
}

export interface Wait {
  id: string;
  messageId: MessageId;
  waiter: ParticipantRef;
  /** The wait stops counting as "busy waiting" at this time, or when no result is `open`, whichever is first. */
  until: number;
  /** Still counts as busy waiting for the mutual-wait rule. */
  active: boolean;
  /**
   * Fix pass 0.2: when the wait ended: no result open, `until` passed, or its CLI stopped checking
   * in (no `await` for WAIT_HELD_MS: then `endedAt` is the last check-in plus WAIT_HELD_MS). Set
   * once and never moved; the fallback window ACK_WINDOW_MS runs from here.
   */
  endedAt?: number;
  /** Fix pass 0.1: the waiter's main turn when the wait was created, if the harness reports it. Without it nothing confirms, and answers fall back. */
  waiterTurnId?: string;
  results: WaitResult[];
  /** People addressed by the request: never waited on; the message is in their inbox. */
  inInbox: ParticipantRef[];
  createdAt: number;
}

/** Why a send asked to wait but didn't. */
export interface NoWait {
  reason: "busy-waiting" | "nobody-to-wait-for";
  /** For `busy-waiting`: the addressed agents who are themselves in an active wait. */
  busy?: ParticipantName[];
}

/**
 * The CLI's exit codes for `send` (waiting) and `await` (and the existing ones):
 * 0: every waited result `answered` (or nobody to wait for); 1: the connector refused;
 * 2: usage; 3: no connector; 4: the bound was reached with results still open (the
 * message id is printed; answers arriving later go to the thread); 5: every result is
 * final but at least one `ended` without an answer (failed, uncertain, retired).
 */
export const CLI_EXIT = { ok: 0, refused: 1, usage: 2, unreachable: 3, pending: 4, endedWithoutAnswer: 5 } as const;

/** `comms status <message-id>`: each addressed recipient's delivery, and the answer if there is one. */
export interface MessageStatus {
  message: MessageEnvelope;
  conversation: ConversationRef;
  recipients: {
    participant: ParticipantRef;
    /** Absent for people (they read in the web view) and for recipients that got none (retired). */
    delivery?: { id: DeliveryId; state: DeliveryState; detail?: string };
    /** The collected answer, or the `comms reply` that completed the delivery. */
    answer?: MessageEnvelope;
    /** Other answers to the message from this recipient (follow-ups). */
    followUps: MessageEnvelope[];
    /** For people: whether they've read it. */
    inbox?: { readAt: number | null };
  }[];
  /** The caller's wait on this message, if any. */
  wait?: Wait;
}

// ---------------------------------------------------------------------------
// 4. Reminders

export type ReminderState = "active" | "paused" | "blocked" | "done" | "cancelled" | "expired";
export const REMINDER_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60_000;
export const REMINDER_MAX_EXPIRY_MS = 30 * 24 * 60 * 60_000;
/** Reminders fire from a once-a-minute cron: intervals below this are refused. */
export const REMINDER_MIN_INTERVAL_MS = 60_000;

export type ReminderAction = "pause" | "resume" | "done" | "cancel" | "blocked";

export interface ReminderSchedule {
  /** Repeat every this many ms, starting one interval after creation. */
  everyMs?: number;
  /** Fire once at this time (epoch ms). Exactly one of everyMs and at. */
  at?: number;
}

export interface Reminder {
  /** The most recent fire, for lists. */
  lastFire?: { messageId: MessageId; deliveryState: DeliveryState; firedAt: number };
  /** The most recent skip, for lists. */
  lastSkip?: ReminderSkip;
  id: string;
  name: string;
  text: string;
  target: ParticipantRef;
  createdBy: ParticipantRef;
  schedule: ReminderSchedule;
  /** Fire only once the watched participant (the target unless `watch`) has been idle this long. */
  idleForMs?: number;
  watch?: ParticipantRef;
  /** Stop after this many fires. */
  max?: number;
  reportTo?: ParticipantRef;
  state: ReminderState;
  /** Why it's `blocked` (from `comms reminder blocked`), or how it ended. */
  stateReason?: string;
  stateAt: number;
  fires: number;
  nextFireAt?: number;
  expiresAt: number;
  createdAt: number;
}

export interface ReminderFire {
  reminderId: string;
  /** The fire's request message (from @reminders to the target, in their DM). */
  messageId: MessageId;
  deliveryId: DeliveryId;
  deliveryState: DeliveryState;
  firedAt: number;
  /** The target's answer, once collected (or completed with `comms reply`). */
  answer?: { messageId: MessageId; text: string; at: number };
}

export interface ReminderSkip {
  at: number;
  reason: "previous-fire-not-final" | "not-idle" | "presence-stale";
  detail?: string;
}

// ---------------------------------------------------------------------------
// 5. Alerts

export type AlertCause = "uncertain-delivery" | "connector-silent" | "reminder-blocked" | "reminder-expired" | "delivery-reclaimed";

export interface Alert {
  id: string;
  cause: AlertCause;
  /** For a delivery, `conversationId` is the conversation it's in. */
  subject: { kind: "delivery" | "machine" | "reminder"; id: string; conversationId?: ConversationId };
  /** The human it was posted to (the affected agent's owner). */
  owner: ParticipantRef;
  /** The alert message posted by @alerts, and its conversation (the DM between @alerts and the owner). */
  messageId: MessageId;
  conversationId: ConversationId;
  openedAt: number;
  /** When the condition cleared; a recurrence opens a new incident. */
  resolvedAt?: number;
  summary: string;
}

export interface AlertConfig {
  /** A machine with homed agents unheard from this long. */
  connectorSilentMs: number;
  /** A reminder blocked this long. */
  reminderBlockedMs: number;
  /** A delivery claimed more than this many times. */
  maxClaims: number;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = { connectorSilentMs: 10 * 60_000, reminderBlockedMs: 60 * 60_000, maxClaims: 5 };

// ---------------------------------------------------------------------------
// People: the inbox

export interface InboxItem {
  message: MessageEnvelope;
  conversation: ConversationRef;
  readAt: number | null;
}

// ---------------------------------------------------------------------------
// Durations on the CLI ("90s", "20m", "2h", "7d")

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(text.trim());
  return m ? Number(m[1]) * UNIT_MS[m[2]!]! : null;
}

export function formatDuration(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) {
    if (ms % size === 0 && ms >= size) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/**
 * `comms remind --at`: ISO 8601 with a time ("2026-10-01T14:30Z", "2026-10-02T09:00+02:00";
 * no zone means local time), or "HH:MM", the next time it's that time locally (today if
 * still ahead, else tomorrow). A date alone is refused. Null if neither.
 */
export function parseAt(text: string, now: number): number | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(t);
  if (iso) {
    // Date.parse rolls impossible dates over (30 Feb → 2 Mar): check each part is in range (P3 bug 3).
    const [y, mo, d, h, mi, s] = [iso[1], iso[2], iso[3], iso[4], iso[5], iso[7] ?? "0"].map(Number) as [number, number, number, number, number, number];
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || s > 59) return null;
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** A schedule as the reminder line shows it: "every 30m", or "once at 2026-10-01 14:30 UTC". */
export function formatSchedule(schedule: ReminderSchedule): string {
  if (schedule.everyMs !== undefined) return `every ${formatDuration(schedule.everyMs)}`;
  const iso = new Date(schedule.at ?? 0).toISOString();
  return `once at ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

