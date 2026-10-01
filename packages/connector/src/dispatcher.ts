// The dispatcher: watches this machine's work, claims deliveries, hands them
// to the right adapter, and writes back what happened.
//
// - Serial per participant, parallel across participants.
// - A claim is held with a lease, renewed while working, and renewed once more
//   (the compare-and-set) immediately before the handoff.
// - Nothing is ever re-run blind: a delivery found claimed or delivered that we
//   aren't working on is recovered through the adapter's check.
// - Writes retry while the server is unreachable; nothing here blocks a harness.

import { type Claim, clipAnswer, type Delivery, type DeliveryState } from "@agent-comms/protocol";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Adapters, type Check, type Gate, type HarnessAdapter, type Outcome, Poke, type Target } from "./adapter.ts";
import { type ApiError, ServerApi, type WorkItem } from "./server-api.ts";

export interface DispatcherOptions {
  leaseMs: number;
  /** How often the reconcile loop looks again with no other trigger. */
  tickMs?: number;
  /** How long to leave a delivery alone after a check said "later". */
  laterMs?: number;
  /** After this long of "later" answers, the delivery is recorded uncertain (3.2). */
  laterLimitMs?: number;
  /** A readiness check that takes longer than this counts as not ready (3.1). */
  readyTimeoutMs?: number;
  /** Backoff for writes while the server is unreachable. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  log?: (line: string) => void;
}

class ClaimLost extends Data.TaggedError("ClaimLost")<{ deliveryId: string }> {}

interface Held {
  claim: Claim;
  delivery: Delivery;
  target: Target;
  harness: WorkItem["harness"];
}

export const runDispatcher = (options: DispatcherOptions) =>
  Effect.gen(function* () {
    const api = yield* ServerApi;
    const adapters = yield* Adapters;
    const poke = yield* Poke;
    const log = options.log ?? ((line: string) => console.error(`agent-comms connector: ${line}`));
    const tickMs = options.tickMs ?? 1_000;
    const laterMs = options.laterMs ?? 5_000;
    const laterLimitMs = options.laterLimitMs ?? 10 * 60_000;
    const readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
    /** Delivery id → when checks first started saying "later". */
    const laterSince = new Map<string, number>();
    /** Participant → last known readiness; refreshed in the background so a wedged harness can't stall this loop (3.1). */
    const readiness = new Map<string, boolean>();
    const checkingReady = new Set<string>();

    let latest: WorkItem[] = [];
    /** Participant → the delivery we're working on for it. */
    const busy = new Map<string, string>();
    /** Claims we hold, by delivery id: lets us resume without waiting out our own lease. */
    const held = new Map<string, Held>();
    /** Delivery id → don't look before this time. */
    const notBefore = new Map<string, number>();
    const unknownHarness = new Set<string>();

    const signal = yield* Queue.sliding<void>(1);
    const wake = () => void Queue.offerUnsafe(signal, undefined);

    yield* api.work.pipe(
      Stream.runForEach((items) =>
        Effect.sync(() => {
          latest = items;
          wake();
        }),
      ),
      Effect.catch((error) => Effect.sync(() => log(`work subscription ended: ${error.message}`))),
      Effect.forkScoped,
    );
    const unsubscribe = poke.subscribe(wake);
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    yield* Effect.sync(wake).pipe(Effect.repeat(Schedule.spaced(Duration.millis(tickMs))), Effect.forkScoped);

    // -----------------------------------------------------------------------
    // Writes

    // Exponential backoff, capped: `min` recurs while either does, with the shorter delay.
    const retrySchedule = Schedule.min([
      Schedule.exponential(Duration.millis(options.retryBaseMs ?? 500)),
      Schedule.spaced(Duration.millis(options.retryMaxMs ?? 30_000)),
    ]);

