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
  /** A claimed delivery's lease; while it's live the agent is working on it and isn't woken again. */
  claim?: { leaseExpiresAt: number };
}

/**
 * Wakes the agent. Rejects when the wake didn't land. `wakeId` is stable across retries of the same
 * delivery set (a receiver can dedupe) and changes when the set changes.
 */
export type WakeFn = (deliveryIds: string[], info?: { wakeId: string }) => Promise<void>;

/** Renudges after the first wake: the k-th renudge waits this many times `renudgeMs`. Then it stops. */
export const RENUDGE_STEPS = [1, 3, 12];
/** Failed-wake retries back off from `retryMs`, doubling, up to this many times `retryMs`. */
export const RETRY_MAX_FACTOR = 10;
/** After this many consecutive failed retries the wake is given up until something changes. */
export const RETRY_GIVE_UP = 12;

/** A wake the waker will never get through as-is (every callback answered 410/413, or the batch can't be sent). Not retried every 30 s; the renudge timer tries again later. */
export class TerminalWakeError extends Error {
  readonly terminal = true;
}

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
  /** Called with the ids of deliveries that are no longer outstanding, so a waker can drop what it kept for them. */
  forget?: (ids: string[]) => void;
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
  private readonly o: Required<Omit<CoordinatorOptions, "timers" | "forget">> & { timers: Timers; forget?: (ids: string[]) => void };
  /** Outstanding deliveries for the participant → when they were last woken for (0 = not yet). */
  /** Delivery id -> when it was last woken for (0 = never). */
  private readonly outstanding = new Map<string, number>();
  /** Delivery id -> the state seen at its last wake, so a later handoff to `delivered` wakes again. */
  private readonly stateAtWake = new Map<string, string>();
  /** Delivery id -> how many wakes it has had (the first, plus renudges). */
  private readonly wakes = new Map<string, number>();
  /** Deliveries whose renudges are used up; logged once each. */
  private readonly exhausted = new Set<string>();
  /**
   * Deliveries that left the work list before the agent was ever woken for them. On a machine with a
   * connector (grok-box) an answer is claimed and handed to the agent's inbox within the coalesce window
   * and then has nothing left to do, so it drops out of the query; the agent still has to be woken to
   * read it. Each is owed one wake, then forgotten.
   */
  private readonly owed = new Set<string>();
  /** Consecutive failed retries of the current wake; reset by success or by anything new to wake for. */
  private failures = 0;
  private gaveUp = false;
  /** The wake id for the delivery set currently being woken for; reused while that set is retried. */
  private wakeId: { key: string; id: string } | null = null;
  private wakeSeq = 0;
  private first = true;
  private timer: unknown = null;
  private renudgeTimer: unknown = null;
  private inFlight = false;
  /** For the wake in flight: each id's state when it started, and the ids that reached `delivered` since. */
  private inFlightStates: Map<string, string> | null = null;
  private readonly transitioned = new Set<string>();
  /** The last failure logged, so a wake that keeps failing the same way is logged every 5 min, not every retry. */
  private lastFailure: { message: string; at: number; repeats: number } | null = null;

  constructor(options: CoordinatorOptions) {
    this.o = { coalesceMs: 2_000, retryMs: 30_000, renudgeMs: 10 * 60_000, timers: realTimers, ...options };
  }

  /** Feed each new value of the work subscription. */
  /** The latest view of each outstanding delivery (state, lease). */
  private readonly latest = new Map<string, WorkDelivery>();

  update(deliveries: WorkDelivery[]): void {
    const mine = deliveries.filter((d) => d.recipient === this.o.participant);
    this.latest.clear();
    for (const d of mine) this.latest.set(d.id, d);
    const ids = new Set(mine.map((d) => d.id));
    const gone: string[] = [];
    let fresh = 0;
    for (const id of [...this.outstanding.keys()]) {
      if (ids.has(id)) continue;
      // Gone before its first wake, after the connector had taken it (claimed or delivered): the agent has it in its
      // inbox and is still owed one wake. One that vanishes while still `pending` was never handed over (the participant
      // was paused, or the message withdrawn), so nothing is owed. If a wake carrying it is out, that wake's outcome
      // settles it: success clears the debt, a failed one retries with it.
      if (this.outstanding.get(id) === 0 && this.stateAtWake.get(id) !== "pending") {
        this.owed.add(id);
        if (!this.inFlightStates?.has(id)) fresh++;
      }
      this.outstanding.delete(id);
      this.stateAtWake.delete(id);
      this.transitioned.delete(id);
      this.wakes.delete(id);
      this.exhausted.delete(id);
      gone.push(id);
    }
    if (gone.length) this.o.forget?.(gone);
    for (const d of mine) {
      if (!this.outstanding.has(d.id)) {
        // If a never-woken delivery reappears in the work list, it is no longer "owed":
        // drop it from `owed` to keep the sets disjoint and avoid duplicate wakes.
        this.owed.delete(d.id);
        this.outstanding.set(d.id, 0);
        this.stateAtWake.set(d.id, d.state);
        fresh++;
        continue;
      }
      // Not woken for yet (coalescing): the state the wake will cover is the latest one. During an
      // in-flight wake, a handoff to `delivered` happened after the event was built: note it, so the
      // wake that follows carries it rather than the current one appearing to.
      if (this.outstanding.get(d.id) === 0) {
        const started = this.inFlightStates?.get(d.id);
        if (started !== undefined && started !== "delivered" && d.state === "delivered") this.transitioned.add(d.id);
        else {
          const prev = this.stateAtWake.get(d.id);
          this.stateAtWake.set(d.id, d.state);
          // A delivery that flips to delivered while still at 0 (never woken) must schedule a wake.
          if (d.state === "delivered" && prev !== "delivered") fresh++;
        }
        continue;
      }
      // Machines with a connector (grok-box) hand items over one at a time; a request that was still
      // `pending` at the last wake reaches the agent's inbox later, as `delivered`. Wake again then.
      if (d.state === "delivered" && this.stateAtWake.get(d.id) !== "delivered") {
        // During an in-flight renudge the event was built before this handoff: note it for the wake that follows.
        const started = this.inFlightStates?.get(d.id);
        if (started !== undefined && started !== "delivered") {
          this.transitioned.add(d.id);
          continue;
        }
        this.outstanding.set(d.id, 0);
        this.stateAtWake.set(d.id, d.state);
        fresh++;
      }
    }
    if (this.first) {
      this.first = false;
      this.o.log(`@${this.o.participant}: watching; ${mine.length} outstanding at start`);
    }
    if (fresh) {
      // Something new to wake for: a give-up or a backed-off retry no longer applies to it.
      this.failures = 0;
      this.gaveUp = false;
      this.schedule(this.o.coalesceMs);
    }
    this.scheduleRenudge();
  }

  close(): void {
    if (this.timer) this.o.timers.clear(this.timer);
    if (this.renudgeTimer) this.o.timers.clear(this.renudgeTimer);
    this.timer = this.renudgeTimer = null;
  }

  private timerDue = 0;

  /** Fires in `ms`; an earlier request replaces a later pending one (a new delivery during a 30 s retry wait gets the 2 s coalesce). */
  private schedule(ms: number): void {
    const wait = Math.min(ms, MAX_TIMER_MS);
    const due = this.o.timers.now() + wait;
    if (this.timer) {
      if (due >= this.timerDue) return;
      this.o.timers.clear(this.timer);
    }
    this.timerDue = due;
    this.timer = this.o.timers.set(() => {
      this.timer = null;
      void this.fire();
    }, wait);
  }

  /** Handoffs to delivered that landed while a wake was out get their own wake, whatever became of that wake. */
  private wakeAgainForHandoffs(): void {
    let again = 0;
    for (const id of this.transitioned) {
      if (!this.outstanding.has(id)) continue;
      this.outstanding.set(id, 0);
      this.stateAtWake.set(id, "delivered");
      again++;
    }
    this.transitioned.clear();
    if (again) {
      // Something new to wake for: a give-up no longer applies.
      this.failures = 0;
      this.gaveUp = false;
      this.schedule(this.o.coalesceMs);
    }
  }

  /**
   * A subscriber (an MCP Events callback) became available. Deliveries whose wakes were spent while nothing could
   * receive them, including ones that ran out of renudges, are woken for again, once, now. Costs one wake per
   * outstanding delivery per (rare) subscriber connect.
   */
  subscriberAvailable(): void {
    let n = 0;
    for (const id of this.outstanding.keys()) {
      this.outstanding.set(id, 0);
      this.wakes.delete(id);
      this.exhausted.delete(id);
      n++;
    }
    if (!n) return;
    this.failures = 0;
    this.gaveUp = false;
    this.o.log(`@${this.o.participant}: a subscriber connected; waking again for ${n} outstanding delivery(s)`);
    this.schedule(this.o.coalesceMs);
  }

  /** When the next renudge of a delivery is due, or null when it has none left (or renudging is off). */
  private renudgeAt(id: string, lastWakeAt: number): number | null {
    if (this.o.renudgeMs <= 0) return null;
    const step = RENUDGE_STEPS[(this.wakes.get(id) ?? 1) - 1];
    return step === undefined ? null : lastWakeAt + step * this.o.renudgeMs;
  }

  /** A claimed delivery whose lease is live is being worked on; waking again would start a parallel run. */
  private leased(id: string): boolean {
    const d = this.latest.get(id);
    return d?.state === "claimed" && (d.claim?.leaseExpiresAt ?? 0) > this.o.timers.now();
  }

  /** Deliveries that were never woken for, or whose next renudge is due (and that aren't under a live lease). */
  private due(): string[] {
    const now = this.o.timers.now();
    const out: string[] = [...this.owed];
    for (const [id, at] of this.outstanding) {
      if (this.leased(id)) continue;
      if (at === 0) {
        out.push(id);
        continue;
      }
      const next = this.renudgeAt(id, at);
      if (next !== null && now >= next) out.push(id);
    }
    return out;
  }

  private async fire(): Promise<void> {
    if (this.inFlight) return this.schedule(this.o.coalesceMs);
    const ids = this.due();
    if (!ids.length) {
      // Nothing to wake for after all (the delivery that asked for this went away): the renudge this
      // wake pre-empted still has to be reinstalled for whatever remains outstanding.
      this.scheduleRenudge();
      return;
    }
    this.inFlight = true;
    this.inFlightStates = new Map(ids.map((id) => [id, this.stateAtWake.get(id) ?? ""]));
    const key = [...ids].sort().join("\n");
    if (this.wakeId?.key !== key) this.wakeId = { key, id: `wake_${this.o.participant}_${++this.wakeSeq}_${this.o.timers.now().toString(36)}` };
    const wakeId = this.wakeId.id;
    try {
      await this.o.wake(ids, { wakeId });
      this.spent(ids, this.o.timers.now());
      this.failures = 0;
      this.gaveUp = false;
      this.wakeId = null;
      this.lastFailure = null;
      this.o.log(`@${this.o.participant}: woke for ${ids.length} delivery(s) ${ids.join(",")}`);
      this.wakeAgainForHandoffs();
    } catch (error) {
      const message = (error as Error).message;
      const now = this.o.timers.now();
      if ((error as TerminalWakeError).terminal) {
        // Counts as this wake's attempt: no 30 s retry; the renudge (if on) gives it another go later.
        this.spent(ids, now);
        this.o.log(`@${this.o.participant}: wake rejected for ${ids.join(",")}: ${message}; not retrying${this.o.renudgeMs > 0 ? `, renudging in ${Math.round(this.o.renudgeMs / 60_000)} min` : ""}`);
        this.inFlight = false;
        this.inFlightStates = null;
        this.wakeAgainForHandoffs();
        this.scheduleRenudge();
        return;
      }
      this.failures++;
      const delay = Math.min(this.o.retryMs * 2 ** (this.failures - 1), this.o.retryMs * RETRY_MAX_FACTOR);
      const last = this.lastFailure;
      // Reported again at most every 10 min (twice the retry cap), so a capped retry doesn't log every time.
      if (last && last.message === message && now - last.at < 10 * 60_000) last.repeats++;
      else {
        const again = last?.message === message && last.repeats ? ` (failed the same way ${last.repeats} more time(s) since the last report)` : "";
        this.o.log(`@${this.o.participant}: wake failed for ${ids.join(",")}: ${message}${again}; retrying in ${Math.round(delay / 1000)}s`);
        this.lastFailure = { message, at: now, repeats: 0 };
      }
      if (this.failures >= RETRY_GIVE_UP) {
        // Enough: the webhook has been failing for a while. Nothing more goes out until a delivery changes or a renudge is due.
        this.gaveUp = true;
        // The whole retry run counts as one wake: the next renudge step (if any is left) tries again later,
        // the steps widen as usual and then stop, so a callback that never answers gets a bounded number of
        // POSTs (RETRY_GIVE_UP per step) instead of a fresh run every time the first step comes due.
        this.spent(ids, now);
        this.o.log(`@${this.o.participant}: wake for ${ids.join(",")} has failed ${this.failures} times in a row; giving up until something changes`);
        // A handoff that landed during the failed run is something new: it gets its own wake.
        this.wakeAgainForHandoffs();
      } else this.schedule(delay);
    } finally {
      this.inFlight = false;
      this.inFlightStates = null;
    }
    this.scheduleRenudge();
  }

  /**
   * An attempt for these deliveries is over, whether it landed, was refused for good, or was given up on
   * after RETRY_GIVE_UP failures: it counts as one of each delivery's wakes, so the renudge steps widen
   * and then run out. After the last step the delivery is left alone until it changes (a handoff) or a new
   * delivery arrives; that is said once.
   */
  private spent(ids: string[], now: number): void {
    for (const id of ids) {
      this.owed.delete(id);
      if (!this.outstanding.has(id)) continue;
      this.outstanding.set(id, now);
      this.wakes.set(id, (this.wakes.get(id) ?? 0) + 1);
      if (this.o.renudgeMs > 0 && this.renudgeAt(id, now) === null && !this.exhausted.has(id)) {
        this.exhausted.add(id);
        this.o.log(`@${this.o.participant}: delivery ${id} is still outstanding after ${RENUDGE_STEPS.length} renudges; not waking for it again unless it changes`);
      }
    }
  }

  private scheduleRenudge(): void {
    if (this.renudgeTimer) this.o.timers.clear(this.renudgeTimer);
    this.renudgeTimer = null;
    // While a wake (or its retry) is already pending there is nothing to add: that wake covers whatever
    // is due, and an overdue renudge must not turn a 30 s retry into an immediate one.
    if (this.timer || this.o.renudgeMs <= 0) return;
    // A leased delivery's renudge waits for its lease to lapse, so the timer never spins on something it won't wake for.
    // One first seen under a live lease (the relay restarted while a connector was working on it) has never been
    // woken for and has no wake pending: the lease lapsing changes nothing in the query, so it is revisited then.
    const now = this.o.timers.now();
    const nexts = [...this.outstanding].flatMap(([id, at]) => {
      const d = this.latest.get(id);
      const lease = d?.state === "claimed" ? (d.claim?.leaseExpiresAt ?? 0) : 0;
      if (at === 0) return lease > now ? [lease] : [];
      const next = this.renudgeAt(id, at);
      if (next === null) return [];
      return [Math.max(next, lease)];
    });
    if (!nexts.length) return;
    const next = Math.min(...nexts) - now;
    // Node fires a timer past its limit at once; wait in chunks and re-check what is actually due.
    this.renudgeTimer = this.o.timers.set(() => {
      this.renudgeTimer = null;
      if (this.timer) return;
      if (this.due().length) {
        this.failures = 0;
        this.gaveUp = false;
        this.schedule(0);
      } else this.scheduleRenudge();
    }, Math.min(Math.max(0, next), MAX_TIMER_MS));
  }
}
