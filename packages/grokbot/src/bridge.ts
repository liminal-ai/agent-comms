// The bridge daemon: registers Grok Bot on the connector as a Claude Code
// session, keeps one poll outstanding, writes every delivery to the inbox
// before reporting it `delivered`, and reports what Grok Bot does with it.
//
// Everything it must still tell the connector is derived from the inbox items
// on disk (delivered not yet reported, an outcome not yet reported, a late
// answer not yet posted), so a crash or a connector restart loses nothing: the
// next flush sends it. Restart checks are answered from the same files.

import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { type OkBody, type Op, type PollItem, type Requests, type Responses } from "@agent-comms/protocol";
import { type ConnectorClient, TransportError } from "./client.ts";
import type { GrokbotConfig } from "./config.ts";
import {
  addEvent,
  type CheckAnswer,
  checkAnswer,
  isOverdue,
  keepsBusy,
  newItem,
  planAck,
  planAnswer,
  replyKeyFor,
  timeOut,
} from "./items.ts";
import {
  type BridgeState,
  type Command,
  type CommandResult,
  type InboxItem,
  isDeliveryId,
  isSettled,
  pruneOld,
  Store,
  writeFileAtomic,
} from "./store.ts";
import type { Wake, WakeEvent } from "./webhook.ts";

export type StopReason = "stopped" | "superseded";

export interface BridgeOptions {
  config: Pick<GrokbotConfig, "participant" | "cwd" | "pollWaitMs" | "answerTimeoutMs" | "unregisterOnExit" | "home"> & {
    sessionId?: string;
  };
  client: ConnectorClient;
  store: Store;
  now?: () => number;
  log?: (line: string) => void;
  wake?: Wake;
  /** How often commands, timeouts and reports are looked at. Default 1000 ms. */
  tickMs?: number;
  /** Backoff after socket errors: doubles from `initialMs` up to `maxMs`. Default 500 ms to 30 s. */
  backoff?: { initialMs: number; maxMs: number };
  /** Watch the outbox for commands (besides the tick). Default true. */
  watchOutbox?: boolean;
}

type ReportResult<K extends Op> =
  | { kind: "ok"; body: OkBody<Responses[K]> }
  | { kind: "retry"; soon?: boolean }
  | { kind: "drop"; code: string; message: string };

const RESULT_MAX_AGE_MS = 24 * 60 * 60_000;
/** Registration refused (not promoted, or homed elsewhere): Lee has to act, so retry slowly. */
const REFUSED_RETRY_MS = 60_000;

