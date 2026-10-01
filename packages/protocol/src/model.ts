// The shared record: participants, conversations, messages and deliveries.
// Every other package (Convex, connector, adapters, CLI, mod, web) uses these
// shapes. Times are epoch milliseconds. Ids are opaque strings (Convex ids in
// production, anything matching ID_PATTERN in the stub and tests).

/** Opaque ids. Letters, digits, `_` and `-`, 1 to 128 characters. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Participant names are unique and addressable (`@name`). Lowercase. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export type Id = string;
export type MessageId = Id;
export type ConversationId = Id;
export type DeliveryId = Id;
export type ParticipantId = Id;
export type ParticipantName = string;

export function isId(value: unknown): value is Id {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isName(value: unknown): value is ParticipantName {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Participants and conversations

/** `system`: the deploy-time senders `reminders` and `alerts`; no home, no presence, never addressed or delivered to. */
export type ParticipantKind = "human" | "agent" | "system";
export type ParticipantState = "active" | "paused" | "retired";
export type Harness = "t3" | "claude-code" | "web";

/** How a participant is referred to inside messages and deliveries. */
export interface ParticipantRef {
  id: ParticipantId;
  name: ParticipantName;
  kind: ParticipantKind;
}

/** Where an agent lives. Moving an agent changes its home; its context stays where it was. */
export interface Home {
  /** Machine id of the connector that delivers to this participant. */
  machine: string;
  harness: Harness;
  /** Harness-specific: a T3 thread id; for Claude Code, the participant name the terminal was started with. */
  locator: string;
}

export type ConversationKind = "dm" | "group";

export interface ConversationRef {
  id: ConversationId;
  kind: ConversationKind;
  /** Groups have a title; DMs usually don't. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Messages

/** Where a message entered the system. */
export type Via = "t3" | "claude-code" | "cli" | "web";

export interface Origin {
  via: Via;
  /**
   * The id this message has outside comms, when it came from somewhere that
   * shows messages itself (a T3 message id, a web client nonce). Used to
   * suppress echoes; never used for reply matching.
   */
  externalId?: string;
}

/** An attachment is a reference; comms never carries the bytes. */
export interface AttachmentRef {
  name: string;
  /** Where the bytes can be fetched by someone allowed to. */
  url: string;
  mimeType?: string;
  sizeBytes?: number;
}

/**
 * `request` expects an answer. `answer` carries `inReplyTo` and is never
 * itself collected from: whatever the requester does after receiving an answer
 * stays with the requester. That's what stops agents looping.
 */
export type MessageKind = "request" | "answer";

export interface MessageEnvelope {
  id: MessageId;
  conversationId: ConversationId;
  /** Per-conversation sequence number, starting at 1, no gaps. */
  seq: number;
  sender: ParticipantRef;
  /** The addressed participants: only these are woken. Other members see the message as history. */
  recipients: ParticipantRef[];
  kind: MessageKind;
  /** Set on every answer, never on a request. */
  inReplyTo?: MessageId;
  /**
   * Set only on an answer collected automatically from a delivery's turn. At
   * most one message per delivery carries a given value. Explicit `comms
   * reply` answers never set it.
   */
  collectedFrom?: DeliveryId;
  text: string;
  attachments: AttachmentRef[];
  createdAt: number;
  origin: Origin;
  /** Set on messages from a system participant: what they are, for rendering and the web view. */
  meta?: MessageMeta;
}

/**
 * What a system participant's message is. A reminder fire is a request; the
 * others are informational (reports and notices to a participant, alerts to an
 * owner).
 */
export type MessageMeta =
  | { type: "reminder"; reminderId: string; name: string; setBy: ParticipantName; schedule: string; fire: number }
  | { type: "reminder-report"; reminderId: string; name: string; target: ParticipantName; fireMessageId: MessageId }
  | { type: "reminder-ended"; reminderId: string; name: string; state: "expired" | "done" | "cancelled" | "blocked"; reason?: string }
  | { type: "alert"; alertId: string; cause: string; subject: { kind: string; id: string } };

// ---------------------------------------------------------------------------
// Deliveries

/**
 * - `pending`: created, waiting for the recipient's connector (or for a paused recipient to resume).
 * - `claimed`: a connector holds a lease on it and may hand it to the harness.
 * - `delivered`: the harness accepted our message (T3 recorded our message id; the mod saw a turn carrying our delivery id).
 * - `replied`: the answer was collected automatically, or completed with `comms reply` after being ambiguous.
 * - `ambiguous`: something else entered our turn, so the reply can't be matched; the agent answers with `comms reply`.
 * - `uncertain`: after a restart or takeover the connector couldn't tell whether it ran. Never re-run; surfaced to Lee.
 * - `failed`: the turn was aborted, refused or errored, or the delivery couldn't be handed over.
 *
 * Deliveries of an `answer` end at `delivered`: they are never collected from.
 */
export type DeliveryState =
  | "pending"
  | "claimed"
  | "delivered"
  | "replied"
  | "ambiguous"
  | "uncertain"
  | "failed";

export const DELIVERY_STATES: readonly DeliveryState[] = [
  "pending",
  "claimed",
  "delivered",
  "replied",
  "ambiguous",
  "uncertain",
  "failed",
];

/** States a delivery never leaves on its own. `ambiguous` and `uncertain` still become `replied` when the recipient answers with `comms reply`. */
export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = ["replied", "uncertain", "failed"];

export interface Claim {
  machine: string;
  /** Unique per claim; the compare-and-set token checked right before handing the message to the harness. */
  claimId: Id;
  leaseExpiresAt: number;
}

export interface DeliveryStatus {
  state: DeliveryState;
  /** When the delivery entered this state. */
  at: number;
  /** Free text for people: why it failed, what made it ambiguous or uncertain. */
  detail?: string;
  /** Present while `claimed`. */
  claim?: Claim;
  /** The harness turn our message went into. Present from `delivered` on, when known. */
  turnId?: string;
  /** The adapter's resume point in the harness (T3: the event sequence just before our message). Opaque; set with `delivered`. */
  cursor?: string;
}

/** The recent messages a delivery carries, so the recipient has context without reading. */
export interface BoundedHistory {
  /** Oldest first. Messages after the recipient's read position and before the delivered message. */
  messages: MessageEnvelope[];
  /** How many messages in that range were left out (older than the ones shown). */
  omitted: number;
}

export interface Delivery {
  id: DeliveryId;
  recipient: ParticipantRef;
  conversation: ConversationRef;
  /** The message being delivered. Its id is the delivery's message id. */
  message: MessageEnvelope;
  /** For an answer: the request it answers, so the requester knows what came back. */
  inReplyTo?: MessageEnvelope;
  history: BoundedHistory;
  status: DeliveryStatus;
  /**
   * An answer delivered into the thread as the one fallback after it was
   * returned to a waiting send that never acknowledged it: it may already have
   * been shown (capabilities pass, send-and-wait).
   */
  fallback?: boolean;
}

/** A delivery's output is collected only for requests. */
export function isCollectable(delivery: Pick<Delivery, "message">): boolean {
  return delivery.message.kind === "request";
}
