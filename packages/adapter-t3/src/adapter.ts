// The T3 adapter: delivers a rendered delivery into a T3 thread as a user
// message, finds the turn it went into from T3's own records, and collects
// that turn's final assistant message.
//
// - Our message id is `comms-<delivery id>`, so after a restart the adapter
//   finds its own message in the thread without any local memory.
// - It waits for the thread to be idle before starting a turn, as a courtesy
//   only: a person can start a turn in between, and ownership comes from T3's
//   records, not from the wait.
// - v0.0.44 user messages carry no turn id; our turn is read from T3's other
//   records (see turnOf in model.ts).
// - Ambiguity: any other user message in our turn (someone typed into it, or
//   our message was steered into a turn someone else started) makes it
//   ambiguous. Only the fact is reported, never that message's text.
// - Reads nothing else from the thread.

import { type Delivery, type EnteredInput, renderDelivery } from "@agent-comms/protocol";
import { isBusy, othersInTurn, T3Rejected, type T3Client, type T3Thread, turnFinished, turnOf } from "./model.ts";

export interface Target {
  participant: string;
  /** The T3 thread id. */
  locator: string;
}

export type HandOff = { _tag: "accepted"; turnId: string } | { _tag: "rejected"; detail: string } | { _tag: "lost"; detail: string };
export type Outcome =
  | { _tag: "replied"; answer: string }
  | { _tag: "ambiguous"; entered: EnteredInput[] }
  | { _tag: "failed"; reason: "aborted" | "refusal" | "error"; detail?: string };
export type Check =
  | { _tag: "absent" }
  | { _tag: "running"; turnId: string }
  | { _tag: "completed"; turnId: string; outcome: Outcome }
  | { _tag: "unknown"; detail: string }
  | { _tag: "later"; detail: string };

export interface T3AdapterOptions {
  client: T3Client;
  log?: (line: string) => void;
  /** How long to wait for our message to show up in a turn after starting it. */
  acceptTimeoutMs?: number;
  /** Fallback refresh while waiting, in case a change notification is missed. */
  refreshMs?: number;
  /** Recent turns fetched while watching; the restart check reads the whole thread. */
  watchTurnLimit?: number;
}

export interface T3Adapter {
  ready(target: Target): Promise<boolean>;
  handOff(target: Target, delivery: Delivery): Promise<HandOff>;
  awaitOutcome(target: Target, delivery: Delivery, turnId: string): Promise<Outcome | { _tag: "lost"; detail: string }>;
  check(target: Target, delivery: Delivery, turnId: string | undefined): Promise<Check>;
}

export const messageIdFor = (deliveryId: string) => `comms-${deliveryId}`;

export function makeT3Adapter(options: T3AdapterOptions): T3Adapter {
  const { client } = options;
  const log = options.log ?? (() => {});
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 60_000;
  const refreshMs = options.refreshMs ?? 3_000;
  const turnLimit = options.watchTurnLimit ?? 10;

  /** Resolves with the first non-undefined `test(thread)`, or undefined after `timeoutMs`. */
  async function waitFor<T>(threadId: string, test: (t: T3Thread) => T | undefined, timeoutMs?: number): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let done = false;
      let checking = false;
      let again = false;
      let unwatch: (() => void) | undefined;
      const finish = (value: T | undefined, error?: unknown) => {
        if (done) return;
        done = true;
        clearInterval(refresh);
        if (timer) clearTimeout(timer);
        unwatch?.();
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      const look = async () => {
        if (done) return;
        if (checking) {
          again = true;
          return;
        }
        checking = true;
        try {
          const thread = await client.getThread(threadId, turnLimit);
          if (!thread) return finish(undefined, new T3Rejected(`thread ${threadId} not found`));
          const value = test(thread);
          if (value !== undefined) finish(value);
        } catch (error) {
          log(`reading thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          checking = false;
          if (again) {
            again = false;
            void look();
          }
        }
      };
      const refresh = setInterval(() => void look(), refreshMs);
      const timer = timeoutMs !== undefined ? setTimeout(() => finish(undefined), timeoutMs) : undefined;
      client
        .watch(threadId, () => void look())
        .then((u) => (done ? u() : (unwatch = u)))
        .catch((error) => log(`watching thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`));
      void look();
    });
  }

  function outcomeOf(thread: T3Thread, ourMessageId: string, turnId: string): Outcome {
    const others = othersInTurn(thread, ourMessageId, turnId);
    if (others.length > 0) return { _tag: "ambiguous", entered: others.map(() => ({ origin: "t3-user-message" })) };
    const state = thread.latestTurn?.turnId === turnId ? thread.latestTurn.state : "completed";
    if (state === "interrupted") return { _tag: "failed", reason: "aborted", detail: "the turn was interrupted" };
    if (state === "error") {
      return { _tag: "failed", reason: "error", detail: thread.session?.lastError ?? "the turn ended in an error" };
    }
    const answers = thread.messages.filter((m) => m.role === "assistant" && m.turnId === turnId && !m.streaming && m.text?.trim());
    const final = answers.at(-1);
    if (!final) return { _tag: "failed", reason: "error", detail: "the turn produced no answer" };
    return { _tag: "replied", answer: final.text! };
  }

  return {
    ready: () => client.connected(),

    async handOff(target, delivery) {
      const threadId = target.locator;
      const messageId = messageIdFor(delivery.id);
      try {
        const thread = await client.getThread(threadId, turnLimit);
        if (!thread) return { _tag: "rejected", detail: `T3 thread ${threadId} not found` };
        if (!thread.messages.some((m) => m.id === messageId)) {
          // Courtesy wait; ownership is decided below from T3's records.
          const idle = await waitFor(threadId, (t) => (isBusy(t) ? undefined : t));
          const modes = idle ?? thread;
          await client.startTurn(threadId, {
            messageId,
            text: renderDelivery(delivery, { harnessLabelsSource: false }),
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
          });
        }
        const turnId = await waitFor(threadId, (t) => turnOf(t, messageId), acceptTimeoutMs);
        if (turnId === undefined) return { _tag: "lost", detail: `message ${messageId} wasn't in a turn after ${acceptTimeoutMs} ms` };
        return { _tag: "accepted", turnId };
      } catch (error) {
        if (error instanceof T3Rejected) return { _tag: "rejected", detail: error.message };
        return { _tag: "lost", detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async awaitOutcome(target, delivery, turnId) {
      try {
        const thread = await waitFor(target.locator, (t) => (turnFinished(t, turnId, messageIdFor(delivery.id)) ? t : undefined));
        return outcomeOf(thread!, messageIdFor(delivery.id), turnId);
      } catch (error) {
        return { _tag: "lost", detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async check(target, delivery) {
      const messageId = messageIdFor(delivery.id);
      let thread: T3Thread | null;
      try {
        // The whole thread: our message may be many turns back.
        thread = await client.getThread(target.locator);
      } catch (error) {
        return { _tag: "later", detail: error instanceof Error ? error.message : String(error) };
      }
      if (!thread) return { _tag: "unknown", detail: `T3 thread ${target.locator} not found` };
      const ours = thread.messages.find((m) => m.id === messageId);
      if (!ours) return { _tag: "absent" };
      const turnId = turnOf(thread, messageId);
      if (!turnId) return { _tag: "later", detail: "our message isn't in a turn yet" };
      if (!turnFinished(thread, turnId, messageId)) return { _tag: "running", turnId };
      return { _tag: "completed", turnId, outcome: outcomeOf(thread, messageId, turnId) };
    },
  };
}
