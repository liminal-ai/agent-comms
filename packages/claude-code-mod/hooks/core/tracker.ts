// Reply matching for deliveries the mod submitted into this session. Pure:
// fed Claude Code's events in order, it says when a delivery was delivered and
// how its turn ended. It never guesses: anything it can't link to our own
// turn's work by identity makes the delivery ambiguous.
//
// - Our turn is the main-loop turn whose `turn.start` text carries our header.
// - Our work: the main loop's tool calls during our turn; the subagents those
//   calls spawned (from the Agent call's result and `agent.spawn`), and their
//   descendants and tool calls; the background tasks those calls started
//   (`backgroundTaskId` in the result, or a task row naming our call).
// - Input entering our turn (a `prompt.submit` carrying our turnId) is ours
//   only when it names our work: a task notification whose every task is ours,
//   or a subagent hand-back from one of our subagents. Anything else (typed at
//   the terminal, a peer, the bridge, the SDK, another plugin) is other input.
// - A `turn.start` whose text holds more than the plugin wrapper and our
//   rendering (other queued prompts merged into it) counts as other input.

import { parseDeliveryHeader } from "../protocol/render.ts";
import type { EnteredInput, OutcomeBody } from "../protocol/loopback.ts";
import type { MessageKind } from "../protocol/model.ts";

/** The protocol's cap on `entered` (packages/protocol/src/loopback.ts). */
export const MAX_ENTERED = 50;

export type Phase = "submitted" | "running" | "done";

