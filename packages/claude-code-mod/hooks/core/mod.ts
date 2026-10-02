// The mod's behaviour, independent of Claude Code's `$`: registration, one
// poll at a time, submitting deliveries, answering restart checks, reporting
// turns and presence to the connector. register.ts binds it to the engine;
// tests bind it to fakes.

import { findAnswerProofs } from "../protocol/proof.ts";
import { renderDelivery, renderUnmatchedNotice } from "../protocol/render.ts";
import {
  MAX_POLL_WAIT_MS,
  type DeliveryCheck,
  type ErrorCode,
  type Op,
  opPath,
  parseResponse,
  type PollItem,
  type Requests,
  type ResponseBody,
  type Responses,
} from "../protocol/loopback.ts";
import type { Delivery } from "../protocol/model.ts";
import { type Action, type Tracked, Tracker } from "./tracker.ts";

export interface Host {
  /** POST /v1/<op> over the connector's socket. Rejects if the connector can't be reached. */
  call(path: string, body: string): Promise<{ status: number; text: string }>;
  /** `$.prompt.submit`. Resolves `{ dropped }` when a hook refused the prompt. */
  submit(text: string): Promise<{ dropped?: string }>;
  now(): number;
  /** Resolves after `ms` (the engine's `$.clock.sleep`). */
  sleep?(ms: number): Promise<void>;
  log(line: string): void;
  loadJournal(): Promise<string | null>;
  saveJournal(text: string): Promise<void>;
  /** Whether this session's transcript holds a user message with this text. */
  transcriptHas(needle: string): Promise<boolean>;
}

export interface ModOptions {
  participant: string;
  sessionId: string;
  cwd: string;
  pluginName: string;
  /** How long the connector may hold a poll (default: the connector's own, at most MAX_POLL_WAIT_MS). */
  pollWaitMs?: number;
  /** How long any other connector call may take before it counts as unavailable. */
  callTimeoutMs?: number;
  /** Margin on top of a poll's hold before it counts as hung (default POLL_GRACE_MS). */
  pollGraceMs?: number;
  /** How long the session may sit idle with our prompt not started before we stop waiting for it. */
  startDeadlineMs?: number;
}

/** Margin on top of a poll's hold before the poll counts as hung. */
const POLL_GRACE_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
/** A plugin prompt runs as soon as the session is idle; idle this long without it starting, it isn't coming. */
const DEFAULT_START_DEADLINE_MS = 60_000;

type Report = { op: "delivered" | "outcome" | "check-result" | "presence" | "answer-seen"; body: Record<string, unknown> };

const JOURNAL_KEEP = 200;
/** Delivery ids remembered for restart checks; past this the journal is marked incomplete. */
const SEEN_KEEP = 5_000;
/**
 * Allowance for clock skew between the server that stamps a delivery's creation
 * time and this machine: a delivery counts as created after a history loss only
 * if it was created this much later.
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

interface JournalFile {
  participant?: string;
  deliveries?: Tracked[];
  seen?: string[];
  /**
   * When the journal's history was last lost (epoch ms): a missing, empty or
   * unreadable file, or dropped ids. Absence proves nothing for a delivery
   * created before then; everything created after is fully journaled.
   */
  historyLostAt?: number;
  /** Older versions: a loss window end, or a loss with no time recorded. */
  incompleteUntil?: number;
  incomplete?: boolean;
}

export class CommsMod {
  readonly tracker: Tracker;
  private registered = false;
  private registering: Promise<boolean> | null = null;
  private polling = false;
  private stopped = false;
  private busy = false;
  /** The main turn running now (fix pass 0.1): stamps a waiting send, and only its tool results confirm an answer. */
  private mainTurnId: string | undefined;
  private presenceTurnSent: string | undefined;
  private presenceSent: "idle" | "busy" | undefined;
  private reports: Report[] = [];
  private flushing = false;
  /** Checks we can't answer yet (our prompt is queued). */
  private deferredChecks = new Map<string, DeliveryCheck>();
  /** Every delivery id seen, including ones from earlier sessions of this participant. */
  private seen = new Set<string>();
  private journalLoaded = false;
  /** When the journal's history was last lost (0: never). See JournalFile.historyLostAt. */
  private historyLostAt = 0;
  /** When the session last became idle (no main turn running); undefined while busy. */
  private idleSince: number | undefined;
  /** Submitted deliveries whose prompt didn't start by the deadline: still tracked, checks answer unknown. */
  private stalled = new Set<string>();

