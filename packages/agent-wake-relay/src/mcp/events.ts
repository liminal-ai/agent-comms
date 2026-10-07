// MCP Events for comms deliveries: one event per agent woken this way
// (`comms.delivery.<participant>` unless the target names another), which
// ChatGPT subscribes to with a webhook callback. Waking the agent means
// sending a signed event to every live subscription for its event. The event
// says only that deliveries are waiting (their ids); the agent reads and
// answers them through its normal comms path.

import { timingSafeEqual } from "node:crypto";
import { TerminalWakeError, type WakeFn } from "../coordinator.ts";
import type { Access } from "./auth.ts";
import { canonicalJson, subscriptionId, type Subscription, type SubscriptionStore } from "./store.ts";
import { BlockedUrlError, failureReason, parseSecret, randomId, sign, urlProblem, type FailureReason, type Post, type UrlPolicy } from "./webhook.ts";

/** A JSON-RPC error to hand back to the caller. Codes per the MCP Events draft. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const INVALID_PARAMS = -32602;
export const NOT_FOUND = -32011;
export const RESOURCE_EXHAUSTED = -32013;
export const UNSUPPORTED = -32014;
export const CALLBACK_ENDPOINT_ERROR = -32015;

export interface EventTarget {
  participant: string;
  event: string;
}

export interface EventHubOptions {
  targets: EventTarget[];
  store: SubscriptionStore;
  post: Post;
  /** Which callback URLs are acceptable at subscribe time. Delivery enforces the same through `post`. */
  urlPolicy?: UrlPolicy;
  /** Re-checks a subscriber's access before each delivery; a `denied` subscriber's subscription is dropped. */
  authorize?: (principal: string) => Promise<Access>;
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Longest subscription granted (also the default). Default 30 days. */
  maxTtlMs?: number;
}

const MIN_TTL_MS = 60_000;
const VERIFIED_FOR_MS = 24 * 3_600_000;
const ROTATION_GRACE_MS = 10 * 60_000;
const DROP_AFTER_FAILING_MS = 24 * 3_600_000;
const MAX_PER_PRINCIPAL = 20;
const TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 4_000];
const MAX_BODY = 256 * 1024;
/** How long a settled batch of a split wake is remembered; longer than the coordinator's 30 s retries, shorter than its 10 min renudge. */
const SETTLED_TTL_MS = 5 * 60_000;

interface Event {
  eventId: string;
  name: string;
  timestamp: string;
  data: { participant: string; deliveryIds: string[]; count: number; summary: string };
  cursor: null;
}

