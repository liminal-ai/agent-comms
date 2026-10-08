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

interface Attempt {
  eventId: string;
  ids: string[];
  /** Deliveries of this attempt the coordinator has since reported as no longer outstanding. */
  settled: Set<string>;
  /** Built once; a retry posts exactly these bytes (timestamp included) under the same id. */
  event: Event;
  body: string;
  state: "pending" | "accepted" | "terminal";
  /** Subscriptions that refused this event for good (410/413); never sent this event again. */
  refused: Set<string>;
}

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
  /** Subscriptions whose subscriber was found revoked but whose removal couldn't be saved yet: never delivered to, whatever a later access check says, until the removal lands or a fresh subscribe replaces them. */
  private readonly revoked = new Set<string>();
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
    // Read-only: active() already leaves expired entries out. Dropping them from the store happens
    // inside the serialized insert below, where no in-flight write can publish them back.
    const underLimit = () => {
      const live = this.o.store.get(id);
      return (live !== undefined && live.expiresAt > this.now()) || this.o.store.active().filter((s) => s.principal === principal).length < MAX_PER_PRINCIPAL;
    };
    // Checked here for a quick answer, and again inside the store's serialized insert, where it can't race.
    if (!underLimit()) throw new RpcError(RESOURCE_EXHAUSTED, "too many subscriptions", { limit: "subscriptions", max: MAX_PER_PRINCIPAL });
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
    // Rotation state is derived inside the serialized write, from the subscription as it is then,
    // so overlapping refreshes can't drop the secret the one before granted.
    const rotate = () => {
      const current = this.o.store.get(id);
      delete sub.previousSecret;
      delete sub.previousSecretUntil;
      if (current) {
        sub.createdAt = current.createdAt;
        if (current.lastDeliveryAt) sub.lastDeliveryAt = current.lastDeliveryAt;
        if (current.secret !== secret) {
          sub.previousSecret = current.secret;
          sub.previousSecretUntil = now + ROTATION_GRACE_MS;
        } else if (current.previousSecret && (current.previousSecretUntil ?? 0) > now) {
          sub.previousSecret = current.previousSecret;
          sub.previousSecretUntil = current.previousSecretUntil!;
        }
      }
    };
    await this.o.store.put(sub, () => {
      this.o.store.prune(); // inside the queue: expired entries leave memory and, with this write, the state file
      if (!underLimit()) throw new RpcError(RESOURCE_EXHAUSTED, "too many subscriptions", { limit: "subscriptions", max: MAX_PER_PRINCIPAL });
      rotate();
    });
    this.revoked.delete(id); // a fresh, authenticated subscribe replaces whatever was owed on the old entry
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
    this.revoked.delete(id);
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
    // Entries past their reuse window are dropped here, so the cache is bounded by what was verified
    // in the last VERIFIED_FOR_MS, not by everything ever verified.
    const cutoff = now - VERIFIED_FOR_MS;
    for (const [key, at] of this.verified) if (at <= cutoff) this.verified.delete(key);
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
  private async deliver(id: string, event: { eventId: string }, body: string): Promise<{ ok: true } | { ok: false; reason: FailureReason | "gone"; status?: number; terminal?: true }> {
    let last: { ok: false; reason: FailureReason | "gone"; status?: number; terminal?: true } = { ok: false, reason: "connection_refused" };
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt) await this.sleep(RETRY_DELAYS_MS[attempt - 1]!);
      // Re-read: a refresh may have rotated the secret, or an unsubscribe removed it, while this was waiting.
      const sub = this.o.store.get(id);
      if (!sub || sub.expiresAt <= this.now()) return { ok: false, reason: "gone", terminal: true };
      try {
        const res = await this.o.post(sub.url, this.headers(event.eventId, sub.id, this.keys(sub), body), body, TIMEOUT_MS);
        if (res.status >= 200 && res.status < 300) return { ok: true };
        last = { ok: false, reason: res.status >= 500 ? "http_5xx" : "http_4xx", status: res.status };
        // Any 4xx but 408 and 429 is final for this event at this subscriber: not retried here, and not reposted by the coordinator.
        if (res.status < 500 && res.status !== 408 && res.status !== 429) return { ...last, terminal: true };
      } catch (error) {
        last = { ok: false, reason: failureReason(error) };
        if (error instanceof BlockedUrlError) return { ...last, terminal: true };
      }
    }
    return last;
  }

  /** Deliveries that are no longer outstanding: whatever was kept to retry them is dropped, so a backlog that was answered meanwhile doesn't linger. */
  forget(participant: string, ids: string[]): void {
    const kept: Attempt[] = [];
    for (const a of this.attempts.get(participant) ?? []) {
      for (const id of ids) a.settled.add(id);
      // The event itself is kept byte-for-byte while any of its deliveries is outstanding; only once all are settled does it go.
      if (a.ids.some((id) => !a.settled.has(id))) kept.push(a);
    }
    if (kept.length) this.attempts.set(participant, kept);
    else this.attempts.delete(participant);
  }

  /** The WakeFn for one participant: an event to every live subscription; resolves if at least one accepted it. */
  waker(participant: string): WakeFn {
    const t = this.o.targets.find((x) => x.participant === participant);
    if (!t) throw new Error(`@${participant} has no mcp-events target`);
    return async (deliveryIds) => {
      // Dropping expired entries is bookkeeping; a state file that can't be written right now
      // doesn't hold up a wake that live subscribers are waiting for.
      await this.o.store.pruneExpired().catch((error: unknown) => this.o.log(`mcp: could not save the removal of expired subscriptions (${(error as NodeJS.ErrnoException)?.code ?? "error"})`));
      // A remembered revocation is only owed while its subscription still exists; one that expired or was unsubscribed meanwhile is settled.
      for (const id of this.revoked) if (!this.o.store.get(id)) this.revoked.delete(id);
      let subs = this.o.store.active(t.event);
      if (this.o.authorize) {
        const allowed: Subscription[] = [];
        for (const s of subs) {
          // Only a definite "no" drops it; if access can't be checked right now, deliver anyway,
          // unless it was already found revoked and only its removal is still owed.
          if (this.revoked.has(s.id) || (await this.o.authorize(s.principal)) === "denied") {
            // Excluded from this wake either way; persisting the removal is bookkeeping, remembered until it lands.
            await this.o.store.delete(s.id, s).then(
              () => {
                this.revoked.delete(s.id);
                this.o.log(`mcp: dropped subscription ${s.id}: its subscriber is no longer allowed`);
              },
              (error: unknown) => {
                this.revoked.add(s.id);
                this.o.log(`mcp: subscription ${s.id} is no longer allowed; could not save its removal (${(error as NodeJS.ErrnoException)?.code ?? "error"})`);
              },
            );
          } else allowed.push(s);
        }
        subs = allowed;
      }
      if (!subs.length) throw new Error(`no subscriber to ${t.event}; connect the plugin in ChatGPT and subscribe to it`);
      // Each attempt is one event pinned to an exact set of delivery ids. A retry resends the attempts
      // still pending, unchanged (same id, same body), and puts deliveries that arrived since into new
      // attempts with fresh ids. An attempt whose delivery was answered meanwhile is over.
      // An attempt stays, unchanged, while any of its deliveries is still outstanding: the receiver may
      // have processed the event already (a lost response), and only the same id lets it dedupe.
      const current = new Set(deliveryIds);
      const attempts = (this.attempts.get(participant) ?? []).filter((a) => a.ids.some((id) => current.has(id)));
      const covered = new Set(attempts.flatMap((a) => a.ids));
      for (const ids of this.chunk(participant, t.event, deliveryIds.filter((id) => !covered.has(id)).sort())) {
        const event = this.event(t.event, randomId("evt"), participant, ids);
        attempts.push({ eventId: event.eventId, ids, event, body: JSON.stringify(event), state: "pending", refused: new Set(), settled: new Set() });
      }
      this.attempts.set(participant, attempts);
      const failures: string[] = [];
      for (const a of attempts) {
        if (a.state !== "pending") continue;
        const { event, body } = a;
        const targets = subs.filter((s) => !a.refused.has(s.id));
        const results = await Promise.all(targets.map((s) => this.deliver(s.id, event, body).then((r) => ({ s, r }))));
        const now = this.now();
        let ok = false;
        let allTerminal = true;
        for (const { s, r } of results) {
          const sub = this.o.store.get(s.id);
          if (!sub) continue;
          if (r.ok) {
            ok = true;
            delete sub.failedSince;
            sub.lastDeliveryAt = now;
            continue;
          }
          // A refusal deliver() classified as final (any non-retryable 4xx, a blocked URL, a gone subscription) is never posted to it again.
          if (r.terminal) a.refused.add(s.id);
          else allTerminal = false;
          failures.push(`${hostOf(sub.url)} ${r.status ? `HTTP ${r.status}` : r.reason}`);
          sub.failedSince ??= now;
          if (now - sub.failedSince >= DROP_AFTER_FAILING_MS) {
            // Only this failed entry goes; a refresh that lands first publishes a new object and keeps it.
            const dropped = await this.o.store.delete(sub.id, sub).catch(() => false);
            if (dropped) this.o.log(`mcp: dropped subscription ${sub.id}: deliveries have failed for a day (a refresh from ChatGPT restores it)`);
          }
        }
        if (ok) a.state = "accepted";
        else if (allTerminal) a.state = "terminal";
      }
      // Bookkeeping only. A callback that answered 2xx has the event; failing the wake here would
      // make the coordinator retry with a fresh event id and start the same task again.
      await this.o.store.save().catch((error: unknown) => {
        this.o.log(`mcp: could not save delivery bookkeeping (${(error as NodeJS.ErrnoException)?.code ?? "error"}); the wake still counts`);
      });
      const pending = attempts.filter((a) => a.state === "pending").length;
      const terminal = attempts.filter((a) => a.state === "terminal").length;
      if (pending === 0) {
        // Every attempt settled: the next wake for this participant starts over.
        this.attempts.delete(participant);
        if (terminal > 0) throw new TerminalWakeError(`${terminal === attempts.length ? "every event was" : terminal === 1 ? "one event was" : `${terminal} events were`} refused for good (${failures.join(", ")})`);
        if (failures.length) this.o.log(`@${participant}: ${attempts.length === 1 ? `event ${attempts[0]!.eventId}` : `${attempts.length} events`} not accepted by ${failures.join(", ")}`);
        return;
      }
      throw new Error(`no subscriber accepted the event (${failures.join(", ") || "subscriptions went away"})`);
    };
  }

  /** Per participant, the events of the wake being retried: each pinned to its exact delivery ids. Cleared when every attempt has settled (accepted, or refused for good). */
  private readonly attempts = new Map<string, Attempt[]>();

  /** Splits ids into chunks whose events fit in 256 KiB. */
  private chunk(participant: string, name: string, ids: string[]): string[][] {
    const out: string[][] = [];
    const split = (part: string[]) => {
      if (!part.length) return;
      if (part.length > 1 && this.size(participant, name, part) > MAX_BODY) {
        split(part.slice(0, part.length >> 1));
        split(part.slice(part.length >> 1));
      } else {
        if (this.size(participant, name, part) > MAX_BODY) throw new TerminalWakeError("a single delivery id doesn't fit in a 256 KiB event");
        out.push(part);
      }
    };
    split(ids);
    return out;
  }

  private size(participant: string, name: string, ids: string[]): number {
    return Buffer.byteLength(JSON.stringify(this.event(name, "evt_00000000000000000000000000000000", participant, ids)));
  }

  private event(name: string, eventId: string, participant: string, deliveryIds: string[]): Event {
    const n = deliveryIds.length;
    return {
      eventId,
      name,
      timestamp: new Date(this.now()).toISOString(),
      data: { participant, deliveryIds, count: n, summary: `${n} comms ${n === 1 ? "delivery is" : "deliveries are"} waiting for @${participant}.` },
      cursor: null,
    };
  }

}
