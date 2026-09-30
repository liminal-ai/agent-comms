// The T3 adapter: delivers a rendered delivery into a T3 thread as a user
// message, follows the server's events to find the turn it went into and
// whether anything else entered it, and collects that turn's answer.
//
// - Our message id is `comms-<delivery id>`, so it can always be found again.
// - We wait for the thread to be idle before starting a turn, as a courtesy
//   only: ownership comes from the event order, not from the wait.
// - Ambiguous (Hazel's rule): our message joined a turn already running, or
//   another user message was appended after ours before our turn ended. Only
//   the fact is reported, never that message's text.
// - After a restart: replay the thread's events from the cursor saved with
//   `delivered`; if they're gone, link from the snapshot only when it's
//   certain (see linkFromSnapshot), else say we can't tell.
// - Reads nothing else from the thread.

import { type Delivery, type EnteredInput, renderDelivery, renderUnmatchedNotice } from "@agent-comms/protocol";
import { isBusy, linkFromSnapshot, T3Rejected, type T3Client, type T3StreamItem, type T3Thread, TurnTracker } from "./model.ts";

export interface Target {
  participant: string;
  /** The T3 thread id. */
  locator: string;
}

export type HandOff =
  | { _tag: "accepted"; turnId: string; cursor?: string }
  | { _tag: "rejected"; detail: string }
  | { _tag: "lost"; detail: string };
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
  /** How long to wait for our message to be in a turn after starting it. */
  acceptTimeoutMs?: number;
  /** A replay is taken as finished after this long with no events. */
  replayQuietMs?: number;
  /** After our turn ends, how long to watch for the session stopping (a Claude interrupt). */
  interruptWindowMs?: number;
}

export interface T3Adapter {
  ready(target: Target): Promise<boolean>;
  handOff(target: Target, delivery: Delivery): Promise<HandOff>;
  awaitOutcome(target: Target, delivery: Delivery, turnId: string): Promise<Outcome | { _tag: "lost"; detail: string }>;
  check(target: Target, delivery: Delivery, turnId: string | undefined): Promise<Check>;
  notifyUnmatched(target: Target, delivery: Delivery): Promise<void>;
}

export const messageIdFor = (deliveryId: string) => `comms-${deliveryId}`;
export const noticeIdFor = (deliveryId: string) => `comms-notice-${deliveryId}`;

/** A live subscription feeding a tracker, with a way to wait on it. */
interface Follower {
  tracker: TurnTracker;
  snapshot: T3Thread | undefined;
  synced: boolean;
  lastItemAt: number;
  wait<T>(test: () => T | undefined, timeoutMs?: number): Promise<T | undefined>;
  stop(): void;
}