const payloadSchema = {
  type: "object",
  properties: {
    participant: { type: "string", description: "The agent the deliveries are for." },
    deliveryIds: { type: "array", items: { type: "string" }, description: "Comms delivery ids waiting for an answer." },
    count: { type: "integer" },
    summary: { type: "string", description: "A one-line, fixed description of what is waiting. Never message text." },
  },
  required: ["participant", "deliveryIds", "count", "summary"],
  additionalProperties: false,
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class EventHub {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxTtlMs: number;
  /** (principal, url) → when its callback last passed verification. */
  private readonly verified = new Map<string, number>();
  private readonly o: EventHubOptions;

  constructor(o: EventHubOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxTtlMs = o.maxTtlMs ?? 30 * 86_400_000;
  }

  /** `events/list` entries. */
  definitions() {
    return this.o.targets.map((t) => ({
      name: t.event,
      description: `A comms delivery (a message or a request) is waiting for @${t.participant} in agent-comms. The event carries only delivery ids, never message text; read and answer what's waiting through @${t.participant}'s comms inbox.`,
      delivery: ["webhook"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      payloadSchema,
    }));
  }

  private target(event: unknown): EventTarget {
    const t = this.o.targets.find((x) => x.event === event);
    if (!t) throw new RpcError(NOT_FOUND, `unknown event: ${String(event)}`, { kind: "event" });
    return t;
  }

  private args(value: unknown): string {
    const args = value ?? {};
    if (!isPlainObject(args)) throw new RpcError(INVALID_PARAMS, "arguments must be an object");
    if (Object.keys(args).length) throw new RpcError(INVALID_PARAMS, "this event takes no arguments");
    return canonicalJson(args);
  }

  private url(delivery: Record<string, unknown>): string {
    if (typeof delivery.url !== "string") throw new RpcError(INVALID_PARAMS, "delivery.url is required");
    const problem = urlProblem(delivery.url, this.o.urlPolicy);
    if (problem) throw new RpcError(INVALID_PARAMS, `delivery.url ${problem}`);
    return delivery.url;
  }

  private delivery(params: Record<string, unknown>): Record<string, unknown> {
    const d = params.delivery;
    if (!isPlainObject(d)) throw new RpcError(INVALID_PARAMS, "delivery is required");
    if (d.mode !== undefined && d.mode !== "webhook") throw new RpcError(UNSUPPORTED, "only webhook delivery is offered", { feature: "deliveryMode", value: d.mode });
    return d;
  }

  private grant(ttlMs: unknown): number {
    // No expiry (`ttlMs: null`) isn't granted; a finite grant is the sanctioned answer.
    if (ttlMs === undefined || ttlMs === null) return this.maxTtlMs;
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) throw new RpcError(INVALID_PARAMS, "ttlMs must be a non-negative number or null");
    return Math.min(this.maxTtlMs, Math.max(MIN_TTL_MS, ttlMs));
  }

  /** `events/subscribe`: create or refresh the subscription keyed on (principal, url, event, arguments). */
  async subscribe(principal: string, params: Record<string, unknown>) {
    const t = this.target(params.name);
    const args = this.args(params.arguments);
    const delivery = this.delivery(params);
    const url = this.url(delivery);
    if (!parseSecret(delivery.secret)) throw new RpcError(INVALID_PARAMS, "delivery.secret must be whsec_ followed by base64 of 24-64 bytes");
    const secret = delivery.secret as string;
    const ttl = this.grant(params.ttlMs);
    const id = subscriptionId(principal, url, t.event, args);
    const now = this.now();
    const existing = this.o.store.get(id);
    if (!existing && this.o.store.active().filter((s) => s.principal === principal).length >= MAX_PER_PRINCIPAL) {
      throw new RpcError(RESOURCE_EXHAUSTED, "too many subscriptions", { limit: "subscriptions", max: MAX_PER_PRINCIPAL });
    }
    const verifiedAt = this.recentlyVerified(principal, url) ?? (await this.verify(principal, id, url, secret));
    const sub: Subscription = {
      id,
      principal,
      url,
      event: t.event,
      arguments: args,
      secret,
      createdAt: existing?.createdAt ?? now,
      expiresAt: now + ttl,
      verifiedAt,
      ...(existing?.lastDeliveryAt ? { lastDeliveryAt: existing.lastDeliveryAt } : {}),
    };
    if (existing && existing.secret !== secret) {
      sub.previousSecret = existing.secret;
      sub.previousSecretUntil = now + ROTATION_GRACE_MS;
    } else if (existing?.previousSecret && (existing.previousSecretUntil ?? 0) > now) {
      sub.previousSecret = existing.previousSecret;
      sub.previousSecretUntil = existing.previousSecretUntil!;
    }
    await this.o.store.put(sub);
    this.o.log(`mcp: ${existing ? "refreshed" : "new"} subscription ${id} to ${t.event} (callback host ${hostOf(url)}) until ${new Date(sub.expiresAt).toISOString()}`);
    return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false };
  }

  /** `events/unsubscribe`: idempotent; only the subscriber's own subscription can match. */
  async unsubscribe(principal: string, params: Record<string, unknown>): Promise<void> {
    const t = this.target(params.name);
    const args = this.args(params.arguments);
    const d = params.delivery;
    if (!isPlainObject(d) || typeof d.url !== "string") throw new RpcError(INVALID_PARAMS, "delivery.url is required");
    const id = subscriptionId(principal, d.url, t.event, args);
    if (await this.o.store.delete(id)) this.o.log(`mcp: unsubscribed ${id} from ${t.event}`);
  }

  private recentlyVerified(principal: string, url: string): number | undefined {
    const cutoff = this.now() - VERIFIED_FOR_MS;
    const at = Math.max(
      this.verified.get(`${principal}\n${url}`) ?? 0,
      ...this.o.store.active().filter((s) => s.principal === principal && s.url === url).map((s) => s.verifiedAt),
    );
    return at > cutoff ? at : undefined;
  }

  /** Send the verification challenge and require it echoed in a 2xx, before anything else goes to the URL. */
  private async verify(principal: string, id: string, url: string, secret: string): Promise<number> {
    const challenge = randomId("chl");
    const body = JSON.stringify({ type: "verification", challenge });
    const msgId = randomId("msg_verification");
    let res;
    try {
      res = await this.o.post(url, this.headers(msgId, id, [parseSecret(secret)!], body), body, TIMEOUT_MS);
    } catch (error) {
      if (error instanceof BlockedUrlError) throw new RpcError(INVALID_PARAMS, `delivery.url: ${error.message}`);
      throw new RpcError(CALLBACK_ENDPOINT_ERROR, "callback verification failed", { reason: failureReason(error) });
    }
    if (res.status < 200 || res.status >= 300) {
      throw new RpcError(CALLBACK_ENDPOINT_ERROR, "callback verification failed", { reason: res.status >= 500 ? "http_5xx" : "http_4xx" });
    }
    let echoed: unknown;
    try {
      echoed = (JSON.parse(res.body) as { challenge?: unknown }).challenge;
    } catch {}
    const a = Buffer.from(typeof echoed === "string" ? echoed : "");
    const b = Buffer.from(challenge);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new RpcError(CALLBACK_ENDPOINT_ERROR, "callback verification failed", { reason: "challenge_failed" });
    }
    const now = this.now();
    this.verified.set(`${principal}\n${url}`, now);
    return now;
  }

  private headers(webhookId: string, subscription: string, keys: Buffer[], body: string): Record<string, string> {
    const ts = Math.floor(this.now() / 1000);
    return {
      "content-type": "application/json",
      "user-agent": "agent-comms-agent-wake-relay",
      "webhook-id": webhookId,
      "webhook-timestamp": String(ts),
      "webhook-signature": sign(keys, webhookId, ts, body),
      "x-mcp-subscription-id": subscription,
    };
  }

  /** The keys to sign with: the current secret, plus the previous one during a rotation's grace window. */
  private keys(sub: Subscription): Buffer[] {
    const keys = [parseSecret(sub.secret)!];
    if (sub.previousSecret && (sub.previousSecretUntil ?? 0) > this.now()) keys.push(parseSecret(sub.previousSecret)!);
    return keys;
  }

  /** POST one event to one subscription, retrying transient failures with the same eventId and a fresh signature. */
  private async deliver(id: string, event: { eventId: string }, body: string): Promise<{ ok: true } | { ok: false; reason: FailureReason | "gone"; status?: number }> {
    let last: { ok: false; reason: FailureReason | "gone"; status?: number } = { ok: false, reason: "connection_refused" };
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt) await this.sleep(RETRY_DELAYS_MS[attempt - 1]!);
      // Re-read: a refresh may have rotated the secret, or an unsubscribe removed it, while this was waiting.
      const sub = this.o.store.get(id);
      if (!sub) return { ok: false, reason: "gone" };
      try {
        const res = await this.o.post(sub.url, this.headers(event.eventId, sub.id, this.keys(sub), body), body, TIMEOUT_MS);
        if (res.status >= 200 && res.status < 300) return { ok: true };
        last = { ok: false, reason: res.status >= 500 ? "http_5xx" : "http_4xx", status: res.status };
        // 410 and 413 are final for this event; so is any other 4xx but 408 and 429.
        if (res.status < 500 && res.status !== 408 && res.status !== 429) return last;
      } catch (error) {
        last = { ok: false, reason: failureReason(error) };
        if (error instanceof BlockedUrlError) return last;
      }
    }
    return last;
  }

  /** The WakeFn for one participant: an event to every live subscription; resolves if at least one accepted it. */
  waker(participant: string): WakeFn {
    const t = this.o.targets.find((x) => x.participant === participant);
    if (!t) throw new Error(`@${participant} has no mcp-events target`);
    return async (deliveryIds) => {
      if (this.o.store.prune()) await this.o.store.save();
      let subs = this.o.store.active(t.event);
      if (this.o.authorize) {
        const allowed: Subscription[] = [];
        for (const s of subs) {
          // Only a definite "no" drops it; if access can't be checked right now, deliver anyway.
          if ((await this.o.authorize(s.principal)) === "denied") {
            await this.o.store.delete(s.id);
            this.o.log(`mcp: dropped subscription ${s.id}: its subscriber is no longer allowed`);
          } else allowed.push(s);
        }
        subs = allowed;
      }
      if (!subs.length) throw new Error(`no subscriber to ${t.event}; connect the plugin in ChatGPT and subscribe to it`);
      // One event per batch that fits in 256 KiB; a backlog too big for one event is still woken for.
      const batches = this.batches(participant, t.event, deliveryIds);
      const failures: string[] = [];
      let accepted = 0;
      let terminal = 0;
      for (const { key, event, body } of batches) {
        // A batch already accepted (or refused for good) during an earlier attempt at this wake isn't sent again.
        const settled = this.settled.get(key);
        if (settled && this.now() - settled.at < SETTLED_TTL_MS) {
          if (settled.ok) accepted++;
          else terminal++;
          continue;
        }
        const results = await Promise.all(subs.map((s) => this.deliver(s.id, event, body).then((r) => ({ s, r }))));
        const now = this.now();
        let ok = false;
        let allTerminal = true;
        for (const { s, r } of results) {
          const current = this.o.store.get(s.id);
          if (!current) continue;
          if (r.ok) {
            ok = true;
            delete current.failedSince;
            current.lastDeliveryAt = now;
            continue;
          }
          // 410 (gone) and 413 (too large) are final for this event: it must not be posted again.
          if (!(r.status === 410 || r.status === 413 || r.reason === "gone")) allTerminal = false;
          failures.push(`${hostOf(current.url)} ${r.status ? `HTTP ${r.status}` : r.reason}`);
          current.failedSince ??= now;
          if (now - current.failedSince >= DROP_AFTER_FAILING_MS) {
            await this.o.store.delete(current.id).catch(() => {});
            this.o.log(`mcp: dropped subscription ${current.id}: deliveries have failed for a day (a refresh from ChatGPT restores it)`);
          }
        }
        if (ok || allTerminal) {
          this.pending.delete(key);
          this.settled.set(key, { ok, at: now });
        }
        if (ok) accepted++;
        else if (allTerminal) terminal++;
      }
      // Every batch settled: the next wake for this set is a new attempt.
      if (accepted + terminal === batches.length) for (const { key } of batches) this.settled.delete(key);
      // Bookkeeping only. A callback that answered 2xx has the event; failing the wake here would
      // make the coordinator retry with a fresh event id and start the same task again.
      await this.o.store.save().catch((error: unknown) => {
        this.o.log(`mcp: could not save delivery bookkeeping (${(error as NodeJS.ErrnoException)?.code ?? "error"}); the wake still counts`);
      });
      if (accepted === batches.length) {
        if (failures.length) this.o.log(`@${participant}: ${batches.length === 1 ? `event ${batches[0]!.event.eventId}` : `${batches.length} events`} not accepted by ${failures.join(", ")}`);
        return;
      }
      if (accepted === 0 && terminal === batches.length) throw new TerminalWakeError(`every subscriber refused the event for good (${failures.join(", ")})`);
      throw new Error(`no subscriber accepted the event (${failures.join(", ") || "subscriptions went away"})`);
    };
  }

  /** Event ids held for wakes the coordinator may retry, so a retry carries the same id and the receiver can dedupe it. Keyed by participant and delivery set. */
  private readonly pending = new Map<string, string>();
  /** Batches of a split wake that already settled (accepted, or refused for good), so a retry of the whole wake only resends the rest. */
  private readonly settled = new Map<string, { ok: boolean; at: number }>();

  private batches(participant: string, name: string, deliveryIds: string[]): { key: string; event: Event; body: string }[] {
    const make = (ids: string[]) => {
      const key = `${participant}\u0000${[...ids].sort().join(",")}`;
      let eventId = this.pending.get(key);
      if (!eventId) {
        eventId = randomId("evt");
        this.pending.set(key, eventId);
      }
      const n = ids.length;
      const event: Event = {
        eventId,
        name,
        timestamp: new Date(this.now()).toISOString(),
        data: { participant, deliveryIds: ids, count: n, summary: `${n} comms ${n === 1 ? "delivery is" : "deliveries are"} waiting for @${participant}.` },
        cursor: null,
      };
      return { key, event, body: JSON.stringify(event) };
    };
    const out: { key: string; event: Event; body: string }[] = [];
    const split = (ids: string[]) => {
      const b = make(ids);
      if (Buffer.byteLength(b.body) <= MAX_BODY || ids.length === 1) {
        if (Buffer.byteLength(b.body) > MAX_BODY) throw new TerminalWakeError("a single delivery id doesn't fit in a 256 KiB event");
        out.push(b);
        return;
      }
      this.pending.delete(b.key);
      split(ids.slice(0, ids.length >> 1));
      split(ids.slice(ids.length >> 1));
    };
    split(deliveryIds);
    return out;
  }
}
