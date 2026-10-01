// Copied from packages/protocol/src by scripts/sync-protocol.ts. Do not edit.
// The loopback protocol between a machine's connector and its local clients:
// the Claude Code mod and the `comms` CLI. HTTP/1.1 over a Unix socket in an
// owner-only directory. See ../README.md for the prose version.
//
// Every operation is `POST /v1/<op>` with a JSON body; the response is JSON:
//   success: HTTP 200, `{ "ok": true, ...result }`
//   failure: HTTP 4xx/5xx, `{ "ok": false, "error": { "code", "message" } }`
// There is no token: the directory's permissions are the protection, the same
// trusted-machine footing as `--as`.

import {
  array,
  boolean,
  DecodeError,
  decode,
  type Decoded,
  type Decoder,
  integer,
  literal,
  object,
  optional,
  string,
  tagged,
} from "./decode.ts";
import type {
  AttachmentRef,
  ConversationId,
  ConversationRef,
  Delivery,
  DeliveryId,
  DeliveryState,
  Home,
  MessageEnvelope,
  MessageId,
  ParticipantName,
  ParticipantRef,
  ParticipantState,
} from "./model.ts";
import { ID_PATTERN, NAME_PATTERN } from "./model.ts";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_DUTIES,
  MAX_DUTY_CHARS,
  MAX_WAIT_MS,
  type MessageStatus,
  type NoWait,
  type RegistryEntry,
  REMINDER_MAX_EXPIRY_MS,
  REMINDER_MIN_INTERVAL_MS,
  type Reminder,
  type ReminderFire,
  type ReminderSkip,
  type Wait,
} from "./capabilities.ts";

export const PROTOCOL_VERSION = 1;
export const LOOPBACK_PATH_PREFIX = "/v1/";

/** The connector holds a poll open at most this long by default, then answers with no items. */
export const DEFAULT_POLL_WAIT_MS = 20_000;
/** A client may ask for a shorter or longer wait, up to this. The mod's fetch has no timeout, so the bound is the connector's. */
export const MAX_POLL_WAIT_MS = 25_000;

export const DEFAULT_READ_LIMIT = 20;
export const MAX_READ_LIMIT = 100;
/**
 * The most characters of message text: refused above this at send (loopback and
 * Convex), and collected answers are clipped to it (`clipAnswer`). Kept well
 * below MAX_RENDERED_CHARS so one message plus framing fits one injection.
 */
export const MAX_TEXT_CHARS = 32_000;
/** What a client may report as an answer; anything over MAX_TEXT_CHARS is clipped on collection. */
export const MAX_REPORTED_ANSWER_CHARS = 1_000_000;

/** Clips a collected answer to MAX_TEXT_CHARS, saying how much was cut. */
export function clipAnswer(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const marker = `\n[… clipped by agent-comms: ${text.length - MAX_TEXT_CHARS} more characters]`;
  return text.slice(0, MAX_TEXT_CHARS - marker.length) + marker;
}

// ---------------------------------------------------------------------------
// Socket location

export const SOCKET_ENV = "AGENT_COMMS_SOCKET";
export const PARTICIPANT_ENV = "AGENT_COMMS_PARTICIPANT";
export const SOCKET_DIR_NAME = "agent-comms";
export const SOCKET_FILE_NAME = "connector.sock";

export interface SocketLocationInput {
  /** `process.platform` or equivalent: "linux", "darwin", ... */
  platform: string;
  /** Value of AGENT_COMMS_SOCKET, if set: wins everywhere. */
  override?: string | undefined;
  xdgRuntimeDir?: string | undefined;
  home?: string | undefined;
  /** Used on Linux when XDG_RUNTIME_DIR isn't set: `/run/user/<uid>`. */
  uid?: number | undefined;
}

/**
 * Where the connector listens:
 * - `AGENT_COMMS_SOCKET` if set (tests, unusual setups);
 * - Linux: `$XDG_RUNTIME_DIR/agent-comms/connector.sock`, falling back to `/run/user/<uid>/…`;
 * - macOS and others: `~/.agent-comms/connector.sock`.
 * The directory holding the socket must be mode 0700 and owned by the user.
 * Returns null if there isn't enough information to decide.
 */
