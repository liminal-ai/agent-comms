// Wiring: one connector per machine. The server API, the Claude Code sessions,
// the loopback server and the dispatcher, for as long as the scope lives.

import { MAX_POLL_WAIT_MS, PROTOCOL_VERSION, type Requests, type Responses } from "@agent-comms/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Adapters, type HarnessAdapter, makePoke, Poke } from "./adapter.ts";
import { ClaudeCodeSessions } from "./claude-code.ts";
import { runDispatcher } from "./dispatcher.ts";
import { type Handlers, serveLoopback } from "./loopback.ts";
import { LoopbackError } from "./loopback-error.ts";
import { type ApiError, ServerApi, type ServerApiShape } from "./server-api.ts";

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
      Effect.provideService(ServerApi, api),
      Effect.provideService(Adapters, adapters),
      Effect.provideService(Poke, poke),
      Effect.forkScoped,
    );
    return { sessions } satisfies RunningConnector;
  });