    /** Retry while unreachable. A protocol refusal ends it: logged, and reported as false. */
    const write = <A>(what: string, deliveryId: string, effect: Effect.Effect<A, ApiError>) =>
      effect.pipe(
        Effect.tapError((e: ApiError) =>
          Effect.sync(() => e._tag === "Unavailable" && log(`${what} ${deliveryId}: ${e.message}; retrying`)),
        ),
        Effect.retry({ while: (e) => e._tag === "Unavailable", schedule: retrySchedule }),
        Effect.as(true),
        Effect.catch((e) => Effect.sync(() => (log(`${what} ${deliveryId} refused: ${e.message}`), false))),
      );

    /** Runs `effect` while renewing the lease; if the claim is lost, `effect` is interrupted. */
    const withLease = <A>(h: Held, effect: Effect.Effect<A>) => {
      const renewals = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.millis(Math.max(250, Math.floor(options.leaseMs / 3))));
          const r = yield* Effect.result(api.renew(h.delivery.id, h.claim.claimId, options.leaseMs));
          if (r._tag === "Success") h.claim = r.success.claim;
          else if (r.failure._tag === "ProtocolFailure") return yield* Effect.fail(new ClaimLost({ deliveryId: h.delivery.id }));
          else log(`renew ${h.delivery.id}: ${r.failure.message}`);
        }
      });
      return Effect.raceFirst(effect, renewals as Effect.Effect<never, ClaimLost>);
    };

    const release = (h: Held) => Effect.sync(() => held.delete(h.delivery.id));

    const writeOutcome = (h: Held, turnId: string, outcome: Exclude<Outcome, { _tag: "lost" }>) => {
      const id = h.delivery.id;
      const claimId = h.claim.claimId;
      switch (outcome._tag) {
        case "replied":
          return write("collect", id, api.collect(id, claimId, turnId, clipAnswer(outcome.answer)));
        case "ambiguous":
          return write("ambiguous", id, api.ambiguous(id, claimId, turnId, outcome.entered)).pipe(
            Effect.tap((ok) => {
              const notify = adapters.get(h.harness)?.notifyUnmatched;
              return ok && notify
                ? notify(h.target, h.delivery).pipe(
                    Effect.catchCause(() => Effect.sync(() => log(`${id}: couldn't send the unmatched notice`))),
                    Effect.forkScoped,
                  )
                : Effect.void;
            }),
          );
        case "failed":
          return write("failed", id, api.failed(id, claimId, turnId, outcome.reason, outcome.detail));
        case "uncertain":
          return write("uncertain", id, api.uncertain(id, claimId, outcome.detail));
      }
    };

    // -----------------------------------------------------------------------
    // Tasks

    const follow = (adapter: HarnessAdapter, h: Held, turnId: string) =>
      Effect.gen(function* () {
        const outcome = yield* withLease(h, adapter.awaitOutcome(h.target, h.delivery, turnId));
        if (outcome._tag === "lost") return log(`${h.delivery.id}: lost sight of turn ${turnId} (${outcome.detail}); will check later`);
        yield* writeOutcome(h, turnId, outcome);
        yield* release(h);
      });

    /** Records `delivered`, and keeps our copy of the delivery current: recovery decides from it (2.1). */
    const markDelivered = (h: Held, turnId: string, cursor?: string) =>
      write("delivered", h.delivery.id, api.delivered(h.delivery.id, h.claim.claimId, turnId, cursor)).pipe(
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (!ok) return;
            const status = { ...h.delivery.status, state: "delivered" as const, turnId, ...(cursor !== undefined ? { cursor } : {}) };
            h.delivery = { ...h.delivery, status };
          }),
        ),
      );

    /** Right before the adapter sends: the claim compare-and-set, recording home and cursor (2.2, 2.5). */
    const gateFor = (h: Held): Gate => ({
      confirm: (cursor) =>
        Effect.runPromise(
          api.prepare(h.delivery.id, h.claim.claimId, cursor).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (cursor !== undefined) h.delivery = { ...h.delivery, status: { ...h.delivery.status, cursor } };
              }),
            ),
            Effect.as(true),
            Effect.catch((e) => Effect.sync(() => (log(`${h.delivery.id}: not sending (${e.message})`), false))),
          ),
        ),
    });

    const handOffAndFollow = (adapter: HarnessAdapter, h: Held) =>
      Effect.gen(function* () {
        // The compare-and-set: only hand over if the claim is still ours.
        const cas = yield* Effect.result(api.renew(h.delivery.id, h.claim.claimId, options.leaseMs));
        if (cas._tag === "Failure") {
          if (cas.failure._tag === "ProtocolFailure") {
            yield* release(h);
            return log(`${h.delivery.id}: claim no longer held; not handing over`);
          }
          return log(`${h.delivery.id}: can't confirm the claim (${cas.failure.message}); will retry`);
        }
        h.claim = cas.success.claim;
        const result = yield* withLease(h, adapter.handOff(h.target, h.delivery, gateFor(h)));
        switch (result._tag) {
          case "aborted":
            log(`${h.delivery.id}: not sent (${result.detail})`);
            return yield* release(h);
          case "rejected":
            yield* write("failed", h.delivery.id, api.failed(h.delivery.id, h.claim.claimId, undefined, "rejected", result.detail));
            return yield* release(h);
          case "lost":
            return log(`${h.delivery.id}: lost during handoff (${result.detail}); will check later`);
          case "accepted": {
            if (!(yield* markDelivered(h, result.turnId, result.cursor))) return yield* release(h);
            if (h.delivery.message.kind !== "request") return yield* release(h);
            return yield* follow(adapter, h, result.turnId);
          }
        }
      });

    const recover = (adapter: HarnessAdapter, h: Held, knownTurnId: string | undefined) =>
      Effect.gen(function* () {
        const check: Check = yield* withLease(h, adapter.check(h.target, h.delivery, knownTurnId));
        const id = h.delivery.id;
        if (check._tag !== "later") laterSince.delete(id);
        const wasDelivered = h.delivery.status.state === "delivered";
        const collect = h.delivery.message.kind === "request";
        switch (check._tag) {
          case "later": {
            const since = laterSince.get(id) ?? Date.now();
            laterSince.set(id, since);
            if (Date.now() - since >= laterLimitMs) {
              laterSince.delete(id);
              yield* write("uncertain", id, api.uncertain(id, h.claim.claimId, `couldn't establish what happened after ${Math.round((Date.now() - since) / 1000)} s (${check.detail})`));
              return yield* release(h);
            }
            notBefore.set(id, Date.now() + laterMs);
            return;
          }
          case "unknown":
            yield* write("uncertain", id, api.uncertain(id, h.claim.claimId, check.detail));
            return yield* release(h);
          case "absent":
            if (!wasDelivered) return yield* handOffAndFollow(adapter, h);
            yield* write("uncertain", id, api.uncertain(id, h.claim.claimId, "the turn it was delivered into can't be found"));
            return yield* release(h);
          case "running":
            if (!wasDelivered && !(yield* markDelivered(h, check.turnId))) return yield* release(h);
            if (!collect) return yield* release(h);
            return yield* follow(adapter, h, check.turnId);
          case "completed":
            if (!wasDelivered && !(yield* markDelivered(h, check.turnId))) return yield* release(h);
            if (collect) {
              if (check.outcome) yield* writeOutcome(h, check.turnId, check.outcome);
              else yield* write("uncertain", id, api.uncertain(id, h.claim.claimId, "its turn completed but no outcome was reported"));
            }
            return yield* release(h);
        }
      });

    /** Start on a delivery: claim it (or resume our own claim), then run or recover. */
    const work = (adapter: HarnessAdapter, item: WorkItem, target: Target) =>
      Effect.gen(function* () {
        const mine = held.get(item.id);
        let h: Held;
        let takeover: boolean;
        if (mine) {
          const r = yield* Effect.result(api.renew(item.id, mine.claim.claimId, options.leaseMs));
          if (r._tag === "Failure") {
            if (r.failure._tag === "ProtocolFailure") held.delete(item.id);
            return;
          }
          // Our copy may be behind what's recorded (or the other way round): take the further state (2.1).
          const recorded: DeliveryState =
            item.state === "delivered" || mine.delivery.status.state === "delivered" ? "delivered" : mine.delivery.status.state;
          const status = {
            ...mine.delivery.status,
            state: recorded,
            ...((item.turnId ?? mine.delivery.status.turnId) !== undefined ? { turnId: item.turnId ?? mine.delivery.status.turnId } : {}),
            ...((mine.delivery.status.cursor ?? item.cursor) !== undefined ? { cursor: mine.delivery.status.cursor ?? item.cursor } : {}),
          };
          h = { ...mine, claim: r.success.claim, delivery: { ...mine.delivery, status } };
          takeover = true;
        } else {
          const r = yield* Effect.result(api.claim(item.id, options.leaseMs));
          if (r._tag === "Failure") {
            if (r.failure._tag === "Unavailable") log(`claim ${item.id}: ${r.failure.message}`);
            return; // Someone holds it, or it moved on; the next work update tells us.
          }
          h = { claim: r.success.claim, delivery: r.success.delivery, target, harness: item.harness };
          takeover = r.success.takeover;
        }
        held.set(item.id, h);
        if (takeover) yield* recover(adapter, h, item.turnId ?? h.delivery.status.turnId);
        else yield* handOffAndFollow(adapter, h);
      }).pipe(
        Effect.catchTag("ClaimLost", (e) =>
          Effect.sync(() => {
            held.delete(e.deliveryId);
            log(`${e.deliveryId}: claim lost to another holder; stopped`);
          }),
        ),
      );

    // -----------------------------------------------------------------------
    // Reconcile

    const reconcile = Effect.gen(function* () {
      const now = Date.now();
      const byParticipant = new Map<string, WorkItem[]>();
      for (const item of latest) {
        const list = byParticipant.get(item.recipient) ?? [];
        list.push(item);
        byParticipant.set(item.recipient, list);
      }
      for (const [participant, items] of byParticipant) {
        if (busy.has(participant)) continue;
        const first = items[0]!;
        const adapter = adapters.get(first.harness);
        if (!adapter) {
          if (!unknownHarness.has(first.harness)) log(`no adapter for ${first.harness}; @${participant}'s deliveries wait`);
          unknownHarness.add(first.harness);
          continue;
        }
        const target: Target = { participant, locator: first.locator };
        // Anything already under way comes before anything new.
        const inFlight = items.find((i) => i.state !== "pending");
        const next = inFlight ?? first;
        if ((notBefore.get(next.id) ?? 0) > now) continue;
        if (inFlight) {
          const ours = held.get(inFlight.id)?.claim.claimId === inFlight.claim?.claimId;
          const expired = !inFlight.claim || inFlight.claim.leaseExpiresAt <= now;
          if (!ours && !expired) continue;
        }
        const key = `${first.harness}/${participant}`;
        if (!checkingReady.has(key)) {
          checkingReady.add(key);
          yield* adapter.ready(target).pipe(
            Effect.timeoutOption(Duration.millis(readyTimeoutMs)),
            Effect.map((r) => r._tag === "Some" && r.value),
            Effect.tap((ok) =>
              Effect.sync(() => {
                const changed = readiness.get(key) !== ok;
                readiness.set(key, ok);
                if (changed && ok) wake();
              }),
            ),
            Effect.ensuring(Effect.sync(() => checkingReady.delete(key))),
            Effect.forkScoped,
          );
        }
        if (!readiness.get(key)) continue;
        busy.set(participant, next.id);
        yield* work(adapter, next, target).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              busy.delete(participant);
              wake();
            }),
          ),
          Effect.forkScoped,
        );
      }
    });

    while (true) {
      yield* Queue.take(signal);
      yield* reconcile;
    }
  });