export function socketPath(input: SocketLocationInput): string | null {
  if (input.override) return input.override;
  if (input.platform === "linux") {
    const runtime = input.xdgRuntimeDir || (input.uid !== undefined ? `/run/user/${input.uid}` : undefined);
    return runtime ? `${runtime}/${SOCKET_DIR_NAME}/${SOCKET_FILE_NAME}` : null;
  }
  return input.home ? `${input.home}/.${SOCKET_DIR_NAME}/${SOCKET_FILE_NAME}` : null;
}

// ---------------------------------------------------------------------------
// Errors

export type ErrorCode =
  | "bad_request"
  | "unknown_op"
  | "unknown_participant"
  | "not_homed_here"
  | "not_member"
  | "unknown_conversation"
  | "unknown_message"
  | "unknown_delivery"
  | "unknown_reminder"
  | "unknown_session"
  | "session_superseded"
  | "poll_in_progress"
  | "conflict"
  | "unavailable"
  /** The connector doesn't implement this operation (yet): version skew, not a bad request. */
  | "unsupported"
  | "internal";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unknown_op: 404,
  unknown_participant: 404,
  not_homed_here: 403,
  not_member: 403,
  unknown_conversation: 404,
  unknown_message: 404,
  unknown_delivery: 404,
  unknown_reminder: 404,
  unknown_session: 404,
  session_superseded: 409,
  poll_in_progress: 409,
  conflict: 409,
  unavailable: 503,
  unsupported: 501,
  internal: 500,
};

export interface ErrorBody {
  ok: false;
  error: { code: ErrorCode; message: string };
}

export type OkBody<T> = { ok: true } & T;

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Field decoders

const id = string({ pattern: ID_PATTERN, label: "an id ([A-Za-z0-9_-], 1-128)" });
const name = string({ pattern: NAME_PATTERN, label: "a participant name (lowercase [a-z0-9_-], 1-48)" });
/** Harness-issued ids (Claude Code session and turn ids, T3 thread ids): opaque, printable, bounded. */
const harnessId = string({ min: 1, max: 256, pattern: /^[\x21-\x7e]+$/, label: "a harness id (printable, 1-256)" });
const text = string({ min: 1, max: MAX_TEXT_CHARS, label: `non-empty text (at most ${MAX_TEXT_CHARS} characters)` });
const presence = literal("idle", "busy");
const idempotencyKey = string({ min: 8, max: 128, pattern: /^[A-Za-z0-9_-]+$/, label: "an idempotency key ([A-Za-z0-9_-], 8-128)" });

const attachment: Decoder<AttachmentRef> = object({
  name: string({ min: 1, max: 512 }),
  url: string({ min: 1, max: 4096 }),
  mimeType: optional(string({ max: 256 })),
  sizeBytes: optional(integer({ min: 0 })),
});

/** What entered a turn besides our delivery: the kind of input only, never its text. */
const enteredInput = object({
  /** The harness's own label: for Claude Code a `prompt.submit` origin (`composer`, `bridge`, `task-notification`, ...). */
  origin: string({ min: 1, max: 64 }),
  at: optional(integer({ min: 0 })),
});

const outcomeReplied = object({
  outcome: literal("replied"),
  /**
   * The turn's final answer text: collected as the answer to the request.
   * Longer than MAX_TEXT_CHARS is accepted and clipped (`clipAnswer`), not refused.
   */
  answer: string({ max: MAX_REPORTED_ANSWER_CHARS }),
});
const outcomeAmbiguous = object({
  outcome: literal("ambiguous"),
  entered: array(enteredInput, { max: 50 }),
});
const outcomeFailed = object({
  outcome: literal("failed"),
  reason: literal("aborted", "refusal", "error", "rejected"),
  detail: optional(string({ max: 2000 })),
});
const outcomeBody = tagged("outcome", {
  replied: outcomeReplied,
  ambiguous: outcomeAmbiguous,
  failed: outcomeFailed,
});

