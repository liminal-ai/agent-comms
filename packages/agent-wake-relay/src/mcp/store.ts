// MCP Events webhook subscriptions, kept in a JSON state file so they survive
// a restart (ChatGPT only re-subscribes near `refreshBefore`, which can be
// days away). The file holds the subscribers' signing secrets: it's written
// mode 600, atomically (temp file + rename).

import { createHash } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

export interface Subscription {
  /** Derived from the key below; sent as `X-MCP-Subscription-Id`. */
  id: string;
  /** The key: who subscribed (token `sub`), where to deliver, to which event, with which arguments (canonical JSON). */
  principal: string;
  url: string;
  event: string;
  arguments: string;
  /** `whsec_...`, as the subscriber gave it. */
  secret: string;
  /** The secret it replaced, still signed with until `previousSecretUntil` (rotation grace). */
  previousSecret?: string;
  previousSecretUntil?: number;
  createdAt: number;
  expiresAt: number;
  /** When the callback last echoed a verification challenge. */
  verifiedAt: number;
  lastDeliveryAt?: number;
  /** Delivery has failed continuously since then. Cleared by any success. */
  failedSince?: number;
}

/** JSON with object keys sorted at every level, so `{a,b}` and `{b,a}` are one subscription. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function subscriptionId(principal: string, url: string, event: string, args: string): string {
  return `sub_${createHash("sha256").update(canonicalJson([principal, url, event, args])).digest("hex").slice(0, 32)}`;
}

export class SubscriptionStore {
  private readonly subs = new Map<string, Subscription>();
  private writing: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  /** Read the state file, if there is one, dropping what has expired. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const state = JSON.parse(raw) as { version?: number; subscriptions?: Subscription[] };
    if (state.version !== 1 || !Array.isArray(state.subscriptions)) throw new Error(`${this.path}: not an agent-wake-relay state file`);
    for (const s of state.subscriptions) this.subs.set(s.id, s);
    if (this.prune()) await this.save();
  }

  get(id: string): Subscription | undefined {
    return this.subs.get(id);
  }

  /** Live subscriptions, optionally only one event's. */
  active(event?: string): Subscription[] {
    const now = this.now();
    return [...this.subs.values()].filter((s) => s.expiresAt > now && (event === undefined || s.event === event));
  }

  /** Adds or replaces a subscription. If the state file can't be written, the live map is left as it was. */
  async put(sub: Subscription): Promise<void> {
    const previous = this.subs.get(sub.id);
    this.subs.set(sub.id, sub);
    try {
      await this.save();
    } catch (error) {
      if (previous) this.subs.set(sub.id, previous);
      else this.subs.delete(sub.id);
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const previous = this.subs.get(id);
    if (!previous) return false;
    this.subs.delete(id);
    try {
      await this.save();
    } catch (error) {
      this.subs.set(id, previous);
      throw error;
    }
    return true;
  }

  /** Drop expired subscriptions. Returns whether anything went. */
  prune(): boolean {
    const now = this.now();
    let changed = false;
    for (const [id, s] of this.subs) {
      if (s.expiresAt <= now) {
        this.subs.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Writes are serialized; each one writes the whole current state. */
  save(): Promise<void> {
    const next = this.writing.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`;
      const body = `${JSON.stringify({ version: 1, subscriptions: [...this.subs.values()] }, null, 2)}\n`;
      await writeFile(tmp, body, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
