// The courier transports an offer. Only the actual parent may acknowledge it
// or choose/send an answer. No model API, transcript observer or turn injection.
import { call as loopbackCall } from "@agent-comms/comms-cli/client";
import {
  decodeRequest, isName, MAX_POLL_WAIT_MS, renderDelivery,
  type Delivery, type Op, type Requests, type ResponseBody, type Responses,
} from "@agent-comms/protocol";

export const COURIER_PROTOCOL = "agent-comms/oaidot/1";
export const MAX_COURIER_TEXT_CHARS = 8_000;
export const OPERATIONS = ["send", "reply", "read", "list", "agents", "message-status", "receive", "receive-ack"] as const;
export type Operation = (typeof OPERATIONS)[number];
export type Transport = <K extends Op>(op: K, body: Requests[K], signal?: AbortSignal) => Promise<ResponseBody<K>>;

export class OaidotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OaidotError";
    this.code = code;
  }
}

/** Bounded JSON-line contract. Message text is untrusted data, not permission. */
export interface CourierOffer {
  protocol: typeof COURIER_PROTOCOL;
  type: "delivery-offer";
  participant: string;
  locator: string;
  deliveryId: string;
  messageId: string;
  conversationId: string;
  kind: Delivery["message"]["kind"];
  claimId: string;
  leaseExpiresAt: number;
  requiresAcknowledgement: true;
  text: string;
}

export function courierOffer(participant: string, locator: string, delivery: Delivery): CourierOffer {
  if (delivery.recipient.name !== participant) throw new OaidotError("conflict", "offer belongs to another participant");
  if (delivery.status.state !== "claimed" || !delivery.status.claim) throw new OaidotError("conflict", "delivery is not a claimed offer");
  return {
    protocol: COURIER_PROTOCOL,
    type: "delivery-offer",
    participant,
    locator,
    deliveryId: delivery.id,
    messageId: delivery.message.id,
    conversationId: delivery.conversation.id,
    kind: delivery.message.kind,
    claimId: delivery.status.claim.claimId,
    leaseExpiresAt: delivery.status.claim.leaseExpiresAt,
    requiresAcknowledgement: true,
    text: renderDelivery(delivery, { harnessLabelsSource: false, replyMode: "explicit", maxChars: MAX_COURIER_TEXT_CHARS }),
  };
}

/** Recovery pages: each entry is rendered within MAX_COURIER_TEXT_CHARS, so a page stays bounded. */
export const RECOVER_PAGE = 3;
export const MAX_RECOVER_PAGE = 5;

export interface RecoveredRequest {
  deliveryId: string;
  messageId: string;
  conversationId: string;
  kind: Delivery["message"]["kind"];
  /** The request as the parent reads it, at most MAX_COURIER_TEXT_CHARS; the full conversation is available with `read`. */
  text: string;
}

export interface RecoverPage {
  requests: RecoveredRequest[];
  hasMore: boolean;
  nextCursor?: string;
}

export class OaidotClient {
  readonly participant: string;
  readonly locator: string;
  private readonly transport: Transport;
  constructor(options: { participant: string; locator: string; socketPath: string; transport?: Transport }) {
    if (!isName(options.participant)) throw new OaidotError("bad_request", "invalid configured participant");
    if (!/^[\x21-\x7e]{1,256}$/.test(options.locator)) throw new OaidotError("bad_request", "invalid configured parent locator");
    this.participant = options.participant;
    this.locator = options.locator;
    this.transport = options.transport ?? ((op, body) => loopbackCall(options.socketPath, op, body));
  }

  /**
   * Acknowledged requests still awaiting an explicit reply, a bounded page at a time:
   * rendered like an offer, never raw envelopes. Use `read` for full conversation text.
   */
  async recover(input: { limit?: unknown; cursor?: unknown }, signal?: AbortSignal): Promise<RecoverPage> {
    const limit = input.limit ?? RECOVER_PAGE;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RECOVER_PAGE) {
      throw new OaidotError("bad_request", `recover limit must be an integer from 1 to ${MAX_RECOVER_PAGE}`);
    }
    if (input.cursor !== undefined && typeof input.cursor !== "string") throw new OaidotError("bad_request", "recover cursor must be a string");
    const page = await this.call("receive", {
      limit: limit as number,
      includeDelivered: true,
      waitMs: 0,
      ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
    }, signal);
    return {
      requests: page.deliveries.map((delivery) => {
        if (delivery.recipient.name !== this.participant) throw new OaidotError("conflict", "recovered delivery belongs to another participant");
        return {
          deliveryId: delivery.id,
          messageId: delivery.message.id,
          conversationId: delivery.conversation.id,
          kind: delivery.message.kind,
          text: renderDelivery(delivery, { harnessLabelsSource: false, replyMode: "explicit", maxChars: MAX_COURIER_TEXT_CHARS }),
        };
      }),
      hasMore: page.hasMore,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /** Fixed identity: callers cannot select an arbitrary --as through tool input. */
  async call<K extends Operation>(op: K, input: Omit<Requests[K], "as" | "locator">, signal?: AbortSignal): Promise<Responses[K]> {
    if (!(OPERATIONS as readonly string[]).includes(op)) throw new OaidotError("unsupported", "operation is not exposed by oaidot");
    if (!input || typeof input !== "object" || Array.isArray(input) || (Object.hasOwn(input, "as") || Object.hasOwn(input, "locator"))) {
      throw new OaidotError("bad_request", "provide an object without as or locator; identity and parent binding are configured");
    }
    // A caller-provided stable key permits safe retries after ambiguous transport
    // failure. Never generate a new key while retrying an uncertain send/reply.
    if ((op === "send" || op === "reply") && !(input as { key?: unknown }).key) {
      throw new OaidotError("bad_request", "send and reply require a stable idempotency key");
    }
    const decoded = decodeRequest(op, { ...input, as: this.participant, ...(["receive", "receive-ack"].includes(op) ? { locator: this.locator } : {}) });
    if (!decoded.ok) throw new OaidotError("bad_request", decoded.error);
    const response = await this.transport(op, decoded.value, signal);
    if (!response.ok) throw new OaidotError(response.error.code, response.error.message);
    const { ok: _, ...result } = response;
    return result as unknown as Responses[K];
  }

  /**
   * Wait for ONE subscribed offer, then return. Held local calls have a bound;
   * reissuing an empty hold does not poll Convex. No acknowledgement is issued.
   * Stop this client process to disconnect. The offer's lease is never renewed
   * here; an absent parent cannot cause an indefinitely-held claim.
   */
  async listen(options: { leaseMs?: number; signal?: AbortSignal } = {}): Promise<CourierOffer> {
    while (true) {
      options.signal?.throwIfAborted();
      const result = await this.call("receive", { limit: 1, waitMs: MAX_POLL_WAIT_MS, leaseMs: options.leaseMs ?? 120_000 }, options.signal);
      options.signal?.throwIfAborted();
      const delivery = result.deliveries[0];
      if (delivery) return courierOffer(this.participant, this.locator, delivery);
    }
  }
}