export type OutcomeBody = Decoded<typeof outcomeBody>;
export type EnteredInput = Decoded<typeof enteredInput>;

// ---------------------------------------------------------------------------
// Requests

const requestDecoders = {
  /** Who the connector is and who is homed here. Any client; no identity needed. */
  status: object({}),

  /**
   * A harness session announces itself (the mod, on `session.start`, and again
   * after the connector restarts). Registering the same session id again
   * replaces the earlier registration. A different session id for the same
   * participant supersedes the earlier session: its polls fail with
   * `session_superseded`.
   * Errors: `unknown_participant`, `not_homed_here` (homed elsewhere, or not a Claude Code home).
   */
  register: object({
    participant: name,
    harness: literal("claude-code"),
    sessionId: harnessId,
    cwd: string({ min: 1, max: 4096 }),
    status: presence,
  }),

  /** The session is ending. Deliveries it was offered but never acked are checked on the next registration. */
  unregister: object({ sessionId: harnessId }),

  /**
   * Wait for work. Held open until there is at least one item or `waitMs`
   * (default DEFAULT_POLL_WAIT_MS, capped at MAX_POLL_WAIT_MS) passes, then
   * answered with the items, possibly none. One outstanding poll per session:
   * a second concurrent poll fails with `poll_in_progress` and the first is
   * unaffected. Each item is returned once per registration; the client dedupes
   * by delivery id anyway.
   * Errors: `unknown_session` (register again), `session_superseded` (stop), `poll_in_progress`.
   */
  poll: object({
    sessionId: harnessId,
    waitMs: optional(integer({ min: 0, max: MAX_POLL_WAIT_MS })),
  }),

  /**
   * The harness accepted a delivery: a turn started carrying our delivery id.
   * Like every report (`outcome`, `check-result`, `presence`), acknowledged at
   * once and written to the server in the background. Any call answering
   * `unknown_session` means: register again, then retry it.
   * Idempotent: the same turn id again succeeds. A different turn id, or a
   * delivery not offered to this session's participant, fails with `conflict`.
   */
  delivered: object({ sessionId: harnessId, deliveryId: id, turnId: harnessId }),

  /**
   * How our turn ended. Only for deliveries of a request; an answer delivery
   * ends at `delivered` and `outcome` on it fails with `conflict`.
   * `turnId` may be omitted only for `failed`: a delivery the harness dropped
   * before any turn started it (e.g. a plugin prompt that was never run).
   * `replied` collects the answer: at most once per delivery; a repeat
   * returns `duplicate: true`. `answerMessageId` is present only when already
   * known (the stub knows at once; the connector writes in the background).
   */
  outcome: (value: unknown, path: string) => {
    const head = object({ sessionId: harnessId, deliveryId: id, turnId: optional(harnessId) })(value, path);
    const body = outcomeBody(value, path);
    if (head.turnId === undefined && body.outcome !== "failed") {
      throw new DecodeError(path ? `${path}.turnId` : "turnId", "a value (only a failed outcome may omit it)");
    }
    return { ...head, ...body };
  },

  /**
   * Answer to a `check` item from a poll: does this session have the delivery,
   * and what happened to its turn? `yes` with a completed turn carries the
   * outcome, exactly as `outcome` would (omit it for an answer's delivery; a
   * request's without one becomes `uncertain`). `unknown` makes it `uncertain`.
   */
  "check-result": (value: unknown, path: string) => {
    const head = object({ sessionId: harnessId, deliveryId: id })(value, path);
    const found = tagged("found", {
      yes: (v: unknown, p: string) => {
        const turn = object({ turnId: harnessId, turn: literal("running", "completed") })(v, p);
        if (turn.turn === "running") return { found: "yes" as const, turnId: turn.turnId, turn: "running" as const };
        // An answer's delivery has no outcome to report; a request's should (without one it becomes `uncertain`).
        const hasOutcome = typeof v === "object" && v !== null && (v as { outcome?: unknown }).outcome !== undefined;
        const outcome = hasOutcome ? outcomeBody(v, p) : undefined;
        return { found: "yes" as const, turnId: turn.turnId, turn: "completed" as const, ...(outcome ? { outcome } : {}) };
      },
      no: object({ found: literal("no") }),
      unknown: object({ found: literal("unknown"), detail: optional(string({ max: 2000 })) }),
    })(value, path);
    return { ...head, ...found };
  },

  /** Idle or busy. The mod reports busy for its session's main turns, whoever started them, without any content. */
  presence: object({ sessionId: harnessId, status: presence }),

  /**
   * Send a request. Without `conversationId`, `to` names exactly one
   * participant and the DM between the two is used (opened if new). With it,
   * every name in `to` must be a member; `to` may be empty, which posts
   * without waking anyone. Retired recipients get no delivery and are listed
   * in `skipped`; paused ones get a pending delivery.
   * Errors: `unknown_participant`, `not_homed_here` (for `as`), `unknown_conversation`, `not_member`, `bad_request`.
   */
  send: object({
    as: name,
    to: array(name, { max: 50 }),
    conversationId: optional(id),
    text,
    attachments: optional(array(attachment, { max: 20 })),
    /**
     * Wait for the addressed agents' answers (capabilities pass). Registers the
     * wait in the same Convex mutation as the send, unless an addressed agent is
     * itself busy waiting, in which case the response says so (`noWait`) and the
     * send goes ahead without waiting. The CLI then calls `await`.
     */
    wait: optional(boolean),
    /** The wait's bound, default DEFAULT_WAIT_MS. */
    waitMs: optional(integer({ min: 1_000, max: MAX_WAIT_MS })),
    /**
     * Idempotency key (fix pass 3.1): a repeat with the same `as` and `key`
     * returns the first send's result instead of posting again. The CLI makes
     * one per invocation and reuses it when it retries after `unavailable`.
     */
    key: optional(idempotencyKey),
  }),

  /**
   * Answer a message: an `answer` in the same conversation, addressed to the
   * message's sender, with `inReplyTo` set. Always allowed, any number of
   * times. If `as` has an `ambiguous` or `uncertain` delivery of that
   * message, this completes it (`replied`) and `completed` names it. A
   * `delivered` one is left alone: its turn is still running and its own
   * answer is still collected; this reply is a separate follow-up.
   * Errors: `unknown_participant`, `not_homed_here`, `unknown_message`, `not_member`.
   */
  reply: object({
    as: name,
    messageId: id,
    text,
    attachments: optional(array(attachment, { max: 20 })),
    /** As for `send`. */
    key: optional(idempotencyKey),
  }),

  // -------------------------------------------------------------------------
  // Capabilities pass (docs/04-capabilities.md). Types in capabilities.ts.

  /**
   * Wait for the answers to a request this participant sent with `wait: true`.
   * Held until any result leaves `open`, or `waitMs` (≤ MAX_POLL_WAIT_MS) passes;
   * answered with the wait as it stands. Answers are read from the stored
   * results, so a restarted connector serves them too. The CLI calls it again
   * until every result is final or its own bound passes; then it `ack`s what it
   * printed. Errors: `unknown_message`, `conflict` (no wait by this participant on it).
   */
  await: object({ as: name, messageId: id, waitMs: optional(integer({ min: 0, max: MAX_POLL_WAIT_MS })) }),

  /**
   * The CLI printed these answers: `answered` → `acknowledged` (compare-and-set;
   * a result that already `fell-back` stays so). Without `recipients`, every
   * answered result. Idempotent.
   */
  ack: object({ as: name, messageId: id, recipients: optional(array(name, { max: 50 })) }),

  /** `comms status <message-id>`: each addressed recipient's delivery state and answer. Errors: `unknown_message`, `not_member`. */
  "message-status": object({ as: name, messageId: id }),

  /** The agent registry: every active participant, or one (`name`), with duties. `long` adds homes. */
  agents: object({ as: name, name: optional(name), long: optional(boolean) }),

  /** Set a registry entry's description and duties. Allowed for the agent itself and its owner. Errors: `conflict` (not allowed). */
  "agents-set": object({
    as: name,
    name,
    description: optional(string({ max: MAX_DESCRIPTION_CHARS, label: `a description (at most ${MAX_DESCRIPTION_CHARS} characters)` })),
    duties: optional(array(string({ min: 1, max: MAX_DUTY_CHARS, label: `a duty (1-${MAX_DUTY_CHARS} characters)` }), { max: MAX_DUTIES })),
  }),

  /**
   * Create a reminder for `target`. Exactly one of `everyMs` (≥ REMINDER_MIN_INTERVAL_MS)
   * and `at`. `expiresMs` defaults to REMINDER_DEFAULT_EXPIRY_MS, at most
   * REMINDER_MAX_EXPIRY_MS. Errors: `unknown_participant`, `bad_request`.
   */
  remind: (value: unknown, path: string) => {
    const r = object({
      as: name,
      target: name,
      text,
      everyMs: optional(integer({ min: REMINDER_MIN_INTERVAL_MS, max: REMINDER_MAX_EXPIRY_MS })),
      at: optional(integer({ min: 0 })),
      name: optional(string({ min: 1, max: 80 })),
      idleForMs: optional(integer({ min: 0, max: REMINDER_MAX_EXPIRY_MS })),
      watch: optional(name),
      max: optional(integer({ min: 1, max: 10_000 })),
      reportTo: optional(name),
      expiresMs: optional(integer({ min: REMINDER_MIN_INTERVAL_MS, max: REMINDER_MAX_EXPIRY_MS })),
    })(value, path);
    if ((r.everyMs === undefined) === (r.at === undefined)) {
      throw new DecodeError(path ? `${path}.everyMs` : "everyMs", "exactly one of everyMs and at");
    }
    return r;
  },

  /** Reminders the caller created, is the target of, or owns the target of. */
  reminders: object({ as: name }),

  /** One reminder, with its fires and skips. Errors: `unknown_reminder`. */
  reminder: object({ as: name, id }),

  /**
   * pause | resume | done | cancel | blocked (with `reason`). Allowed for the
   * creator, the target and the target's owner. Pausing or cancelling stops
   * future fires only. Errors: `unknown_reminder`, `conflict` (not allowed, or the state doesn't allow it).
   */
  "reminder-update": (value: unknown, path: string) => {
    const r = object({
      as: name,
      id,
      action: literal("pause", "resume", "done", "cancel", "blocked"),
      reason: optional(string({ max: 2000 })),
    })(value, path);
    if (r.action === "blocked" && !r.reason?.trim()) {
      throw new DecodeError(path ? `${path}.reason` : "reason", "a reason for blocked");
    }
    return r;
  },

  /**
   * Read a conversation's messages, oldest first. Without `before`, the newest
   * `limit`; with it, the `limit` messages before that seq. Reading the newest
   * page moves the reader's read position to the newest seq returned; reading
   * older pages doesn't move it.
   * Errors: `unknown_participant`, `not_homed_here`, `unknown_conversation`, `not_member`.
   */
  read: object({
    as: name,
    conversationId: id,
    before: optional(integer({ min: 1 })),
    limit: optional(integer({ min: 1, max: MAX_READ_LIMIT })),
  }),

  /** The conversations `as` is a member of, most recent first. */
  list: object({ as: name }),
} as const;

