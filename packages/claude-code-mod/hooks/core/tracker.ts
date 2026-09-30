// Reply matching for deliveries the mod submitted into this session. Pure:
// fed Claude Code's events in order, it says when a delivery was delivered and
// how its turn ended. It never guesses: anything it can't link to our own
// turn's work makes the delivery ambiguous.
//
// - Our turn is the main-loop turn whose `turn.start` text carries our header.
// - Other input in our turn: a `prompt.submit` carrying our turnId. A task
//   notification counts unless its row links it to a tool call or subagent our
//   turn started. Any other prompt typed or delivered during our turn counts
//   unless the next turn starts with it (then it waited for that turn).
// - A `turn.start` whose text holds more than the plugin wrapper and our
//   rendering (other queued prompts merged into it) counts as other input.

import { parseDeliveryHeader } from "../protocol/render.ts";
import type { EnteredInput, OutcomeBody } from "../protocol/loopback.ts";
import type { MessageKind } from "../protocol/model.ts";

/** How long after our turn ends a prompt typed during it may take to start its own turn. */
export const SETTLE_MS = 3_000;

export type Phase = "submitted" | "running" | "settling" | "done";

export interface Tracked {
  deliveryId: string;
  messageId: string;
  kind: MessageKind;
  /** For the notice sent when the reply can't be matched. */
  sender?: string;
  recipient?: string;
  seq?: number;
  /** The exact text submitted, to tell our prompt from others merged into its turn. */
  rendered: string;
  sessionId: string;
  phase: Phase;
  submittedAt: number;
  turnId?: string;
  /** Main-loop tool calls of our turn. */
  toolUseIds: string[];
  /** Subagents seen during our turn. */
  agentIds: string[];
  /** Tool calls of our turn that started background work (a background shell or subagent). */
  backgroundIds: string[];
  /** Input that certainly entered our turn. */
  entered: EnteredInput[];
  /** Prompts typed or delivered during our turn: entered unless the next turn starts with them. */
  maybeQueued: { origin: string; text: string; at: number }[];
  /** Task notifications delivered into our turn, and the task rows linked to our work while it ran. */
  taskNotices: number;
  linkedTaskRows: number;
  /** Tasks already counted, by id or call: a row can be drawn more than once. */
  linkedTasks?: string[];
  completion?: { reason: "answer" | "aborted" | "refusal" | "error"; answer: string; at: number };
  settleUntil?: number;
  /** For requests, once decided. */
  outcome?: OutcomeBody;
}

export type Action =
  | { type: "delivered"; deliveryId: string; turnId: string }
  | { type: "outcome"; deliveryId: string; turnId: string; outcome: OutcomeBody }
  | { type: "done"; deliveryId: string };

export class Tracker {
  readonly deliveries = new Map<string, Tracked>();
  /** The main-loop turn running now, whoever started it. */
  activeTurnId: string | undefined;

  readonly pluginName: string;

  constructor(pluginName: string) {
    this.pluginName = pluginName;
  }

  submitted(input: {
    deliveryId: string;
    messageId: string;
    kind: MessageKind;
    rendered: string;
    sessionId: string;
    at: number;
    sender?: string;
    recipient?: string;
    seq?: number;
  }): Tracked {
    const tracked: Tracked = {
      ...input,
      phase: "submitted",
      submittedAt: input.at,
      toolUseIds: [],
      agentIds: [],
      backgroundIds: [],
      entered: [],
      maybeQueued: [],
      taskNotices: 0,
      linkedTaskRows: 0,
    };
    this.deliveries.set(input.deliveryId, tracked);
    return tracked;
  }

  /** The delivery whose turn is running now, if any. */
  private running(): Tracked | undefined {
    for (const d of this.deliveries.values()) if (d.phase === "running") return d;
    return undefined;
  }

  turnStart(turnId: string, text: string, at: number): Action[] {
    this.activeTurnId = turnId;
    const actions: Action[] = [];
    // A prompt that waited for this turn did not enter the one before it.
    for (const d of this.deliveries.values()) {
      if (d.phase !== "settling") continue;
      d.maybeQueued = d.maybeQueued.filter((q) => !(q.text.trim() !== "" && text.includes(q.text.trim())));
      actions.push(...this.finish(d, at));
    }
    const header = parseDeliveryHeader(text);
    const d = header ? this.deliveries.get(header.deliveryId) : undefined;
    if (d && d.phase === "submitted" && header!.messageId === d.messageId) {
      d.phase = "running";
      d.turnId = turnId;
      if (hasOtherPrompt(text, d.rendered)) d.entered.push({ origin: "merged-prompt", at });
      actions.push({ type: "delivered", deliveryId: d.deliveryId, turnId });
      if (d.kind === "answer") {
        // An answer is delivered, never collected: its turn is the requester's own.
        d.phase = "done";
        actions.push({ type: "done", deliveryId: d.deliveryId });
      }
    }
    return actions;
  }

