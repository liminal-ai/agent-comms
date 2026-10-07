// Wiring: one connector per machine. The server API, the Claude Code sessions,
// the loopback server and the dispatcher, for as long as the scope lives.

import { MAX_POLL_WAIT_MS, PROTOCOL_VERSION, type Requests, type Responses } from "@agent-comms/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Adapters, type HarnessAdapter, makePoke, Poke } from "./adapter.ts";
import { ClaudeCodeSessions } from "./claude-code.ts";
import { runDispatcher } from "./dispatcher.ts";
import { type Handlers, serveLoopback } from "./loopback.ts";
import { LoopbackError } from "./loopback-error.ts";
import { type ApiError, ServerApi, type ServerApiShape, type WorkItem } from "./server-api.ts";

export interface ConnectorOptions {
  machine: string;
  socketPath: string;
  api: ServerApiShape;
  leaseMs?: number;
  pollWaitMs?: number;
  tickMs?: number;
  /** Adapters other than Claude Code's (which is always present), e.g. T3's. */
  adapters?: HarnessAdapter[];
  log?: (line: string) => void;
  /** Test-only fault injection; see DispatcherOptions.fault. */
  fault?: "crash-after-accept";
}

export interface RunningConnector {
  sessions: ClaudeCodeSessions;
}

interface ReceiveWaiter {
  req: Requests["receive"];
  /** A stale snapshot can cause an empty receive; don't keep trying that same snapshot. */
  attempted?: string;
  inFlight: boolean;
  expired: boolean;
  finish: (result?: Responses["receive"], error?: unknown) => void;
}

/**
 * Native courier requests wait locally. Only a subscription snapshot with an
 * eligible offer permits a receive mutation; idle listeners never poll Convex
 * inboxes. Lease expiry needs a local timer because the passage of time alone
 * doesn't invalidate a Convex subscription.
 */
export class NativeReceives {
  private latest: WorkItem[] = [];
  private readonly waiters = new Set<ReceiveWaiter>();
  private readonly busy = new Set<string>();
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly api: ServerApiShape;
  private readonly run: <A>(effect: Effect.Effect<A, ApiError>) => Promise<A>;

  constructor(
    api: ServerApiShape,
    run: <A>(effect: Effect.Effect<A, ApiError>) => Promise<A>,
  ) {
    this.api = api;
    this.run = run;
  }

  update(items: WorkItem[]) {
    this.latest = items;
    this.wake();
  }

  close() {
    this.closed = true;
    clearTimeout(this.leaseTimer);
    for (const waiter of this.waiters) waiter.finish(undefined, new LoopbackError("unavailable", "the connector is closing"));
  }

  async receive(req: Requests["receive"], aborted: AbortSignal): Promise<Responses["receive"]> {
    // Validate even when the inbox is empty: an invalid identity must not
    // appear to be a valid idle listener or reveal another participant's work.
    const { participants } = await this.run(this.api.homed);
    const me = participants.find((p) => p.participant.name === req.as);
    if (!me || (me.state === "retired" && !req.includeDelivered)) {
      throw new LoopbackError("not_homed_here", `@${req.as} is not homed on this machine`);
    }
    if (me.home.harness !== "oaidot") throw new LoopbackError("bad_request", "receive requires an oaidot participant");
    if (me.home.locator !== req.locator) throw new LoopbackError("conflict", `@${req.as} is bound to another native locator`);
    if (this.closed) throw new LoopbackError("unavailable", "the connector is closing");
    if (aborted.aborted) return { deliveries: [], hasMore: false };
    // Explicit recovery is a one-shot, read-only recall. Delivered oaidot
    // requests are deliberately absent from the dispatcher's work stream.
    if (req.includeDelivered) return this.run(this.api.receive(req));

    return new Promise((resolve, reject) => {
      const waiter: ReceiveWaiter = {
        req,
        inFlight: false,
        expired: false,
        finish: (result, error) => {
          if (!this.waiters.delete(waiter)) return;
          clearTimeout(timer);
          aborted.removeEventListener("abort", abort);
          if (error !== undefined) reject(error);
          else resolve(result ?? { deliveries: [], hasMore: false });
          this.scheduleLeaseWake();
        },
      };
      const abort = () => waiter.finish();
      const timer = setTimeout(() => {
        waiter.expired = true;
        // A mutation already in flight may have reserved an offer. Return its
        // result (bounded by the API timeout), rather than silently discarding it.
        if (!waiter.inFlight) waiter.finish();
      }, Math.min(req.waitMs ?? MAX_POLL_WAIT_MS, MAX_POLL_WAIT_MS));
      this.waiters.add(waiter);
      aborted.addEventListener("abort", abort, { once: true });
      if (aborted.aborted) abort();
      else this.wake();
    });
  }