export function makeT3Adapter(options: T3AdapterOptions): T3Adapter {
  const { client } = options;
  const log = options.log ?? (() => {});
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 60_000;
  const replayQuietMs = options.replayQuietMs ?? 1_500;
  const interruptWindowMs = options.interruptWindowMs ?? 4_000;
  /** Deliveries we're following in this process, by delivery id. */
  const following = new Map<string, Follower>();

  async function follow(threadId: string, tracker: TurnTracker, afterSequence?: number): Promise<Follower> {
    const waiters = new Set<() => void>();
    let unsubscribe: (() => void) | undefined;
    let stopped = false;
    const f: Follower = {
      tracker,
      snapshot: undefined,
      synced: afterSequence === undefined,
      lastItemAt: Date.now(),
      wait: (test, timeoutMs) =>
        new Promise((resolve) => {
          const check = () => {
            const value = test();
            if (value !== undefined) done(value);
          };
          const tick = setInterval(check, 250); // quiet-period tests depend on time, not just items
          const timer = timeoutMs !== undefined ? setTimeout(() => done(undefined), timeoutMs) : undefined;
          function done(value: ReturnType<typeof test> | undefined) {
            waiters.delete(check);
            clearInterval(tick);
            if (timer) clearTimeout(timer);
            resolve(value);
          }
          waiters.add(check);
          check();
        }),
      stop: () => {
        stopped = true;
        unsubscribe?.();
      },
    };
    const onItem = (item: T3StreamItem | { kind: "closed" }) => {
      f.lastItemAt = Date.now();
      if (item.kind === "snapshot") {
        f.snapshot = item.thread;
        if (!tracker.seenOurs) tracker.start(item.thread.session, item.thread.snapshotSequence);
        if (afterSequence !== undefined) f.synced = true; // the events were gone; the snapshot is all there is
      } else if (item.kind === "event") {
        tracker.feed(item.event);
      } else if (item.kind === "synchronized") {
        f.synced = true;
      } else if (item.kind === "closed" && !stopped) {
        // Resume from the last event we saw, without a gap.
        void client
          .subscribe(threadId, { afterSequence: tracker.lastSequence }, onItem)
          .then((u) => (unsubscribe = u))
          .catch((e) => log(`resubscribing to ${threadId}: ${e instanceof Error ? e.message : String(e)}`));
      }
      for (const w of [...waiters]) w();
    };
    unsubscribe = await client.subscribe(threadId, afterSequence !== undefined ? { afterSequence } : {}, onItem);
    return f;
  }

  /** Replays a delivery's events from its cursor; undefined if our message isn't in the replay. */
  async function replay(target: Target, delivery: Delivery): Promise<Follower | undefined> {
    const existing = following.get(delivery.id);
    if (existing) return existing;
    const cursor = delivery.status.cursor !== undefined ? Number(delivery.status.cursor) : undefined;
    if (cursor === undefined || !Number.isFinite(cursor)) return undefined;
    const tracker = new TurnTracker(messageIdFor(delivery.id));
    tracker.start(null, cursor);
    const f = await follow(target.locator, tracker, cursor);
    // Done when our turn has ended, or the replay has gone quiet.
    await f.wait(() => (tracker.ended || f.synced || Date.now() - f.lastItemAt > replayQuietMs ? true : undefined), 30_000);
    if (!tracker.seenOurs) {
      f.stop();
      return undefined;
    }
    following.set(delivery.id, f);
    return f;
  }

  function outcomeOf(thread: T3Thread, tracker: { turnId: string; joined: boolean; foreign: number; stopped?: boolean }): Outcome {
    if (tracker.joined || tracker.foreign > 0) {
      const entered: EnteredInput[] = [];
      if (tracker.joined) entered.push({ origin: "t3-turn-already-running" });
      for (let i = 0; i < tracker.foreign; i++) entered.push({ origin: "t3-user-message" });
      return { _tag: "ambiguous", entered };
    }
    const latest = thread.latestTurn?.turnId === tracker.turnId ? thread.latestTurn : null;
    const state = latest?.state ?? "completed";
    if (state === "interrupted") return { _tag: "failed", reason: "aborted", detail: "the turn was interrupted" };
    if (state === "error") return { _tag: "failed", reason: "error", detail: thread.session?.lastError ?? "the turn ended in an error" };
    // v0.0.44 reports an interrupted Claude turn as completed with no answer (Hazel's notes §6).
    // Codex keeps the partial text as its answer; that can't be told from a real one.
    if (latest && latest.assistantMessageId === null) {
      return { _tag: "failed", reason: "aborted", detail: "the turn ended without an answer (interrupted)" };
    }
    // Interrupted after part of the answer streamed: recorded as completed with that
    // part as its answer, then the session stops (live on 3780, native Claude).
    if (tracker.stopped) return { _tag: "failed", reason: "aborted", detail: "the turn was interrupted; its partial answer wasn't collected" };
    const named = latest ? thread.messages.find((m) => m.id === latest.assistantMessageId && m.text?.trim()) : undefined;
    const final =
      named ??
      thread.messages.filter((m) => m.role === "assistant" && m.turnId === tracker.turnId && !m.streaming && m.text?.trim()).at(-1);
    if (!final) return { _tag: "failed", reason: "error", detail: "the turn produced no answer" };
    return { _tag: "replied", answer: final.text! };
  }

  /** Waits (by polling snapshots) for the thread to go idle. Used for the courtesy wait and notices. */
  async function waitIdle(threadId: string): Promise<T3Thread | null> {
    for (;;) {
      const t = await client.getThread(threadId, 3);
      if (!t || !isBusy(t)) return t;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

async function check(target: Target, delivery: Delivery): Promise<Check> {
    const messageId = messageIdFor(delivery.id);
    let thread: T3Thread | null;
    try {
      thread = await client.getThread(target.locator);
    } catch (error) {
      return { _tag: "later", detail: error instanceof Error ? error.message : String(error) };
    }
    if (!thread) return { _tag: "unknown", detail: `T3 thread ${target.locator} not found` };
    if (!thread.messages.some((m) => m.id === messageId)) return { _tag: "absent" };
    if (thread.turnStartFailures.includes(messageId)) return { _tag: "unknown", detail: "T3 couldn't start its turn" };

    const f = await replay(target, delivery).catch(() => undefined);
    if (f) {
      const t = f.tracker;
      if (!t.turnId) return { _tag: "later", detail: "our message isn't in a turn yet" };
      if (!t.ended) return { _tag: "running", turnId: t.turnId };
      f.stop();
      following.delete(delivery.id);
      return { _tag: "completed", turnId: t.turnId, outcome: outcomeOf(thread, { turnId: t.turnId, joined: t.joined, foreign: t.foreign }) };
    }

    // No events to replay: only what the snapshot proves.
    const link = linkFromSnapshot(thread, messageId);
    if (!link) return { _tag: "unknown", detail: "can't tell which turn it went into (its events are gone)" };
    if (isBusy(thread) && thread.session?.activeTurnId === link.turnId) return { _tag: "later", detail: "its turn is still running" };
    // Foreign messages can't be ordered from a snapshot; a joined turn is ambiguous regardless.
    return { _tag: "completed", turnId: link.turnId, outcome: outcomeOf(thread, { turnId: link.turnId, joined: link.joined, foreign: 0 }) };
  }

  return {
    ready: () => client.connected(),

    async handOff(target, delivery) {
      const threadId = target.locator;
      const messageId = messageIdFor(delivery.id);
      try {
        const before = await client.getThread(threadId, 3);
        if (!before) return { _tag: "rejected", detail: `T3 thread ${threadId} not found` };
        if (before.messages.some((m) => m.id === messageId)) {
          // Already there (an earlier handoff): find its turn the recovery way.
          const c = await check(target, delivery);
          if (c._tag === "running" || c._tag === "completed") return { _tag: "accepted", turnId: c.turnId };
          return { _tag: "lost", detail: `message ${messageId} is in the thread but its turn is unclear (${c._tag})` };
        }
        const tracker = new TurnTracker(messageId);
        const f = await follow(threadId, tracker);
        // Courtesy wait until idle, from the live session state.
        await f.wait(() => (f.snapshot && !tracker.sessionBusy ? true : undefined));
        const cursor = String(tracker.lastSequence);
        try {
          await client.startTurn(threadId, {
            messageId,
            text: renderDelivery(delivery, { harnessLabelsSource: false }),
            runtimeMode: f.snapshot?.runtimeMode ?? before.runtimeMode,
            interactionMode: f.snapshot?.interactionMode ?? before.interactionMode,
          });
        } catch (error) {
          f.stop();
          if (error instanceof T3Rejected) return { _tag: "rejected", detail: error.message };
          throw error;
        }
        const r = await f.wait(() => (tracker.startFailed ? "failed" : tracker.turnId ? "turn" : undefined), acceptTimeoutMs);
        if (r === "failed") {
          f.stop();
          return { _tag: "rejected", detail: "T3 couldn't start the turn (provider.turn.start.failed)" };
        }
        if (r === undefined) {
          f.stop();
          return { _tag: "lost", detail: `message ${messageId} wasn't in a turn after ${acceptTimeoutMs} ms` };
        }
        following.set(delivery.id, f);
        return { _tag: "accepted", turnId: tracker.turnId!, cursor };
      } catch (error) {
        return { _tag: "lost", detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async awaitOutcome(target, delivery, turnId) {
      try {
        const f = following.get(delivery.id) ?? (await replay(target, delivery));
        if (!f) return { _tag: "lost", detail: "can't follow the turn's events; the restart check decides" };
        await f.wait(() => (f.tracker.ended ? true : undefined));
        // Watch a little longer for the session stopping: the sign of an interrupt.
        await f.wait(() => (f.tracker.stoppedAfterEnd || Date.now() - (f.tracker.endedAt ?? 0) > interruptWindowMs ? true : undefined));
        f.stop();
        following.delete(delivery.id);
        const thread = await client.getThread(target.locator, 5);
        if (!thread) return { _tag: "lost", detail: `T3 thread ${target.locator} is gone` };
        const t = f.tracker;
        return outcomeOf(thread, { turnId: t.turnId ?? turnId, joined: t.joined, foreign: t.foreign, stopped: t.stoppedAfterEnd });
      } catch (error) {
        return { _tag: "lost", detail: error instanceof Error ? error.message : String(error) };
      }
    },

    check,

    async notifyUnmatched(target, delivery) {
      const noticeId = noticeIdFor(delivery.id);
      const thread = await waitIdle(target.locator);
      if (!thread || thread.messages.some((m) => m.id === noticeId)) return;
      await client.startTurn(target.locator, {
        messageId: noticeId,
        text: renderUnmatchedNotice(delivery, { harnessLabelsSource: false }),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      });
    },
  };
}
