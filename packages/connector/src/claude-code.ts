// The Claude Code side: the sessions the mod registers over the loopback
// socket, and the adapter the dispatcher uses to reach them. The mod polls;
// the connector never calls into a session.
//
// The mod's reports (delivered, outcome, check-result) are acknowledged at
// once and kept here, so the dispatcher picks them up whenever it asks, even
// if the report arrived first or came from a session the previous connector
// process handed the delivery to.

import type { DeliveryCheck, HomedParticipant, OutcomeBody, PollItem, Requests, Responses } from "@agent-comms/protocol";
import * as Effect from "effect/Effect";
import type { Check, HandOff, HarnessAdapter, Outcome, PokeShape, Target } from "./adapter.ts";
import { LoopbackError } from "./loopback-error.ts";

interface Session {
  id: string;
  participant: string;
  cwd: string;
  status: "idle" | "busy";
  superseded: boolean;
  lastSeen: number;
  polling: boolean;
  outbox: PollItem[];
  wakePoll?: () => void;
}

interface Waiting<T> {
  sessionId: string;
  resolve: (value: T) => void;
}

interface Report {
  turnId?: string;
  outcome?: OutcomeBody;
  at: number;
}

export interface ClaudeCodeOptions {
  /** How long a poll is held when the mod doesn't say. */
  pollWaitMs: number;
  /** A session that hasn't polled for this long is gone. */
  staleMs?: number;
  /** Who is homed here: asked on every registration. */
  homed: () => Promise<HomedParticipant[]>;
  /** Presence updates, written in the background. */
  presence: (participant: string, status: "idle" | "busy" | "offline") => void;
  poke: PokeShape;
  now?: () => number;
}

const REPORT_TTL_MS = 60 * 60_000;