  promptSubmit(input: { turnId?: string; origin: { kind: string; name?: string }; text: string; at: number }): void {
    if (input.origin.kind === "plugin" && input.origin.name === this.pluginName) return;
    const d = this.running();
    if (!d || !input.turnId || input.turnId !== d.turnId) return;
    if (input.origin.kind === "task-notification") d.taskNotices += 1;
    else d.maybeQueued.push({ origin: input.origin.kind, text: input.text, at: input.at });
  }

  toolCall(input: { toolUseId?: string; agentId?: string; background?: boolean }): void {
    const d = this.running();
    if (!d || this.activeTurnId !== d.turnId) return;
    if (input.agentId) {
      if (!d.agentIds.includes(input.agentId)) d.agentIds.push(input.agentId);
    } else if (input.toolUseId && !d.toolUseIds.includes(input.toolUseId)) {
      d.toolUseIds.push(input.toolUseId);
      if (input.background) d.backgroundIds.push(input.toolUseId);
    }
  }

  /**
   * A request whose turn is over but started background work that may still
   * report: a later notification naming one of its calls is a follow-up the
   * agent should send with `comms reply`.
   */
  followUpFor(notificationText: string): Tracked | undefined {
    let found: Tracked | undefined;
    for (const d of this.deliveries.values()) {
      if (d.phase !== "done" || d.kind !== "request" || d.backgroundIds === undefined) continue;
      const ids = [...d.backgroundIds, ...d.agentIds];
      if (ids.some((id) => id !== "" && notificationText.includes(id))) found = d;
    }
    return found;
  }

  /** A subagent's id, from wherever it's seen (an Agent tool result, its turns). */
  agentSeen(agentId: string): void {
    const d = this.running();
    if (d && !d.agentIds.includes(agentId)) d.agentIds.push(agentId);
  }

  /** A task-notification row, while our turn runs: linked if it names work our turn started. */
  taskRow(task: { id?: string; toolUseId?: string }): void {
    const d = this.running();
    if (!d) return;
    const linked =
      (task.toolUseId !== undefined && d.toolUseIds.includes(task.toolUseId)) ||
      (task.id !== undefined && d.agentIds.includes(task.id));
    const key = task.id ?? task.toolUseId;
    d.linkedTasks ??= [];
    if (linked && key !== undefined && !d.linkedTasks.includes(key)) {
      d.linkedTasks.push(key);
      d.linkedTaskRows += 1;
    }
  }

  turnComplete(input: {
    turnId: string;
    agentId?: string;
    reason: "answer" | "aborted" | "refusal" | "error";
    answer: string;
    at: number;
  }): Action[] {
    if (input.agentId) {
      this.agentSeen(input.agentId);
      return [];
    }
    if (this.activeTurnId === input.turnId) this.activeTurnId = undefined;
    const d = this.running();
    if (!d || d.turnId !== input.turnId) return [];
    d.completion = { reason: input.reason, answer: input.answer, at: input.at };
    if (d.maybeQueued.length > 0) {
      d.phase = "settling";
      d.settleUntil = input.at + SETTLE_MS;
      return [];
    }
    return this.finish(d, input.at);
  }

  /** Settles deliveries whose wait for a queued prompt's own turn has passed. */
  tick(now: number): Action[] {
    const actions: Action[] = [];
    for (const d of this.deliveries.values()) {
      if (d.phase === "settling" && d.settleUntil !== undefined && now >= d.settleUntil) actions.push(...this.finish(d, now));
    }
    return actions;
  }

  private finish(d: Tracked, at: number): Action[] {
    const completion = d.completion!;
    const entered = [
      ...d.entered,
      ...d.maybeQueued.map((q) => ({ origin: q.origin, at: q.at })),
      ...Array.from({ length: Math.max(0, d.taskNotices - d.linkedTaskRows) }, () => ({ origin: "task-notification", at })),
    ];
    d.maybeQueued = [];
    d.phase = "done";
    delete d.settleUntil;
    let outcome: OutcomeBody;
    if (entered.length > 0) outcome = { outcome: "ambiguous", entered };
    else if (completion.reason === "answer" && completion.answer.trim() !== "") outcome = { outcome: "replied", answer: completion.answer };
    else if (completion.reason === "answer") outcome = { outcome: "failed", reason: "error", detail: "the turn produced no answer" };
    else outcome = { outcome: "failed", reason: completion.reason };
    d.outcome = outcome;
    return [
      { type: "outcome", deliveryId: d.deliveryId, turnId: d.turnId!, outcome },
      { type: "done", deliveryId: d.deliveryId },
    ];
  }
}

// Claude Code's framing around a plugin's prompt (2.1.286). Anything else in
// the turn's text besides our rendering is someone else's prompt.
const WRAPPER_LINES = [
  /^The [\w.@/-]+ plugin sent a message:$/,
  /^This is how Claude Code surfaces a prompt a plugin submits between turns\b.*$/,
];

export function hasOtherPrompt(turnText: string, rendered: string): boolean {
  const at = turnText.indexOf(rendered);
  if (at < 0) return true;
  const rest = (turnText.slice(0, at) + "\n" + turnText.slice(at + rendered.length))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return rest.some((line) => !WRAPPER_LINES.some((re) => re.test(line)));
}
