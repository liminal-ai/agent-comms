// MCP Events webhook subscriptions, kept in a JSON state file so they survive
// a restart (ChatGPT only re-subscribes near `refreshBefore`, which can be
// days away). The file holds the subscribers' signing secrets: it's written
// mode 600, atomically (temp file + rename).

import { createHash } from "node:crypto";
import { chmod, open, readFile, rename } from "node:fs/promises";

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
  private subs: Map<string, Subscription> = new Map<string, Subscription>();
  private readonly path: string;
  private readonly now: () => number;

  private readonly log: (line: string) => void;

  constructor(path: string, now: () => number = Date.now, log: (line: string) => void = () => {}) {
    this.log = log;
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
    let state: { version?: number; subscriptions?: Subscription[] };
    try {
      state = JSON.parse(raw) as typeof state;
      if (state.version !== 1 || !Array.isArray(state.subscriptions)) throw new Error("not an agent-wake-relay state file");
      // Each entry too: a null or malformed one would otherwise throw past this recovery and keep every waker down.
      for (const s of state.subscriptions) {
        if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.url !== "string" || typeof s.event !== "string" || typeof s.expiresAt !== "number") throw new Error("not an agent-wake-relay state file (bad subscription entry)");
      }
    } catch (error) {
      // A damaged file mustn't keep every waker down (the webhook targets don't even use it). Keep it
      // for inspection and start empty; subscribers re-subscribe from ChatGPT.
      const aside = `${this.path}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
      await rename(this.path, aside);
      this.log(`mcp: state file unreadable (${(error as Error).message.slice(0, 60)}); moved to ${aside} and starting with no subscriptions`);
      return;
    }
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

  /** Mutations and direct saves run one at a time, each save writing the state as it is at its turn, so a rollback only ever sees the state it started from and a save queued ahead of a mutation never carries that mutation. */
  private ops: Promise<unknown> = Promise.resolve();
  private serialized<T>(op: () => Promise<T>): Promise<T> {
    const next = this.ops.then(op, op);
    this.ops = next.catch(() => {});
    return next;
  }

  /** Adds or replaces a subscription. If the state file can't be written, the live map is left as it was. */
  put(sub: Subscription, guard?: () => void): Promise<void> {
    return this.serialized(async () => {
      // Runs inside the queue, so a limit it checks can't be raced by another insert.
      guard?.();
      // The proposed state is written first and published only once it's on disk, so nothing
      // reads a subscription that may yet fail to persist.
      const next = new Map(this.subs);
      next.set(sub.id, sub);
      await this.write(next);
      this.subs = next;
    });
  }

  /** Removes a subscription. With `onlyIf`, removes it only if the store still holds that exact object: a refresh that landed meanwhile publishes a new one and is left alone. */
  delete(id: string, onlyIf?: Subscription): Promise<boolean> {
    return this.serialized(async () => {
      if (!this.subs.has(id)) return false;
      if (onlyIf !== undefined && this.subs.get(id) !== onlyIf) return false;
      const next = new Map(this.subs);
      next.delete(id);
      await this.write(next);
      this.subs = next;
      return true;
    });
  }

  /** Drop expired subscriptions and persist that, at this call's turn in the queue, so an in-flight mutation can't publish them back. Resolves to whether anything went. */
  pruneExpired(): Promise<boolean> {
    return this.serialized(async () => {
      const now = this.now();
      const next = new Map([...this.subs].filter(([, s]) => s.expiresAt > now));
      if (next.size === this.subs.size) return false;
      await this.write(next);
      this.subs = next;
      return true;
    });
  }

  /** Drop expired subscriptions from the live map only. Call it from inside the queue (a put guard); elsewhere use pruneExpired(). Returns whether anything went. */
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

  /** Persists the current state at its turn in the queue (after any mutation already queued, before any queued later). */
  save(): Promise<void> {
    return this.serialized(() => this.write(this.subs));
  }

  private async write(subs: Map<string, Subscription>): Promise<void> {
    const tmp = `${this.path}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ version: 1, subscriptions: [...subs.values()] }, null, 2)}\n`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync(); // on disk before the rename makes it the state
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
