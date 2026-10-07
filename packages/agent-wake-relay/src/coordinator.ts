// Decides when to wake one sandboxed agent. It sees the connector's work
// subscription for the agent's machine (deliveries that still need action),
// and wakes the agent when a delivery for it appears. A burst is coalesced
// into one wake; a failed wake is retried; a delivery still outstanding after
// `renudgeMs` gets one more wake, in case the agent slept through the first.

export interface WorkDelivery {
  id: string;
  recipient: string;
  state: string;
  createdAt: number;
}

/** Wakes the agent. Rejects when the wake didn't land. */
export type WakeFn = (deliveryIds: string[]) => Promise<void>;

export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Node's largest timer delay (2^31-1 ms, ~24.8 days); longer waits fire immediately. */
export const MAX_TIMER_MS = 2_147_483_647;

const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface CoordinatorOptions {
  participant: string;
  wake: WakeFn;
  log: (line: string) => void;
  timers?: Timers;
  /** Wait this long after a new delivery so a burst becomes one wake. Default 2 s. */
  coalesceMs?: number;
  /** Retry a failed wake after this long. Default 30 s. */
  retryMs?: number;
  /** Wake again if a delivery is still outstanding this long after its last wake. Default 10 min; 0 turns it off. */
  renudgeMs?: number;
}

export class Coordinator {
  private readonly o: Required<Omit<CoordinatorOptions, "timers">> & { timers: Timers };
  /** Outstanding deliveries for the participant → when they were last woken for (0 = not yet). */
  /** Delivery id -> when it was last woken for (0 = never). */
  private readonly outstanding = new Map<string, number>();
  /** Delivery id -> the state seen at its last wake, so a later handoff to `delivered` wakes again. */
  private readonly stateAtWake = new Map<string, string>();
  private first = true;
  private timer: unknown = null;
  private renudgeTimer: unknown = null;
  private inFlight = false;
  /** The last failure logged, so a wake that keeps failing the same way is logged every 5 min, not every retry. */
  private lastFailure: { message: string; at: number; repeats: number } | null = null;

  constructor(options: CoordinatorOptions) {
    this.o = { coalesceMs: 2_000, retryMs: 30_000, renudgeMs: 10 * 60_000, timers: realTimers, ...options };
  }

  /** Feed each new value of the work subscription. */
  update(deliveries: WorkDelivery[]): void {
    const mine = deliveries.filter((d) => d.recipient === this.o.participant);
    const ids = new Set(mine.map((d) => d.id));
    for (const id of [...this.outstanding.keys()]) {
      if (ids.has(id)) continue;
      this.outstanding.delete(id);
      this.stateAtWake.delete(id);
    }
    let fresh = 0;
    for (const d of mine) {
      if (!this.outstanding.has(d.id)) {
        this.outstanding.set(d.id, 0);
        this.stateAtWake.set(d.id, d.state);
        fresh++;
        continue;
      }
      // Machines with a connector (grok-box) hand items over one at a time; a request that was still
      // `pending` at the last wake reaches the agent's inbox later, as `delivered`. Wake again then.
      if (d.state === "delivered" && this.stateAtWake.get(d.id) !== "delivered" && this.outstanding.get(d.id)! > 0) {
        this.outstanding.set(d.id, 0);
        this.stateAtWake.set(d.id, d.state);
        fresh++;
      }
    }
    if (this.first) {
      this.first = false;
      this.o.log(`@${this.o.participant}: watching; ${mine.length} outstanding at start`);
    }
    if (fresh) this.schedule(this.o.coalesceMs);
    this.scheduleRenudge();
  }

  close(): void {
    if (this.timer) this.o.timers.clear(this.timer);
    if (this.renudgeTimer) this.o.timers.clear(this.renudgeTimer);
    this.timer = this.renudgeTimer = null;
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = this.o.timers.set(() => {
      this.timer = null;
      void this.fire();
    }, Math.min(ms, MAX_TIMER_MS));
  }

  /** Deliveries that were never woken for, or whose last wake is older than renudgeMs. */
  private due(): string[] {
    const now = this.o.timers.now();
    const out: string[] = [];
    for (const [id, at] of this.outstanding) {
      if (at === 0 || (this.o.renudgeMs > 0 && now - at >= this.o.renudgeMs)) out.push(id);
    }
    return out;
  }

  private async fire(): Promise<void> {
    if (this.inFlight) return this.schedule(this.o.coalesceMs);
    const ids = this.due();
    if (!ids.length) return;
    this.inFlight = true;
    try {
      await this.o.wake(ids);
      const now = this.o.timers.now();
      for (const id of ids) if (this.outstanding.has(id)) this.outstanding.set(id, now);
      this.lastFailure = null;
      this.o.log(`@${this.o.participant}: woke for ${ids.length} delivery(s) ${ids.join(",")}`);
    } catch (error) {
      const message = (error as Error).message;
      const now = this.o.timers.now();
      const last = this.lastFailure;
      if (last && last.message === message && now - last.at < 5 * 60_000) last.repeats++;
      else {
        const again = last?.message === message && last.repeats ? ` (failed the same way ${last.repeats} more time(s) since the last report)` : "";
        this.o.log(`@${this.o.participant}: wake failed for ${ids.join(",")}: ${message}${again}; retrying every ${Math.round(this.o.retryMs / 1000)}s`);
        this.lastFailure = { message, at: now, repeats: 0 };
      }
      this.schedule(this.o.retryMs);
    } finally {
      this.inFlight = false;
    }
    this.scheduleRenudge();
  }

  private scheduleRenudge(): void {
    if (this.renudgeTimer) this.o.timers.clear(this.renudgeTimer);
    this.renudgeTimer = null;
    if (this.o.renudgeMs <= 0) return;
    const woken = [...this.outstanding.values()].filter((at) => at > 0);
    if (!woken.length) return;
    const next = Math.min(...woken) + this.o.renudgeMs - this.o.timers.now();
    // Node fires a timer past its limit at once; wait in chunks and re-check what is actually due.
    this.renudgeTimer = this.o.timers.set(() => {
      this.renudgeTimer = null;
      if (this.due().length) this.schedule(0);
      else this.scheduleRenudge();
    }, Math.min(Math.max(0, next), MAX_TIMER_MS));
  }
}