export type Op = keyof typeof requestDecoders;
export const OPS = Object.keys(requestDecoders) as Op[];

export type Requests = { [K in Op]: Decoded<(typeof requestDecoders)[K]> };

export function isOp(value: string): value is Op {
  return Object.hasOwn(requestDecoders, value);
}

/** Validates an untrusted request body for an operation. */
export function decodeRequest<K extends Op>(op: K, body: unknown): { ok: true; value: Requests[K] } | { ok: false; error: string } {
  return decode(requestDecoders[op] as Decoder<Requests[K]>, body);
}

// ---------------------------------------------------------------------------
// Responses (the part after `ok: true`)

export interface HomedParticipant {
  participant: ParticipantRef;
  home: Home;
  state: ParticipantState;
}

export interface DeliveryCheck {
  deliveryId: DeliveryId;
  messageId: MessageId;
  /** `claimed`: was it submitted into the session? `delivered`: what happened to `turnId`? */
  state: Extract<DeliveryState, "claimed" | "delivered">;
  turnId?: string;
  /**
   * When the delivery was created, epoch ms on the server's clock (the same
   * instant as its message's `createdAt`). The mod compares it with when it lost
   * its history: only a delivery created after that loss can be answered `no`.
   */
  createdAt: number;
}

export type PollItem = { type: "deliver"; delivery: Delivery } | { type: "check"; check: DeliveryCheck };