  private eligible(req: Requests["receive"]) {
    const now = Date.now();
    return this.latest.filter((item) => item.harness === "oaidot" && item.recipient === req.as && item.locator === req.locator && (
      item.state === "pending" ||
      (item.state === "claimed" && (!item.claim || item.claim.leaseExpiresAt <= now))
    ));
  }

  private wake() {
    if (this.closed) return;
    for (const waiter of this.waiters) {
      // Pending work identifies the current home. An old pinned claim may
      // still refer to a previous home, so it must not invalidate a new binding.
      if (this.latest.some((item) => item.recipient === waiter.req.as && item.state === "pending" &&
        (item.harness !== "oaidot" || item.locator !== waiter.req.locator))) {
        waiter.finish(undefined, new LoopbackError("conflict", `@${waiter.req.as} has moved to another native binding; check its current locator`));
      } else if (!this.eligible(waiter.req).length) waiter.attempted = undefined;
    }
    for (const waiter of this.waiters) void this.drain(waiter.req.as);
    this.scheduleLeaseWake();
  }

  private scheduleLeaseWake() {
    clearTimeout(this.leaseTimer);
    if (this.closed || this.waiters.size === 0) return;
    const bindings = new Set([...this.waiters].map((w) => JSON.stringify([w.req.as, w.req.locator])));
    const now = Date.now();
    const leases = this.latest.filter((item) => item.harness === "oaidot" && bindings.has(JSON.stringify([item.recipient, item.locator])) &&
      item.state === "claimed" && item.claim && item.claim.leaseExpiresAt > now);
    if (leases.length) {
      const next = Math.min(...leases.map((item) => item.claim!.leaseExpiresAt));
      this.leaseTimer = setTimeout(() => this.wake(), Math.max(1, next - now));
    }
  }

  private async drain(participant: string) {
    if (this.closed || this.busy.has(participant)) return;
    this.busy.add(participant);
    try {
      while (!this.closed) {
        let candidate: { waiter: ReceiveWaiter; fingerprint: string } | undefined;
        for (const waiter of this.waiters) {
          if (waiter.req.as !== participant || waiter.expired) continue;
          const eligible = this.eligible(waiter.req);
          if (!eligible.length) {
            // A paused/removed offer may later reappear with the same fields.
            waiter.attempted = undefined;
            continue;
          }
          const fingerprint = JSON.stringify(eligible.map((item) => [item.id, item.state, item.claim?.claimId, item.claim?.leaseExpiresAt]));
          if (waiter.attempted !== fingerprint) {
            candidate = { waiter, fingerprint };
            break;
          }
        }
        if (!candidate) return;
        const { waiter, fingerprint } = candidate;
        waiter.attempted = fingerprint;
        waiter.inFlight = true;
        try {
          const result = await this.run(this.api.receive(waiter.req));
          // Apply the returned claims before servicing another local waiter,
          // even if the subscription has not caught up with the mutation yet.
          const offered = new Map(result.deliveries.map((d) => [d.id, d]));
          this.latest = this.latest.map((item) => {
            const delivery = offered.get(item.id);
            return delivery ? { ...item, state: delivery.status.state, claim: delivery.status.claim } : item;
          });
          if (result.deliveries.length || waiter.expired) waiter.finish(result);
        } catch (error) {
          waiter.finish(undefined, error);
        } finally {
          waiter.inFlight = false;
        }
      }
    } finally {
      this.busy.delete(participant);
      this.scheduleLeaseWake();
    }
  }
}