export class ClaudeCodeSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly current = new Map<string, string>();
  private readonly handOffs = new Map<string, Waiting<HandOff>>();
  private readonly outcomes = new Map<string, Waiting<Outcome>>();
  private readonly checks = new Map<string, Waiting<Check>>();
  private readonly reports = new Map<string, Report>();
  private readonly options: ClaudeCodeOptions;
  private readonly now: () => number;
  private readonly staleMs: number;

  constructor(options: ClaudeCodeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? options.pollWaitMs * 2 + 15_000;
  }

  // -------------------------------------------------------------------------
  // Loopback operations (from the mod)

  async register(req: Requests["register"]): Promise<Responses["register"]> {
    const homed = await this.options.homed();
    const me = homed.find((p) => p.participant.name === req.participant);
    if (!me) throw new LoopbackError("not_homed_here", `@${req.participant} is not homed on this machine`);
    if (me.home.harness !== "claude-code") {
      throw new LoopbackError("not_homed_here", `@${req.participant} is homed in ${me.home.harness}, not claude-code`);
    }
    const previous = this.current.get(req.participant);
    if (previous && previous !== req.sessionId) this.lose(previous, "superseded by a newer session");
    const existing = this.sessions.get(req.sessionId);
    const session: Session = existing ?? {
      id: req.sessionId,
      participant: req.participant,
      cwd: req.cwd,
      status: req.status,
      superseded: false,
      lastSeen: this.now(),
      polling: false,
      outbox: [],
    };
    Object.assign(session, { cwd: req.cwd, status: req.status, superseded: false, lastSeen: this.now() });
    this.sessions.set(req.sessionId, session);
    this.current.set(req.participant, req.sessionId);
    this.options.presence(req.participant, req.status);
    this.options.poke.poke();
    return { participant: me.participant, pollWaitMs: this.options.pollWaitMs };
  }

  unregister(req: Requests["unregister"]): Responses["unregister"] {
    const s = this.sessions.get(req.sessionId);
    if (s && !s.superseded) this.lose(s.id, "session ended");
    this.sessions.delete(req.sessionId);
    return {};
  }

  private live(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new LoopbackError("unknown_session", `session ${sessionId} is not registered; register again`);
    if (s.superseded) throw new LoopbackError("session_superseded", `session ${sessionId} was replaced by a newer session`);
    s.lastSeen = this.now();
    return s;
  }

  async poll(req: Requests["poll"], aborted: AbortSignal): Promise<Responses["poll"]> {
    const s = this.live(req.sessionId);
    if (s.polling) throw new LoopbackError("poll_in_progress", "a poll is already outstanding for this session");
    s.polling = true;
    try {
      if (s.outbox.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, req.waitMs ?? this.options.pollWaitMs);
          aborted.addEventListener("abort", done, { once: true });
          s.wakePoll = done;
          function done() {
            clearTimeout(timer);
            resolve();
          }
        });
      }
      s.wakePoll = undefined;
      s.lastSeen = this.now();
      if (aborted.aborted) return { items: [] };
      if (s.superseded) throw new LoopbackError("session_superseded", `session ${s.id} was replaced by a newer session`);
      return { items: s.outbox.splice(0) };
    } finally {
      s.polling = false;
    }
  }

  delivered(req: Requests["delivered"]): Responses["delivered"] {
    const s = this.live(req.sessionId);
    const report = this.report(req.deliveryId);
    if (report.turnId !== undefined && report.turnId !== req.turnId) {
      throw new LoopbackError("conflict", `delivery ${req.deliveryId} already went into turn ${report.turnId}`);
    }
    report.turnId = req.turnId;
    this.settle(this.handOffs, req.deliveryId, { _tag: "accepted", turnId: req.turnId });
    return { delivery: { id: req.deliveryId, recipient: s.participant, state: "delivered" } };
  }

  outcome(req: Requests["outcome"]): Responses["outcome"] {
    const s = this.live(req.sessionId);
    const report = this.report(req.deliveryId);
    const duplicate = report.outcome !== undefined;
    if (!duplicate) {
      report.turnId ??= req.turnId;
      report.outcome = outcomeBody(req);
      if (req.turnId === undefined && req.outcome === "failed") {
        // Dropped before any turn ran it: the handoff itself failed.
        const detail = req.detail ? `${req.reason}: ${req.detail}` : req.reason;
        this.settle(this.handOffs, req.deliveryId, { _tag: "rejected", detail });
      }
      this.settle(this.outcomes, req.deliveryId, toOutcome(report.outcome));
    }
    const state = (report.outcome ?? outcomeBody(req)).outcome;
    return { delivery: { id: req.deliveryId, recipient: s.participant, state }, duplicate };
  }

  checkResult(req: Requests["check-result"]): Responses["check-result"] {
    const s = this.live(req.sessionId);
    let check: Check;
    if (req.found === "no") check = { _tag: "absent" };
    else if (req.found === "unknown") check = { _tag: "unknown", detail: req.detail ?? "the session couldn't tell whether it ran" };
    else if (req.turn === "running") check = { _tag: "running", turnId: req.turnId };
    else {
      check = {
        _tag: "completed",
        turnId: req.turnId,
        ...(req.outcome ? { outcome: toOutcome(req.outcome) as Exclude<Outcome, { _tag: "lost" }> } : {}),
      };
    }
    if (req.found === "yes") {
      const report = this.report(req.deliveryId);
      report.turnId ??= req.turnId;
      if (req.turn === "completed" && req.outcome) report.outcome ??= req.outcome;
    }
    this.settle(this.checks, req.deliveryId, check);
    const state =
      check._tag === "absent" ? "claimed" : check._tag === "unknown" ? "uncertain" : check._tag === "running" ? "delivered" : (check.outcome?._tag ?? "delivered");
    return { delivery: { id: req.deliveryId, recipient: s.participant, state } };
  }

  presence(req: Requests["presence"]): Responses["presence"] {
    const s = this.live(req.sessionId);
    s.status = req.status;
    this.options.presence(s.participant, req.status);
    return {};
  }

  // -------------------------------------------------------------------------
  // Housekeeping

  /** Sessions held in memory, superseded ones included until freed. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** Drop sessions that stopped polling and reports nobody asked for. */
  sweep(): void {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (!s.superseded && !s.polling && now - s.lastSeen > this.staleMs) {
        this.lose(s.id, "stopped polling");
        this.sessions.delete(s.id);
      } else if (s.superseded && !s.polling) {
        // Its last poll has been answered (with session_superseded); nothing refers to it now (3.3).
        this.sessions.delete(s.id);
      }
    }
    for (const [id, r] of this.reports) if (now - r.at > REPORT_TTL_MS) this.reports.delete(id);
  }

  private lose(sessionId: string, why: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.superseded = true;
    s.wakePoll?.();
    if (this.current.get(s.participant) === sessionId) {
      this.current.delete(s.participant);
      this.options.presence(s.participant, "offline");
    }
    const detail = `session ${sessionId} ${why}`;
    for (const [id, w] of this.handOffs) if (w.sessionId === sessionId) this.settle(this.handOffs, id, { _tag: "lost", detail });
    for (const [id, w] of this.outcomes) if (w.sessionId === sessionId) this.settle(this.outcomes, id, { _tag: "lost", detail });
    for (const [id, w] of this.checks) if (w.sessionId === sessionId) this.settle(this.checks, id, { _tag: "later", detail });
  }

  private report(deliveryId: string): Report {
    let r = this.reports.get(deliveryId);
    if (!r) this.reports.set(deliveryId, (r = { at: this.now() }));
    return r;
  }

  private settle<T>(map: Map<string, Waiting<T>>, deliveryId: string, value: T): void {
    const w = map.get(deliveryId);
    if (!w) return;
    map.delete(deliveryId);
    w.resolve(value);
  }

  private wait<T>(map: Map<string, Waiting<T>>, deliveryId: string, sessionId: string): Promise<T> {
    return new Promise<T>((resolve) => {
      const previous = map.get(deliveryId);
      map.set(deliveryId, { sessionId, resolve });
      // Only one waiter per delivery; an older one (from an interrupted task) is simply dropped.
      void previous;
    });
  }

  private session(target: Target): Session | undefined {
    const id = this.current.get(target.participant);
    const s = id ? this.sessions.get(id) : undefined;
    return s && !s.superseded && this.now() - s.lastSeen <= this.staleMs ? s : undefined;
  }

  private enqueue(s: Session, item: PollItem): void {
    s.outbox.push(item);
    s.wakePoll?.();
  }

  // -------------------------------------------------------------------------
  // The adapter

  readonly adapter: HarnessAdapter = {
    harness: "claude-code",
    ready: (target) => Effect.sync(() => this.session(target) !== undefined),
    handOff: (target, delivery, gate) =>
      Effect.promise(async (signal): Promise<HandOff> => {
        const known = this.reports.get(delivery.id)?.turnId;
        if (known !== undefined) return { _tag: "accepted", turnId: known };
        const s = this.session(target);
        if (!s) return { _tag: "lost", detail: `no session for @${target.participant}` };
        // Last check before the delivery leaves for the session (2.2).
        if (signal.aborted || !(await gate.confirm())) return { _tag: "aborted", detail: "claim not held" };
        if (signal.aborted) return { _tag: "aborted", detail: "cancelled" };
        const accepted = this.wait(this.handOffs, delivery.id, s.id);
        this.enqueue(s, { type: "deliver", delivery });
        return accepted;
      }),
    awaitOutcome: (target, delivery, turnId) =>
      Effect.promise(async (): Promise<Outcome> => {
        const known = this.reports.get(delivery.id)?.outcome;
        if (known) return toOutcome(known);
        const s = this.session(target);
        if (!s) return { _tag: "lost", detail: `no session for @${target.participant}` };
        void turnId;
        return this.wait(this.outcomes, delivery.id, s.id);
      }),
    check: (target, delivery, turnId) =>
      Effect.promise(async (): Promise<Check> => {
        const report = this.reports.get(delivery.id);
        if (report?.turnId !== undefined) {
          return report.outcome
            ? { _tag: "completed", turnId: report.turnId, outcome: toOutcome(report.outcome) as Exclude<Outcome, { _tag: "lost" }> }
            : { _tag: "running", turnId: report.turnId };
        }
        const s = this.session(target);
        if (!s) return { _tag: "later", detail: `no session for @${target.participant}` };
        const answer = this.wait(this.checks, delivery.id, s.id);
        const check: DeliveryCheck = {
          deliveryId: delivery.id,
          messageId: delivery.message.id,
          state: delivery.status.state === "delivered" ? "delivered" : "claimed",
          ...(turnId !== undefined ? { turnId } : {}),
        };
        this.enqueue(s, { type: "check", check });
        return answer;
      }),
  };
}

function outcomeBody(req: Requests["outcome"]): OutcomeBody {
  switch (req.outcome) {
    case "replied":
      return { outcome: "replied", answer: req.answer };
    case "ambiguous":
      return { outcome: "ambiguous", entered: req.entered };
    case "failed":
      return { outcome: "failed", reason: req.reason, ...(req.detail !== undefined ? { detail: req.detail } : {}) };
  }
}

function toOutcome(body: OutcomeBody): Outcome {
  switch (body.outcome) {
    case "replied":
      return { _tag: "replied", answer: body.answer };
    case "ambiguous":
      return { _tag: "ambiguous", entered: body.entered };
    case "failed":
      // "rejected" is the harness refusing a handoff; from a turn it reads as an error.
      return {
        _tag: "failed",
        reason: body.reason === "rejected" ? "error" : body.reason,
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
      };
  }
}