export interface DeliveryStateRef {
  id: DeliveryId;
  recipient: ParticipantName;
  state: DeliveryState;
}

export interface ConversationSummary extends ConversationRef {
  members: ParticipantRef[];
  lastSeq: number;
  /** The caller's read position. */
  readSeq: number;
  unread: number;
}

export interface SendResult {
  message: MessageEnvelope;
  deliveries: DeliveryStateRef[];
  skipped: { name: ParticipantName; reason: "retired" }[];
}

export interface Responses {
  status: {
    protocol: typeof PROTOCOL_VERSION;
    implementation: "stub" | "connector";
    machine: string;
    participants: HomedParticipant[];
  };
  register: { participant: ParticipantRef; pollWaitMs: number };
  unregister: Record<string, never>;
  poll: { items: PollItem[] };
  delivered: { delivery: DeliveryStateRef };
  outcome: { delivery: DeliveryStateRef; answerMessageId?: MessageId; duplicate: boolean };
  "check-result": { delivery: DeliveryStateRef };
  presence: Record<string, never>;
  send: SendResult & {
    /** With `wait: true`: the wait, its results all `open` (humans listed in `inInbox`). */
    wait?: Wait;
    /** With `wait: true` but no wait registered: why (an addressed agent is busy waiting, or nobody to wait for). */
    noWait?: NoWait;
  };
  reply: SendResult & { completed?: DeliveryId };
  await: { wait: Wait };
  ack: { wait: Wait };
  "message-status": MessageStatus;
  agents: { agents: RegistryEntry[] };
  "agents-set": { agent: RegistryEntry };
  remind: { reminder: Reminder };
  reminders: { reminders: Reminder[] };
  reminder: { reminder: Reminder; fires: ReminderFire[]; skips: ReminderSkip[] };
  "reminder-update": { reminder: Reminder };
  read: { conversation: ConversationSummary; messages: MessageEnvelope[]; hasMore: boolean };
  list: { conversations: ConversationSummary[] };
}

export type ResponseBody<K extends Op> = OkBody<Responses[K]> | ErrorBody;

/** The HTTP path for an operation. */
export function opPath(op: Op): string {
  return `${LOOPBACK_PATH_PREFIX}${op}`;
}

/**
 * Reads a response body as a client. Anything that isn't a well-formed
 * protocol body becomes an `internal` error, so callers only ever handle
 * `ok: true` or a coded error.
 */
export function parseResponse<K extends Op>(status: number, bodyText: string): ResponseBody<K> {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return errorBody("internal", `connector answered HTTP ${status} with a body that isn't JSON`);
  }
  if (typeof body !== "object" || body === null || typeof (body as { ok?: unknown }).ok !== "boolean") {
    return errorBody("internal", `connector answered HTTP ${status} with a body that isn't a protocol response`);
  }
  if ((body as { ok: boolean }).ok) return body as OkBody<Responses[K]>;
  const error = (body as { error?: { code?: unknown; message?: unknown } }).error;
  const code = typeof error?.code === "string" && error.code in ERROR_STATUS ? (error.code as ErrorCode) : "internal";
  const message = typeof error?.message === "string" ? error.message : `HTTP ${status}`;
  return errorBody(code, message);
}

export type { ConversationId };