/** Runs until the enclosing scope closes. */
export const runConnector = (options: ConnectorOptions) =>
  Effect.gen(function* () {
    const log = options.log ?? ((line: string) => console.error(`agent-comms connector: ${line}`));
    const { api } = options;
    const poke = makePoke();
    const pollWaitMs = options.pollWaitMs ?? 20_000;

    const run = <A>(effect: Effect.Effect<A, ApiError>): Promise<A> =>
      Effect.runPromise(
        effect.pipe(
          Effect.mapError((e) =>
            e._tag === "ProtocolFailure" ? new LoopbackError(e.code, e.message) : new LoopbackError("unavailable", e.message),
          ),
        ),
      );

    const receives = new NativeReceives(api, run);

    const sessions = new ClaudeCodeSessions({
      pollWaitMs,
      homed: async () => (await run(api.homed)).participants,
      presence: (participant, status) =>
        void Effect.runFork(
          api.presence(participant, status).pipe(
            Effect.retry({ times: 3, schedule: Schedule.spaced(Duration.seconds(2)) }),
            Effect.catch((e) => Effect.sync(() => log(`presence for @${participant}: ${e.message}`))),
          ),
        ),
      // Retried for well inside the fallback window, so a connector or Convex blip doesn't cost a duplicate.
      answerSeen: (participant, turnId, proofs) =>
        void Effect.runFork(
          api.answerSeen(participant, turnId, proofs).pipe(
            Effect.retry({ times: 12, schedule: Schedule.spaced(Duration.seconds(5)) }),
            Effect.tap((r) => Effect.sync(() => log(`answer-seen for @${participant} turn ${turnId}: ${r.confirmed} of ${proofs.length} confirmed`))),
            Effect.catch((e) => Effect.sync(() => log(`answer-seen for @${participant}: ${e.message}`))),
          ),
        ),
      poke,
    });

    const lastPresence = new Map<string, string>();
    /**
     * `await`: answered at once if no result is open; otherwise held until one
     * leaves `open`, the wait's `until`, the requested hold (≤ 25 s), or the
     * client goes away; then the wait is read (and expired if due) again.
     */
    const holdAwait = async (req: Requests["await"], aborted: AbortSignal): Promise<Responses["await"]> => {
      const first = await run(api.awaitWait(req));
      const openAt = first.wait.results.filter((r) => r.state === "open").length;
      if (openAt === 0 || !first.wait.active) return first;
      const holdMs = Math.min(req.waitMs ?? MAX_POLL_WAIT_MS, MAX_POLL_WAIT_MS, Math.max(0, first.wait.until - Date.now()) + 250);
      await new Promise<void>((resolve) => {
        let stop: (() => void) | undefined;
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          stop?.();
          aborted.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, holdMs);
        aborted.addEventListener("abort", done);
        stop = api.watchWait(req, ({ wait }) => {
          if (!wait.active || wait.results.filter((r) => r.state === "open").length < openAt) done();
        });
        if (finished) stop();
      });
      return run(api.awaitWait(req));
    };

    const handlers: Handlers = {
      status: async () => ({
        protocol: PROTOCOL_VERSION,
        implementation: "connector",
        machine: options.machine,
        participants: (await run(api.homed)).participants,
      }),
      register: (req) => sessions.register(req),
      unregister: (req) => sessions.unregister(req),
      poll: (req, aborted) => sessions.poll(req, aborted),
      delivered: (req) => sessions.delivered(req),
      outcome: (req) => sessions.outcome(req),
      "check-result": (req) => sessions.checkResult(req),
      presence: (req) => sessions.presence(req),
      "answer-seen": (req) => sessions.answerSeen(req),
      send: (req) => {
        // Fix pass 0.1: a waiting send is stamped with the waiter's running main turn, if its harness said
        // (Claude Code). T3 waits get none: T3 can't show the proof, so they fall back.
        const waiterTurnId = req.wait ? sessions.turnOf(req.as) : undefined;
        return run(api.send({ ...req, ...(waiterTurnId !== undefined ? { waiterTurnId } : {}) }));
      },
      reply: (req) => run(api.reply(req)),
      receive: (req, aborted) => receives.receive(req, aborted),
      "receive-ack": (req) => run(api.receiveAck(req)),
      read: (req) => run(api.read(req)),
      list: (req) => run(api.list(req)),
      await: (req, aborted) => holdAwait(req, aborted),
      ack: (req) => run(api.ack(req)),
      "message-status": (req) => run(api.messageStatus(req)),
      agents: (req) => run(api.agents(req)),
      "agents-set": (req) => run(api.agentsSet(req)),
      remind: (req) => run(api.remind(req)),
      reminders: (req) => run(api.reminders(req)),
      reminder: (req) => run(api.reminder(req)),
      "reminder-update": (req) => run(api.reminderUpdate(req)),
    };

    const loopback = yield* Effect.acquireRelease(
      Effect.promise(() => serveLoopback(options.socketPath, handlers, log)),
      (l) => Effect.promise(() => l.close()),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => receives.close()));
    log(`machine ${options.machine}: listening on ${loopback.socketPath}`);

    // Nobody has registered with this process yet: any Claude Code participant homed
    // here is offline until its session does. Best effort; the web view also
    // treats a machine whose connector isn't heard from as offline.
    yield* api.homed.pipe(
      Effect.flatMap(({ participants }) =>
        Effect.forEach(
          participants.filter((p) => p.home.harness === "claude-code" && p.state !== "retired"),
          (p) => api.presence(p.participant.name, "offline"),
          { discard: true },
        ),
      ),
      Effect.catch((e) => Effect.sync(() => log(`resetting presence: ${e.message}`))),
      Effect.forkScoped,
    );

    yield* Effect.sync(() => sessions.sweep()).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(5))), Effect.forkScoped);
    yield* api.heartbeat.pipe(
      Effect.catch((e) => Effect.sync(() => log(`heartbeat: ${e.message}`))),
      Effect.repeat(Schedule.spaced(Duration.seconds(30))),
      Effect.forkScoped,
    );

    // Presence for harnesses the connector can read (T3): polled, written only on change.
    yield* api.homed.pipe(
      Effect.flatMap(({ participants }) =>
        Effect.forEach(
          participants.filter((p) => p.state !== "retired"),
          (p) => {
            const adapter = options.adapters?.find((a) => a.harness === p.home.harness);
            if (!adapter?.presence) return Effect.void;
            return adapter.presence({ participant: p.participant.name, locator: p.home.locator }).pipe(
              Effect.flatMap((status) =>
                lastPresence.get(p.participant.name) === status
                  ? Effect.void
                  : api.presence(p.participant.name, status).pipe(Effect.tap(() => Effect.sync(() => lastPresence.set(p.participant.name, status)))),
              ),
            );
          },
          { discard: true },
        ),
      ),
      Effect.catch((e) => Effect.sync(() => log(`presence: ${e.message}`))),
      Effect.repeat(Schedule.spaced(Duration.seconds(20))),
      Effect.forkScoped,
    );

    const adapters = new Map([["claude-code" as const, sessions.adapter], ...(options.adapters ?? []).map((a) => [a.harness, a] as const)]);
    yield* runDispatcher({ leaseMs: options.leaseMs ?? 60_000, ...(options.fault ? { fault: options.fault } : {}), ...(options.tickMs ? { tickMs: options.tickMs } : {}), log }).pipe(
      // The dispatcher owns the one work subscription. Native listeners see
      // the same initial snapshot and changes, without an extra server query.
      // Pull work (oaidot) goes to native listeners only: left in the dispatcher's list, an old
      // oaidot claim would hold back newer push work for the same participant after a rebind.
      Effect.provideService(ServerApi, {
        ...api,
        work: api.work.pipe(
          Stream.tap((items) => Effect.sync(() => receives.update(items))),
          Stream.map((items) => items.filter((item) => item.harness !== "oaidot")),
        ),
      }),
      Effect.provideService(Adapters, adapters),
      Effect.provideService(Poke, poke),
      Effect.forkScoped,
    );
    return { sessions } satisfies RunningConnector;
  });