  private readonly host: Host;
  private readonly options: ModOptions;

  constructor(host: Host, options: ModOptions) {
    this.host = host;
    this.options = options;
    this.tracker = new Tracker(options.pluginName);
    this.idleSince = host.now();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  // ---------------------------------------------------------------------
  // Connector calls

  /**
   * One connector call, bounded: a connector that accepts and never answers
   * counts as unavailable after the timeout (a poll after its hold plus a
   * margin), so polling and session exit never hang on it.
   */
  private async call<K extends Op>(op: K, body: Requests[K]): Promise<ResponseBody<K>> {
    const timeoutMs =
      op === "poll" ? (this.options.pollWaitMs ?? MAX_POLL_WAIT_MS) + (this.options.pollGraceMs ?? POLL_GRACE_MS) : (this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    const timedOut = "timed-out" as const;
    try {
      const sleep = this.host.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const res = await Promise.race([this.host.call(opPath(op), JSON.stringify(body)), sleep(timeoutMs).then(() => timedOut)]);
      if (typeof res === "string") {
        this.host.log(`${op}: no answer from the connector in ${timeoutMs} ms`);
        // A poll the connector may still hold would refuse the next one: register again, which replaces it.
        if (op === "poll") this.registered = false;
        return { ok: false, error: { code: "unavailable", message: `timed out after ${timeoutMs} ms` } };
      }
      return parseResponse<K>(res.status, res.text);
    } catch (error) {
      return { ok: false, error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  private async register(): Promise<boolean> {
    if (this.stopped) return false;
    this.registering ??= (async () => {
      try {
        const res = await this.call("register", {
          participant: this.options.participant,
          harness: "claude-code",
          sessionId: this.options.sessionId,
          cwd: this.options.cwd,
          status: this.busy ? "busy" : "idle",
          ...(this.busy && this.mainTurnId ? { turnId: this.mainTurnId } : {}),
        });
        if (res.ok) {
          this.registered = true;
          this.presenceSent = this.busy ? "busy" : "idle";
          this.presenceTurnSent = this.busy ? this.mainTurnId : undefined;
          this.host.log(`registered as @${res.participant.name}`);
          return true;
        }
        this.registered = false;
        this.onError("register", res.error.code, res.error.message);
        return false;
      } finally {
        this.registering = null;
      }
    })();
    return this.registering;
  }

  private onError(what: string, code: ErrorCode, message: string): void {
    if (code === "session_superseded") {
      this.host.log(`${what}: a newer session took over @${this.options.participant}; stopping`);
      this.stopped = true;
      return;
    }
    if (code === "unknown_session") this.registered = false;
    if (code === "unknown_participant" || code === "not_homed_here") {
      this.host.log(`${what}: ${message}; stopping`);
      this.stopped = true;
      return;
    }
    this.host.log(`${what}: ${code}: ${message}`);
  }

  // ---------------------------------------------------------------------
  // Lifecycle

  async start(): Promise<void> {
    await this.loadJournal();
    await this.register();
  }

  /** Called on every clock tick: start deadlines, flush reports, keep one poll outstanding. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    this.checkStartDeadlines();
    if (!this.registered && !(await this.register())) return;
    void this.flush();
    if (!this.polling) void this.poll();
  }

  /** Session end: a last flush and unregister, each bounded by the call timeout. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    const sleep = this.host.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await Promise.race([this.flush(), sleep(this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)]);
    this.stopped = true;
    if (this.registered) await this.call("unregister", { sessionId: this.options.sessionId });
  }

  /**
   * A plugin prompt runs once the session is idle. If the session has been
   * idle past the deadline and ours hasn't started, it was cleared or never
   * queued. Claude Code can't cancel or list queued prompts, so we can't prove
   * it won't start: keep tracking it (a late start is still reported), and
   * answer a restart check `unknown` so the connector never re-runs it.
   */
  private checkStartDeadlines(): void {
    if (this.idleSince === undefined) return;
    const deadline = this.options.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS;
    const now = this.host.now();
    for (const d of this.tracker.deliveries.values()) {
      if (d.phase !== "submitted" || d.sessionId !== this.options.sessionId || this.stalled.has(d.deliveryId)) continue;
      if (now - Math.max(d.submittedAt, this.idleSince) < deadline) continue;
      this.stalled.add(d.deliveryId);
      this.host.log(`${d.deliveryId}: prompt not started after ${deadline} ms idle; still tracking, checks answer unknown`);
      const check = this.deferredChecks.get(d.deliveryId);
      if (check) {
        this.deferredChecks.delete(d.deliveryId);
        void this.check(check);
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const res = await this.call("poll", {
        sessionId: this.options.sessionId,
        ...(this.options.pollWaitMs !== undefined ? { waitMs: this.options.pollWaitMs } : {}),
      });
      if (!res.ok) return this.onError("poll", res.error.code, res.error.message);
      for (const item of res.items) await this.handle(item);
    } finally {
      this.polling = false;
    }
  }

  private async handle(item: PollItem): Promise<void> {
    if (item.type === "deliver") return this.deliver(item.delivery);
    return this.check(item.check);
  }

  // ---------------------------------------------------------------------
  // Deliveries

  private async deliver(delivery: Delivery): Promise<void> {
    if (this.seen.has(delivery.id) || this.tracker.deliveries.has(delivery.id)) return;
    this.seen.add(delivery.id);
    const rendered = renderDelivery(delivery, { harnessLabelsSource: true });
    this.tracker.submitted({
      deliveryId: delivery.id,
      messageId: delivery.message.id,
      kind: delivery.message.kind,
      rendered,
      sessionId: this.options.sessionId,
      at: this.host.now(),
      sender: delivery.message.sender.name,
      recipient: delivery.recipient.name,
      seq: delivery.message.seq,
    });
    // Journal before submitting: after a crash, an entry means "maybe submitted".
    // If it can't be written, a later restart check couldn't know: don't submit.
    if (!(await this.saveJournal())) {
      const d = this.tracker.deliveries.get(delivery.id)!;
      d.phase = "done";
      this.host.log(`${d.deliveryId}: journal not writable, not submitted`);
      if (d.kind === "request") {
        d.outcome = { outcome: "failed", reason: "rejected", detail: "the mod could not write its journal, so it did not submit the delivery" };
        this.queue({ op: "outcome", body: { sessionId: this.options.sessionId, deliveryId: d.deliveryId, ...d.outcome } });
      }
      return;
    }
    let result: { dropped?: string };
    try {
      result = await this.host.submit(rendered);
    } catch (error) {
      result = { dropped: error instanceof Error ? error.message : String(error) };
    }
    if (result.dropped !== undefined) {
      const d = this.tracker.deliveries.get(delivery.id)!;
      d.phase = "done";
      if (d.kind === "request") {
        d.outcome = { outcome: "failed", reason: "rejected", detail: result.dropped.slice(0, 2000) };
        // No turn ever started: a failed outcome may omit turnId.
        this.queue({ op: "outcome", body: { sessionId: this.options.sessionId, deliveryId: d.deliveryId, ...d.outcome } });
      }
      await this.saveJournal();
    }
  }

  // ---------------------------------------------------------------------
  // Engine events

  onTurnStart(turnId: string, text: string): void {
    this.mainTurnId = turnId;
    this.setBusy(true);
    const actions = this.tracker.turnStart(turnId, text, this.host.now());
    for (const a of actions) {
      if (a.type === "delivered" && this.stalled.delete(a.deliveryId)) this.host.log(`${a.deliveryId}: started after its deadline; reporting it`);
    }
    this.apply(actions);
  }

  onPromptSubmit(input: { turnId?: string; origin: { kind: string; name?: string }; text: string }): void {
    const ours = [...this.tracker.deliveries.values()].find((d) => d.phase === "running" && d.turnId === input.turnId);
    if (ours) this.host.log(`${ours.deliveryId}: ${input.origin.kind} input during our turn`);
    this.tracker.promptSubmit({ ...input, at: this.host.now() });
  }

  /**
   * `text` is the result as the model reads it. A complete answer proof in a main-loop
   * result (no `agentId`: a helper's results never reach the main model) during a main
   * turn confirms that the model saw that answer (fix pass 0.1).
   */
  onToolResult(input: { toolUseId?: string; agentId?: string; result?: unknown; text?: string }): void {
    this.tracker.toolResult({ toolUseId: input.toolUseId, result: input.result });
    if (input.agentId || !this.mainTurnId || typeof input.text !== "string") return;
    const proofs = findAnswerProofs(input.text).slice(0, 50);
    if (proofs.length === 0) return;
    this.host.log(`answer-seen: ${proofs.map((p) => `${p.waitId}/${p.messageId}`).join(", ")} in turn ${this.mainTurnId}`);
    this.queue({ op: "answer-seen", body: { sessionId: this.options.sessionId, turnId: this.mainTurnId, proofs } });
  }

  onAgentSpawned(input: { agentId?: string; parentAgentId?: string; engine: boolean }): void {
    const running = [...this.tracker.deliveries.values()].find((d) => d.phase === "running");
    const before = running?.agentIds.length ?? 0;
    this.tracker.agentSpawned(input);
    if (running) this.host.log(`${running.deliveryId}: subagent ${input.agentId ?? "?"} spawned (parent ${input.parentAgentId ?? "main"}) ${running.agentIds.length > before ? "ours" : "not ours"}`);
  }

  onToolCall(input: { toolUseId?: string; agentId?: string; background?: boolean; tool?: string }): void {
    const running = [...this.tracker.deliveries.values()].find((d) => d.phase === "running");
    if (running) {
      const where = input.agentId ? `subagent ${input.agentId}` : this.tracker.activeTurnId === running.turnId ? "our turn" : "another turn";
      this.host.log(`${running.deliveryId}: tool ${input.tool ?? "?"} ${input.toolUseId ?? "(no id)"} in ${where}${input.background ? " (background)" : ""}`);
    }
    this.tracker.toolCall(input);
  }

  /**
   * Context to attach to a prompt: for a task notification finishing background
   * work of a request whose turn already ended, how to send the result.
   */
  contextFor(input: { turnId?: string; origin: { kind: string }; text: string }): string | undefined {
    if (input.origin.kind !== "task-notification") return undefined;
    const d = this.tracker.followUpFor(input.text);
    if (!d) return undefined;
    this.host.log(`${d.deliveryId}: follow-up notification, reminding the agent to comms reply`);
    return followUpNote(d, this.options.participant);
  }

  onTaskRow(task: { id?: string; toolUseId?: string }): void {
    this.tracker.taskRow(task);
  }

  onTurnComplete(input: { turnId: string; agentId?: string; reason: "answer" | "aborted" | "refusal" | "error"; answer: string }): void {
    if (!input.agentId) {
      if (this.mainTurnId === input.turnId) this.mainTurnId = undefined;
      this.setBusy(false);
    }
    this.apply(this.tracker.turnComplete({ ...input, at: this.host.now() }));
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (busy) this.idleSince = undefined;
    else this.idleSince ??= this.host.now();
    const status = busy ? "busy" : "idle";
    const turnId = busy ? this.mainTurnId : undefined;
    if (this.presenceSent === status && this.presenceTurnSent === turnId) return;
    this.presenceSent = status;
    this.presenceTurnSent = turnId;
    this.queue({ op: "presence", body: { sessionId: this.options.sessionId, status, ...(turnId ? { turnId } : {}) } });
  }

  private apply(actions: Action[]): void {
    if (actions.length === 0) return;
    for (const action of actions) {
      const d = this.tracker.deliveries.get(action.deliveryId)!;
      this.host.log(`${d.deliveryId}: ${action.type}${action.type === "outcome" ? ` ${action.outcome.outcome}` : ""}`);
      if (action.type === "delivered") {
        this.queue({ op: "delivered", body: { sessionId: this.options.sessionId, deliveryId: d.deliveryId, turnId: action.turnId } });
      } else if (action.type === "outcome") {
        this.queue({ op: "outcome", body: { sessionId: this.options.sessionId, deliveryId: d.deliveryId, turnId: action.turnId, ...action.outcome } });
        if (action.outcome.outcome === "ambiguous") void this.notifyUnmatched(d);
      } else {
        const check = this.deferredChecks.get(d.deliveryId);
        if (check) {
          this.deferredChecks.delete(d.deliveryId);
          void this.check(check);
        }
      }
    }
    // A check for a queued prompt can be answered once its turn has started.
    for (const [id, check] of this.deferredChecks) {
      const d = this.tracker.deliveries.get(id);
      if (d && d.phase === "running") {
        this.deferredChecks.delete(id);
        void this.check(check);
      }
    }
    void this.saveJournal();
  }

  /**
   * Tells the agent its answer wasn't sent, so it answers with `comms reply`.
   * A plugin prompt without a delivery header: its turn is never collected.
   */
  private async notifyUnmatched(d: Tracked): Promise<void> {
    try {
      await this.host.submit(unmatchedNotice(d, this.options.participant));
    } catch (error) {
      this.host.log(`notice for ${d.deliveryId} not submitted: ${String(error)}`);
    }
  }

  // ---------------------------------------------------------------------
  // Restart checks

  private async check(check: DeliveryCheck): Promise<void> {
    const base = { sessionId: this.options.sessionId, deliveryId: check.deliveryId };
    const d = this.tracker.deliveries.get(check.deliveryId);
    if (d && d.sessionId === this.options.sessionId) {
      if (d.phase === "submitted") {
        if (this.stalled.has(d.deliveryId)) {
          return this.queue({ op: "check-result", body: { ...base, found: "unknown", detail: "submitted, but the session went idle without starting it" } });
        }
        this.deferredChecks.set(check.deliveryId, check);
        return;
      }
      if (d.phase === "running") return this.queue({ op: "check-result", body: { ...base, found: "yes", turnId: d.turnId!, turn: "running" } });
      if (d.outcome && d.turnId) {
        return this.queue({ op: "check-result", body: { ...base, found: "yes", turnId: d.turnId, turn: "completed", ...d.outcome } });
      }
      if (d.turnId) {
        // An answer's delivery ran and has no outcome to report.
        return this.queue({ op: "check-result", body: { ...base, found: "yes", turnId: d.turnId, turn: "completed" } });
      }
      return this.queue({ op: "check-result", body: { ...base, found: "unknown", detail: "refused before it started" } });
    }
    if (d) {
      // Submitted by an earlier session of this participant.
      if (d.outcome && d.turnId) {
        return this.queue({ op: "check-result", body: { ...base, found: "yes", turnId: d.turnId, turn: "completed", ...d.outcome } });
      }
      return this.queue({
        op: "check-result",
        body: { ...base, found: "unknown", detail: `handed to an earlier session (${d.sessionId}); its turn wasn't seen to finish` },
      });
    }
    // Not in memory: another session of this participant may have journaled it since we loaded.
    if (await this.reloadJournal()) {
      const fresh = this.tracker.deliveries.get(check.deliveryId);
      if (fresh) return this.check(check);
    }
    if (!this.journalCovers(check) || this.seen.has(check.deliveryId)) {
      return this.queue({ op: "check-result", body: { ...base, found: "unknown", detail: "the mod's journal can't rule it out" } });
    }
    // A compacted transcript can't prove absence; it can only show presence.
    const header = `delivery=${check.deliveryId} message=${check.messageId}`;
    let inTranscript = false;
    try {
      inTranscript = await this.host.transcriptHas(header);
    } catch (error) {
      return this.queue({ op: "check-result", body: { ...base, found: "unknown", detail: `transcript unreadable: ${String(error)}`.slice(0, 2000) } });
    }
    if (inTranscript) return this.queue({ op: "check-result", body: { ...base, found: "unknown", detail: "in the transcript but not in the mod's journal" } });
    // The journal is written before every submission and was read whole: never submitted.
    this.queue({ op: "check-result", body: { ...base, found: "no" } });
  }

  // ---------------------------------------------------------------------
  // Reports: acknowledged by the connector at once; retried here until then.

  private queue(report: Report): void {
    this.reports.push(report);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      while (this.reports.length > 0 && !this.stopped) {
        if (!this.registered && !(await this.register())) return;
        const report = this.reports[0]!;
        const res = await this.call(report.op, report.body as never);
        if (res.ok) {
          this.reports.shift();
          continue;
        }
        const code = res.error.code;
        if (code === "unknown_session") {
          this.registered = false;
          continue;
        }
        if (code === "unavailable" || code === "internal") {
          this.host.log(`${report.op}: ${code}: ${res.error.message}; will retry`);
          return;
        }
        // Not retryable (conflict, bad_request, unknown_delivery, superseded): drop it.
        this.onError(report.op, code, res.error.message);
        this.reports.shift();
        // The connector no longer takes this turn's answer (e.g. it ran after the
        // delivery went uncertain): tell the agent to send it with comms reply.
        if (report.op === "outcome" && code === "conflict" && report.body.outcome === "replied") {
          const d = this.tracker.deliveries.get(String(report.body.deliveryId));
          if (d) void this.notifyUnmatched(d);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // ---------------------------------------------------------------------
  // Journal: what this participant's sessions submitted, for restart checks.

  private async loadJournal(): Promise<void> {
    if (this.journalLoaded) return;
    this.journalLoaded = true;
    const file = await this.readJournalFile();
    if (file) this.merge(file);
    // A missing or empty journal: write one now, so the loss time is pinned to
    // this moment rather than moving forward with every later read.
    if (file === null) await this.saveJournal();
  }

  /** Reads the journal and merges it in. False (and the journal counts as incomplete) if it can't be read. */
  private async reloadJournal(): Promise<boolean> {
    const file = await this.readJournalFile();
    if (file === undefined) return false;
    this.merge(file);
    return true;
  }

  /**
   * Whether absence from the journal proves this delivery was never submitted:
   * only if no history was ever lost, or it was created after the last loss.
   * A check whose creation time isn't a number (an older connector) can't be placed.
   */
  private journalCovers(check: DeliveryCheck): boolean {
    if (this.historyLostAt === 0) return true;
    return typeof check.createdAt === "number" && check.createdAt > this.historyLostAt + CLOCK_SKEW_MS;
  }

  private journalLost(reason: string): void {
    this.host.log(`journal history lost (${reason}): deliveries created before now are checked as unknown`);
    this.historyLostAt = Math.max(this.historyLostAt, this.host.now());
  }

  /**
   * The journal on disk. A missing or empty file is history we can't vouch for
   * (never written, deleted, or truncated), the same as an unreadable one: the
   * journal then counts as incomplete. Returns null for missing/empty (nothing to
   * merge), undefined when unreadable.
   */
  private async readJournalFile(): Promise<JournalFile | null | undefined> {
    let text: string | null;
    try {
      text = await this.host.loadJournal();
    } catch (error) {
      this.journalLost(`unreadable: ${String(error)}`);
      return undefined;
    }
    if (!text || text.trim() === "") {
      this.journalLost(text === null ? "no journal file" : "empty journal file");
      return null;
    }
    try {
      return JSON.parse(text) as JournalFile;
    } catch (error) {
      this.journalLost(`unreadable: ${String(error)}`);
      return undefined;
    }
  }

  private merge(file: JournalFile | null): void {
    if (!file) return;
    if (typeof file.historyLostAt === "number") this.historyLostAt = Math.max(this.historyLostAt, file.historyLostAt);
    // Older versions' markers carry no reliable loss time: treat the loss as now.
    if (file.incomplete || typeof file.incompleteUntil === "number") this.journalLost("marked by an earlier version");
    for (const id of file.seen ?? []) this.seen.add(id);
    for (const d of file.deliveries ?? []) {
      this.seen.add(d.deliveryId);
      const mine = this.tracker.deliveries.get(d.deliveryId);
      if (mine && mine.sessionId === this.options.sessionId) continue;
      // A turn from another session can't be watched from here: keep it for checks only.
      if (d.sessionId !== this.options.sessionId && d.phase !== "done") d.phase = "done";
      this.tracker.deliveries.set(d.deliveryId, d);
    }
  }

  /** Merges with what's on disk (another session may have written), then writes. False if it couldn't write. */
  private async saveJournal(): Promise<boolean> {
    const onDisk = await this.readJournalFile();
    if (onDisk !== undefined) this.merge(onDisk);
    const deliveries = [...this.tracker.deliveries.values()].slice(-JOURNAL_KEEP);
    const seen = [...this.seen];
    if (seen.length > SEEN_KEEP) this.journalLost("old delivery ids dropped");
    const file: JournalFile = {
      participant: this.options.participant,
      deliveries,
      seen: seen.slice(-SEEN_KEEP),
      ...(this.historyLostAt > 0 ? { historyLostAt: this.historyLostAt } : {}),
    };
    try {
      await this.host.saveJournal(JSON.stringify(file));
      return true;
    } catch (error) {
      this.host.log(`journal not saved: ${String(error)}`);
      return false;
    }
  }
}

/** The protocol's notice, from what the journal keeps of the delivery. */
export function unmatchedNotice(d: Pick<Tracked, "deliveryId" | "messageId" | "sender" | "recipient" | "seq">, participant: string): string {
  const ref = (name: string) => ({ id: name, name, kind: "agent" as const });
  const delivery = {
    id: d.deliveryId,
    recipient: ref(d.recipient ?? participant),
    message: { id: d.messageId, seq: d.seq ?? 0, sender: ref(d.sender ?? "unknown") },
  } as unknown as Parameters<typeof renderUnmatchedNotice>[0];
  return renderUnmatchedNotice(delivery, { harnessLabelsSource: true });
}

/** The reminder attached to a notification of background work from a request whose turn has ended, worded from what happened. */
export function followUpNote(d: Pick<Tracked, "messageId" | "sender" | "recipient" | "outcome">, participant: string): string {
  const me = d.recipient ?? participant;
  const from = d.sender ? ` from @${d.sender}` : "";
  const send = `comms reply --as ${me} ${d.messageId} "<result>"`;
  const lines = [`[agent-comms] This notification is for background work you started while answering request ${d.messageId}${from}.`];
  switch (d.outcome?.outcome) {
    case "replied":
      lines.push(`Your final message in that turn was sent as the answer. If this result completes or changes it, send it with: ${send}`);
      break;
    case "ambiguous":
      lines.push(`Your reply in that turn was not sent, because other input entered that turn. If you haven't already, send your answer with: ${send}`);
      break;
    case "failed":
      lines.push(`That turn ended without an answer being sent (${d.outcome.reason}). Send your answer with: ${send}`);
      break;
    default:
      lines.push(`It isn't known whether your reply in that turn was sent. If this completes the answer, send it with: ${send}`);
  }
  return lines.join("\n");
}

export type { Responses };