export class Bridge {
  readonly store: Store;
  readonly stats = { registrations: 0, polls: 0, deliveries: 0, checks: 0, reports: 0 };
  sessionId = "";
  private readonly options: BridgeOptions;
  private readonly client: ConnectorClient;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly tickMs: number;
  private readonly backoff: { initialMs: number; maxMs: number };
  private state: BridgeState | undefined;
  /** Items not yet settled, by delivery id. The daemon is the inbox's only writer. */
  private readonly pending = new Map<string, InboxItem>();
  private readonly checkQueue: CheckAnswer[] = [];
  private registered = false;
  private stopped = false;
  private stopReason: StopReason = "stopped";
  private pollAbort = new AbortController();
  private sentPresence: "idle" | "busy" | undefined;
  private mutexTail: Promise<unknown> = Promise.resolve();
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private reportRetryAt = 0;
  private reportFailures = 0;
  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private watcher: FSWatcher | undefined;
  private loopDone: Promise<void> = Promise.resolve();
  private readonly sleepers = new Set<() => void>();
  private lastPrune = 0;
  private lastError: string | undefined;
  private startedAt = 0;
  private finished: Promise<StopReason> | undefined;
  private resolveFinished: ((reason: StopReason) => void) | undefined;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.client = options.client;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => process.stderr.write(`${new Date().toISOString()} grokbot: ${line}\n`));
    this.tickMs = options.tickMs ?? 1_000;
    this.backoff = options.backoff ?? { initialMs: 500, maxMs: 30_000 };
  }

  get participant(): string {
    return this.options.config.participant;
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  /** Loads the inbox and starts polling. Resolves once running; `finished` resolves when it stops. */
  async start(): Promise<void> {
    await this.store.init();
    let state = await this.store.loadState();
    const configured = this.options.config.sessionId;
    if (!state || (configured && configured !== state.sessionId)) {
      state = {
        sessionId: configured ?? `grokbot-${randomUUID()}`,
        historyStartedAt: state?.historyStartedAt ?? this.now(),
      };
      await this.store.saveState(state);
    }
    this.state = state;
    this.sessionId = state.sessionId;
    for (const item of await this.store.list()) {
      if (isSettled(item)) await this.store.put(item); // a move to done/ interrupted by a crash
      else this.pending.set(item.deliveryId, item);
    }
    this.startedAt = this.now();
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
    this.log(
      `starting as @${this.participant}, session ${this.sessionId}; ${this.pending.size} pending in ${this.store.paths.inboxDir}`,
    );
    await this.store.log("started", { participant: this.participant, sessionId: this.sessionId, pending: this.pending.size });
    this.ticker = setInterval(() => void this.tick(), this.tickMs);
    if (this.options.watchOutbox !== false) {
      try {
        this.watcher = watch(this.store.paths.outboxDir, () => void this.tick());
        this.watcher.on("error", () => {});
      } catch {
        // No file watching here: the tick still picks commands up.
      }
    }
    this.loopDone = this.loop();
    void this.tick();
  }

  /** Resolves when the daemon stops: asked to, or superseded by a newer session. */
  get done(): Promise<StopReason> {
    if (!this.finished) throw new Error("not started");
    return this.finished;
  }

  async stop(reason: StopReason = "stopped"): Promise<StopReason> {
    if (!this.stopped) {
      this.stopped = true;
      this.stopReason = reason;
      if (this.ticker) clearInterval(this.ticker);
      this.watcher?.close();
      this.pollAbort.abort();
      for (const wake of [...this.sleepers]) wake();
      await this.loopDone;
      await Promise.race([Promise.all([this.ticking, this.flushing]), this.timer(5_000)]);
      if (reason === "stopped" && this.options.config.unregisterOnExit && this.registered) {
        await this.client.call("unregister", { sessionId: this.sessionId }).catch(() => {});
      }
      await this.writeStatus().catch(() => {});
      await this.store.log("stopped", { reason }).catch(() => {});
      this.log(`stopped (${reason})`);
      this.resolveFinished?.(reason);
    }
    return this.stopReason;
  }

  // -------------------------------------------------------------------------
  // Registration and the poll loop

  private desiredPresence(): "idle" | "busy" {
    for (const item of this.pending.values()) if (keepsBusy(item)) return "busy";
    return "idle";
  }

  private async register(): Promise<"ok" | "retry" | "refused"> {
    const status = this.desiredPresence();
    let res;
    try {
      res = await this.client.call("register", {
        participant: this.participant,
        harness: "claude-code",
        sessionId: this.sessionId,
        cwd: this.options.config.cwd,
        status,
      });
    } catch (error) {
      this.noteError(`register: ${(error as Error).message}`);
      return "retry";
    }
    if (res.ok) {
      this.registered = true;
      this.sentPresence = status;
      this.stats.registrations++;
      this.lastError = undefined;
      this.log(`registered as @${res.participant.name} (session ${this.sessionId}, ${status})`);
      await this.store.log("registered", { sessionId: this.sessionId, status });
      return "ok";
    }
    const { code, message } = res.error;
    if (code === "unknown_participant" || code === "not_homed_here") {
      this.noteError(
        `register refused (${code}): ${message}. @${this.participant} must be promoted with a claude-code home on this connector's machine; retrying in ${REFUSED_RETRY_MS / 1000} s`,
      );
      return "refused";
    }
    this.noteError(`register: ${code}: ${message}`);
    return "retry";
  }

  private noteError(text: string): void {
    this.lastError = text;
    this.log(text);
  }

  private backoffMs(failures: number): number {
    const base = Math.min(this.backoff.maxMs, this.backoff.initialMs * 2 ** Math.max(0, failures - 1));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  private timer(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  /** Sleeps, but wakes at once when the daemon stops. */
  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.sleepers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      if (!this.registered) {
        const r = await this.register();
        if (this.stopped) break;
        if (r !== "ok") {
          failures++;
          await this.sleep(r === "refused" ? REFUSED_RETRY_MS : this.backoffMs(failures));
          continue;
        }
        failures = 0;
        void this.writeStatus().catch(() => {});
        this.reportRetryAt = 0; // a fresh registration: send what's owed at once
        void this.flush();
      }
      const waitMs = this.options.config.pollWaitMs;
      let res;
      try {
        this.stats.polls++;
        res = await this.client.call("poll", { sessionId: this.sessionId, waitMs }, { signal: this.pollAbort.signal, timeoutMs: waitMs + 15_000 });
      } catch (error) {
        if (this.stopped) break;
        failures++;
        const wait = this.backoffMs(failures);
        this.noteError(`poll: ${(error as Error).message}; retrying in ${wait} ms`);
        await this.sleep(wait);
        continue;
      }
      if (!res.ok) {
        const { code, message } = res.error;
        if (code === "unknown_session") {
          this.log("poll: unknown_session (the connector restarted?); registering again");
          this.registered = false;
          continue;
        }
        if (code === "session_superseded") {
          this.log("poll: session_superseded: a newer session took over; stopping");
          void this.stop("superseded");
          break;
        }
        failures++;
        const wait = code === "poll_in_progress" ? 1_000 : this.backoffMs(failures);
        this.noteError(`poll: ${code}: ${message}; retrying in ${wait} ms`);
        await this.sleep(wait);
        continue;
      }
      failures = 0;
      for (const item of res.items) {
        try {
          await this.handle(item);
        } catch (error) {
          this.noteError(`handling ${item.type} ${item.type === "deliver" ? item.delivery.id : item.check.deliveryId}: ${(error as Error).message}`);
        }
      }
      void this.writeStatus().catch(() => {});
    }
  }

  private async handle(item: PollItem): Promise<void> {
    if (item.type === "check") {
      this.stats.checks++;
      const id = item.check.deliveryId;
      const known = isDeliveryId(id) ? (this.pending.get(id) ?? (await this.store.get(id))) : null;
      const answer = checkAnswer(item.check, known, this.state!.historyStartedAt);
      this.log(`check ${id} (${item.check.state}): answering ${answer.found}${answer.found === "yes" ? ` (${answer.turn})` : ""}`);
      await this.store.log("check", { deliveryId: id, state: item.check.state, found: answer.found });
      this.checkQueue.push(answer);
      void this.flush();
      return;
    }
    const delivery = item.delivery;
    if (!isDeliveryId(delivery.id)) {
      this.noteError(`ignoring a delivery with an unusable id ${JSON.stringify(delivery.id)}`);
      return;
    }
    const created = await this.mutex(async (): Promise<InboxItem | undefined> => {
      const existing = this.pending.get(delivery.id) ?? (await this.store.get(delivery.id));
      if (existing) {
        // Offered again: report it again (both reports are idempotent).
        existing.deliveredReported = false;
        if (existing.outcome) existing.outcomeReported = false;
        addEvent(existing, this.now(), "offered-again");
        await this.store.put(existing);
        this.pending.set(existing.deliveryId, existing);
        this.log(`${delivery.id}: offered again; already in the inbox (${existing.state})`);
        return undefined;
      }
      // Written (and synced) before `delivered` is reported: what was reported is always on disk.
      const fresh = newItem(delivery, { now: this.now(), answerTimeoutMs: this.options.config.answerTimeoutMs });
      await this.store.put(fresh);
      this.pending.set(fresh.deliveryId, fresh);
      return fresh;
    });
    if (created) {
      this.stats.deliveries++;
      const c = created;
      this.log(`${c.deliveryId}: ${c.kind} from @${c.from.name} in ${c.conversation.id}${c.expectsReply ? `; answer by ${c.deadlineAt}` : ""}`);
      await this.store.log("received", {
        deliveryId: c.deliveryId,
        messageId: c.messageId,
        kind: c.kind,
        from: c.from.name,
        conversationId: c.conversation.id,
        expectsReply: c.expectsReply,
      });
      this.fireWake("delivery", c);
    }
    void this.flush();
  }

  private fireWake(event: WakeEvent, item: InboxItem): void {
    if (!this.options.wake) return;
    this.options.wake(event, item, this.store.pathOf(item)).catch((error) => this.log(`wake (${event} ${item.deliveryId}): ${(error as Error).message}`));
  }

  // -------------------------------------------------------------------------
  // Item updates (serialized)

  private mutex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutexTail.then(fn, fn);
    this.mutexTail = run.catch(() => {});
    return run;
  }

  /** Applies `fn` to the current copy of the item and persists it; `false` from `fn` means no change. */
  private update(id: string, fn: (item: InboxItem) => void | false): Promise<InboxItem | null> {
    return this.mutex(async () => {
      const item = this.pending.get(id) ?? (await this.store.get(id));
      if (!item) return null;
      if (fn(item) === false) return item;
      await this.store.put(item);
      if (isSettled(item)) this.pending.delete(id);
      else this.pending.set(id, item);
      return item;
    });
  }

  // -------------------------------------------------------------------------
  // The tick: commands, timeouts, reports

  /** Runs one pass now (tests and the outbox watcher call it). */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      await null; // as in flush: never settle before `this.ticking` is assigned
      try {
        do {
          this.tickAgain = false;
          await this.processCommands();
          await this.sweepTimeouts();
          await this.flush();
          if (this.now() - this.lastPrune > 60 * 60_000) {
            this.lastPrune = this.now();
            await pruneOld(this.store.resultsDir, RESULT_MAX_AGE_MS);
          }
        } while (this.tickAgain && !this.stopped);
      } catch (error) {
        this.noteError(`tick: ${(error as Error).message}`);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async sweepTimeouts(): Promise<void> {
    const now = this.now();
    for (const item of [...this.pending.values()]) {
      if (!isOverdue(item, now)) continue;
      const changed = { timedOut: false };
      const updated = await this.update(item.deliveryId, (it) => {
        if (!isOverdue(it, now)) return false;
        timeOut(it, now);
        changed.timedOut = true;
      });
      if (changed.timedOut && updated) {
        this.log(`${updated.deliveryId}: not answered in time; reporting ambiguous (answer later with grokbot answer / comms reply)`);
        await this.store.log("timed-out", { deliveryId: updated.deliveryId, messageId: updated.messageId });
        this.fireWake("timeout", updated);
      }
    }
  }

  private async processCommands(): Promise<void> {
    for (const { file, command } of await this.store.readCommands()) {
      if (this.stopped) return;
      if (!command || typeof command.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(command.id) || typeof command.deliveryId !== "string") {
        this.log(`ignoring a malformed command ${file}`);
        await this.store.removeCommand(file);
        continue;
      }
      const result = await this.apply(command);
      await this.store.writeResult(result);
      await this.store.removeCommand(file);
      this.log(`command ${command.action} ${command.deliveryId}: ${result.ok ? "ok" : "refused"}: ${result.message}`);
      await this.store.log("command", { action: command.action, deliveryId: command.deliveryId, ok: result.ok, message: result.message });
    }
  }

  private async apply(command: Command): Promise<CommandResult> {
    const id = command.deliveryId;
    if (!isDeliveryId(id)) return { id: command.id, ok: false, message: `"${id}" isn't a delivery id` };
    let result: CommandResult = { id: command.id, ok: false, message: `no delivery ${id} in the inbox` };
    const remember = (it: InboxItem) => {
      it.appliedCommands = [...(it.appliedCommands ?? []), command.id].slice(-20);
    };
    const now = this.now();
    await this.update(id, (it) => {
      if (it.appliedCommands?.includes(command.id)) {
        result = { id: command.id, ok: true, message: "already applied", state: it.state };
        return false;
      }
      if (command.action === "answer") {
        const text = typeof command.text === "string" ? command.text : "";
        const plan = planAnswer(it, text);
        if (!plan.ok) {
          result = { id: command.id, ok: false, message: plan.message, state: it.state };
          return false;
        }
        it.answer = text;
        it.answeredAt = new Date(now).toISOString();
        delete it.lastError;
        if (plan.kind === "outcome") {
          it.state = "answered";
          it.outcome = plan.outcome;
          it.outcomeReported = false;
          addEvent(it, now, "answered");
          result = { id: command.id, ok: true, message: "answer accepted; reporting it as the reply", state: it.state };
        } else {
          it.state = "late-reply-queued";
          it.lateReply = { text, key: replyKeyFor(command.id) };
          addEvent(it, now, "answered-late", "posting with reply");
          result = { id: command.id, ok: true, message: "late answer accepted; posting it with comms reply", state: it.state };
        }
        remember(it);
        return;
      }
      if (command.action === "ack") {
        const plan = planAck(it);
        if (!plan.ok) {
          result = { id: command.id, ok: false, message: plan.message, state: it.state };
          return false;
        }
        const changed = plan.state !== it.state;
        it.state = plan.state;
        if (changed) addEvent(it, now, "acknowledged", plan.note);
        remember(it);
        result = { id: command.id, ok: true, message: plan.note ?? "marked read", state: it.state };
        return;
      }
      result = { id: command.id, ok: false, message: `unknown action ${String(command.action)}` };
      return false;
    });
    void this.flush();
    return result;
  }

  // -------------------------------------------------------------------------
  // Reports

  /** Sends everything the connector hasn't been told yet. Single-flight; failures back off. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    if (this.now() < this.reportRetryAt) return Promise.resolve();
    this.flushing = (async () => {
      // Yield first, so the `finally` below can't run before `this.flushing` is assigned.
      await null;
      try {
        do {
          this.flushAgain = false;
          if (!this.registered || this.stopped) return;
          const r = await this.flushOnce();
          if (r === "retry" || r === "soon") {
            this.reportFailures++;
            this.reportRetryAt = this.now() + (r === "soon" ? 0 : this.backoffMs(this.reportFailures));
            return;
          }
          this.reportFailures = 0;
        } while (this.flushAgain);
      } catch (error) {
        this.noteError(`flush: ${(error as Error).message}`);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private async report<K extends Op>(op: K, body: Requests[K]): Promise<ReportResult<K>> {
    this.stats.reports++;
    let res;
    try {
      res = await this.client.call(op, body);
    } catch (error) {
      this.noteError(`${op}: ${error instanceof TransportError ? error.message : String(error)}; will retry`);
      return { kind: "retry" };
    }
    if (res.ok) return { kind: "ok", body: res };
    const { code, message } = res.error;
    if (code === "unknown_session") {
      this.log(`${op}: unknown_session; registering again`);
      this.registered = false;
      return { kind: "retry", soon: true };
    }
    if (code === "session_superseded") {
      this.log(`${op}: session_superseded; stopping`);
      void this.stop("superseded");
      return { kind: "retry" };
    }
    if (code === "unavailable" || code === "internal") {
      this.noteError(`${op}: ${code}: ${message}; will retry`);
      return { kind: "retry" };
    }
    return { kind: "drop", code, message };
  }

  private async flushOnce(): Promise<"ok" | "retry" | "soon"> {
    const sessionId = this.sessionId;
    const retry = (r: { kind: "retry"; soon?: boolean }) => (r.soon ? "soon" : "retry");

    while (this.checkQueue.length > 0) {
      const answer = this.checkQueue[0]!;
      // The wire shape (flat outcome fields) differs from the decoded type; see CheckAnswer.
      const r = await this.report("check-result", { sessionId, ...answer } as unknown as Requests["check-result"]);
      if (r.kind === "retry") return retry(r);
      this.checkQueue.shift();
      if (r.kind === "drop") {
        this.log(`check-result ${answer.deliveryId}: refused (${r.code}: ${r.message})`);
        continue;
      }
      this.log(`check-result ${answer.deliveryId}: ${answer.found}; delivery now ${r.body.delivery.state}`);
      if (answer.found === "yes") {
        await this.update(answer.deliveryId, (it) => {
          it.deliveredReported = true;
          if (answer.turn === "completed" && it.outcome) {
            it.outcomeReported = true;
            if (it.state === "answered") it.state = "replied";
          }
          addEvent(it, this.now(), "check-answered", `${answer.turn}; delivery ${r.body.delivery.state}`);
        });
      }
    }

    for (const id of [...this.pending.keys()]) {
      if (this.stopped || !this.registered) return "soon";
      let item: InboxItem | null | undefined = this.pending.get(id);
      if (!item) continue;

      if (!item.deliveredReported) {
        const r = await this.report("delivered", { sessionId, deliveryId: id, turnId: item.turnId });
        if (r.kind === "retry") return retry(r);
        item = await this.update(id, (it) => {
          it.deliveredReported = true;
          if (r.kind === "drop") {
            it.lastError = `delivered refused: ${r.code}: ${r.message}`;
            addEvent(it, this.now(), "delivered-refused", `${r.code}: ${r.message}`);
          } else addEvent(it, this.now(), "delivered-reported", item!.turnId);
        });
        this.log(r.kind === "ok" ? `${id}: reported delivered (turn ${item?.turnId})` : `${id}: delivered refused (${r.code}: ${r.message})`);
        if (!item || isSettled(item)) continue;
      }

      if (item.outcome && !item.outcomeReported) {
        const outcome = item.outcome;
        const r = await this.report("outcome", { sessionId, deliveryId: id, turnId: item.turnId, ...outcome } as Requests["outcome"]);
        if (r.kind === "retry") return retry(r);
        item = await this.update(id, (it) => {
          it.outcomeReported = true;
          if (r.kind === "ok") {
            if (outcome.outcome === "replied" && it.state === "answered") {
              it.state = "replied";
              if (r.body.answerMessageId) it.answerMessageId = r.body.answerMessageId;
            }
            addEvent(it, this.now(), "outcome-reported", `${outcome.outcome}${r.body.duplicate ? " (duplicate)" : ""}`);
          } else {
            it.lastError = `outcome refused: ${r.code}: ${r.message}`;
            addEvent(it, this.now(), "outcome-refused", `${r.code}: ${r.message}`);
            if (outcome.outcome === "replied" && it.state === "answered") {
              // The connector won't collect it from the "turn": post it as a reply instead.
              it.state = "late-reply-queued";
              it.lateReply = { text: outcome.answer, key: replyKeyFor(`fallback-${id}`) };
            }
          }
        });
        this.log(
          r.kind === "ok"
            ? `${id}: reported ${outcome.outcome}${r.body.answerMessageId ? ` (answer ${r.body.answerMessageId})` : ""}`
            : `${id}: outcome ${outcome.outcome} refused (${r.code}: ${r.message})${item?.state === "late-reply-queued" ? "; posting the answer with reply" : ""}`,
        );
        if (!item || isSettled(item)) continue;
      }

      if (item.state === "late-reply-queued" && item.lateReply) {
        const late = item.lateReply;
        const r = await this.report("reply", { as: this.participant, messageId: item.messageId, text: late.text, key: late.key });
        if (r.kind === "retry") return retry(r);
        await this.update(id, (it) => {
          if (it.state !== "late-reply-queued") return false;
          if (r.kind === "ok") {
            it.state = "replied-late";
            it.lateReply = { ...late, messageId: r.body.message.id };
            it.answerMessageId = r.body.message.id;
            addEvent(it, this.now(), "replied", `reply ${r.body.message.id}${r.body.completed ? `, completed ${r.body.completed}` : ""}`);
          } else {
            it.state = "reply-failed";
            it.lastError = `reply refused: ${r.code}: ${r.message}`;
            addEvent(it, this.now(), "reply-refused", `${r.code}: ${r.message}`);
          }
        });
        this.log(r.kind === "ok" ? `${id}: answer posted with reply (${r.body.message.id})` : `${id}: reply refused (${r.code}: ${r.message})`);
      }
    }

    const desired = this.desiredPresence();
    if (desired !== this.sentPresence) {
      const r = await this.report("presence", { sessionId, status: desired });
      if (r.kind === "retry") return retry(r);
      this.sentPresence = desired;
      if (r.kind === "ok") this.log(`presence: ${desired}`);
    }
    return "ok";
  }

  // -------------------------------------------------------------------------
  // Status

  snapshot() {
    const items = [...this.pending.values()];
    return {
      pid: process.pid,
      participant: this.participant,
      sessionId: this.sessionId,
      registered: this.registered,
      presence: this.sentPresence ?? null,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      stopped: this.stopped ? this.stopReason : null,
      pending: items.length,
      awaitingAnswer: items.filter((i) => i.state === "awaiting-answer").length,
      timedOut: items.filter((i) => i.state === "timed-out" || i.state === "reply-failed").length,
      unread: items.filter((i) => i.state === "unread").length,
      lastError: this.lastError ?? null,
      stats: this.stats,
    };
  }

  private async writeStatus(): Promise<void> {
    await writeFileAtomic(join(this.options.config.home, "status.json"), JSON.stringify(this.snapshot(), null, 2) + "\n");
  }
}