/** A task notification that entered our turn: the tasks it names (ids only, never its text). */
export interface NoticeRef {
  at: number;
  tasks: { taskId?: string; toolUseId?: string }[];
}

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
  /** Tool calls our turn made: the main loop's during our turn, and our subagents'. */
  toolUseIds: string[];
  /** Subagents our turn started, and their descendants. */
  agentIds: string[];
  /** Background tasks our calls started (shell task ids). */
  taskIds: string[];
  /** Our tool calls that started background work (a background shell or subagent). */
  backgroundIds: string[];
  /** Input that certainly entered our turn. */
  entered: EnteredInput[];
  /** Task notifications and subagent hand-backs that entered our turn, judged at its end. */
  notices: NoticeRef[];
  handBacks: { at: number; agentId: string }[];
  completion?: { reason: "answer" | "aborted" | "refusal" | "error"; answer: string; at: number };
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
  /** Agent calls of our work in flight: a main-loop spawn during one is ours. */
  private agentCallsInFlight = new Set<string>();

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
      taskIds: [],
      backgroundIds: [],
      entered: [],
      notices: [],
      handBacks: [],
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
    const d = this.running();
    if (!d || !input.turnId || input.turnId !== d.turnId) return;
    if (input.origin.kind === "task-notification") {
      d.notices.push({ at: input.at, tasks: parseTaskNotification(input.text) });
      return;
    }
    const handBack = input.origin.kind === "peer" ? parseHandBack(input.text) : undefined;
    if (handBack) {
      d.handBacks.push({ at: input.at, agentId: handBack });
      return;
    }
    const origin = input.origin.kind === "plugin" && input.origin.name ? `plugin:${input.origin.name}` : input.origin.kind;
    d.entered.push({ origin: origin.slice(0, 64), at: input.at });
  }

  /** A tool call starting. Ours if the main loop makes it during our turn, or one of our subagents does. */
  toolCall(input: { toolUseId?: string; agentId?: string; background?: boolean; tool?: string }): void {
    const d = this.running();
    if (!d || !input.toolUseId) return;
    const ours = input.agentId === undefined ? this.activeTurnId === d.turnId : d.agentIds.includes(input.agentId);
    if (!ours) return;
    if (!d.toolUseIds.includes(input.toolUseId)) d.toolUseIds.push(input.toolUseId);
    if (input.background && !d.backgroundIds.includes(input.toolUseId)) d.backgroundIds.push(input.toolUseId);
    if (input.tool === "Agent") this.agentCallsInFlight.add(input.toolUseId);
  }

  /** A tool call's result: an Agent call names the subagent, a background shell its task. */
  toolResult(input: { toolUseId?: string; result?: unknown }): void {
    if (!input.toolUseId) return;
    this.agentCallsInFlight.delete(input.toolUseId);
    const d = this.running();
    if (!d || !d.toolUseIds.includes(input.toolUseId)) return;
    const result = (input.result ?? {}) as { agentId?: unknown; backgroundTaskId?: unknown };
    if (typeof result.agentId === "string" && result.agentId !== "") {
      addOnce(d.agentIds, result.agentId);
      addOnce(d.backgroundIds, input.toolUseId);
    }
    if (typeof result.backgroundTaskId === "string" && result.backgroundTaskId !== "") {
      addOnce(d.taskIds, result.backgroundTaskId);
      addOnce(d.backgroundIds, input.toolUseId);
    }
  }

  /**
   * `agent.spawn` resolved. Ours if spawned inside one of our subagents, or
   * from the main loop while one of our Agent calls is running (the main loop's
   * calls during our turn are ours). A plugin's own spawn is never ours.
   */
  agentSpawned(input: { agentId?: string; parentAgentId?: string; engine: boolean }): void {
    const d = this.running();
    if (!d || !input.agentId || !input.engine) return;
    const ours =
      input.parentAgentId !== undefined ? d.agentIds.includes(input.parentAgentId) : this.agentCallsInFlight.size > 0 && this.activeTurnId === d.turnId;
    if (ours) addOnce(d.agentIds, input.agentId);
  }

  /** A task-notification row: maps a task id to the call that started it. */
  taskRow(task: { id?: string; toolUseId?: string }): void {
    for (const d of this.deliveries.values()) {
      if (d.phase === "submitted") continue;
      if (task.id && task.toolUseId && d.toolUseIds.includes(task.toolUseId)) addOnce(d.taskIds, task.id);
    }
  }

  /**
   * A request whose turn is over but started background work that may still
   * report: a later notification naming that work is a follow-up the agent
   * should send with `comms reply`.
   */
  followUpFor(notificationText: string): Tracked | undefined {
    const tasks = parseTaskNotification(notificationText);
    if (tasks.length === 0) return undefined;
    let found: Tracked | undefined;
    for (const d of this.deliveries.values()) {
      if (d.phase !== "done" || d.kind !== "request") continue;
      const background = (t: { taskId?: string; toolUseId?: string }) =>
        t.toolUseId !== undefined ? d.backgroundIds.includes(t.toolUseId) : t.taskId !== undefined && (d.agentIds.includes(t.taskId) || d.taskIds.includes(t.taskId));
      if (tasks.some(background)) found = d;
    }
    return found;
  }

  turnComplete(input: {
    turnId: string;
    agentId?: string;
    reason: "answer" | "aborted" | "refusal" | "error";
    answer: string;
    at: number;
  }): Action[] {
    // A subagent's turn is never ours to collect, and says nothing about whose it is.
    if (input.agentId) return [];
    if (this.activeTurnId === input.turnId) this.activeTurnId = undefined;
    const d = this.running();
    if (!d || d.turnId !== input.turnId) return [];
    d.completion = { reason: input.reason, answer: input.answer, at: input.at };
    return this.finish(d);
  }

  private finish(d: Tracked): Action[] {
    const completion = d.completion!;
    const entered: EnteredInput[] = [...d.entered];
    for (const notice of d.notices) {
      const ours = notice.tasks.length > 0 && notice.tasks.every((t) => isOurTask(d, t));
      if (!ours) entered.push({ origin: "task-notification", at: notice.at });
    }
    for (const h of d.handBacks) if (!d.agentIds.includes(h.agentId)) entered.push({ origin: "peer", at: h.at });
    entered.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    d.phase = "done";
    this.agentCallsInFlight.clear();
    let outcome: OutcomeBody;
    if (entered.length > 0) outcome = { outcome: "ambiguous", entered: capEntered(entered) };
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

function addOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function isOurTask(d: Tracked, t: { taskId?: string; toolUseId?: string }): boolean {
  if (t.toolUseId !== undefined) return d.toolUseIds.includes(t.toolUseId);
  if (t.taskId !== undefined) return d.agentIds.includes(t.taskId) || d.taskIds.includes(t.taskId);
  return false;
}

/** Within the protocol's cap: the first ones, then one entry saying how many more. */
export function capEntered(entered: EnteredInput[]): EnteredInput[] {
  if (entered.length <= MAX_ENTERED) return entered;
  const kept = entered.slice(0, MAX_ENTERED - 1);
  const rest = entered.length - kept.length;
  return [...kept, { origin: `+${rest} more`, at: entered[MAX_ENTERED - 1]!.at }];
}

const TASK_BLOCK = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g;

/** The tasks a task-notification prompt names, one per block (2.1.286: `<task-id>`, `<tool-use-id>`). */
export function parseTaskNotification(text: string): { taskId?: string; toolUseId?: string }[] {
  const tasks: { taskId?: string; toolUseId?: string }[] = [];
  for (const block of text.matchAll(TASK_BLOCK)) {
    const body = block[1] ?? "";
    const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(body)?.[1];
    const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(body)?.[1];
    tasks.push({ ...(taskId ? { taskId } : {}), ...(toolUseId ? { toolUseId } : {}) });
  }
  // A block that names nothing can't be linked.
  return tasks.some((t) => !t.taskId && !t.toolUseId) ? [{}] : tasks;
}

const HAND_BACK = /^<agent-message from="([A-Za-z0-9_-]{1,128})">\n\[Subagent hand-back\]/;

/**
 * The subagent a hand-back prompt comes from: exactly one frame, at the start.
 *
 * Why the text is parsed: Claude Code 2.1.286 gives the hand-back no structured
 * sender id. Its `prompt.submit` origin is a bare `peer`; neither `session.send`
 * nor `session.receive` fires for it; and the transcript row's `from` holds the
 * subagent's type (`general-purpose`), not its id (checked live, 2026-10-01). The
 * frame is the engine's own: it opens the prompt at column zero, and the engine
 * indents every line of the report inside it, so a frame-like line in a report is
 * never at column zero. Another session's message is framed differently. So only
 * a prompt that starts with the frame, carries exactly one, and names one of our
 * subagents counts as ours; a message that merely mentions our helper's id doesn't.
 */
export function parseHandBack(text: string): string | undefined {
  const match = HAND_BACK.exec(text);
  if (!match) return undefined;
  if ((text.match(/<agent-message /g) ?? []).length !== 1) return undefined;
  return match[1];
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
