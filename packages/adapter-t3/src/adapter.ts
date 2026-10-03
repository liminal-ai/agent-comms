// The T3 adapter: delivers a rendered delivery into a T3 thread as a user
// message, follows the server's events to find the turn it went into and
// whether anything else entered it, and collects that turn's answer.
//
// - Our message id is `comms-<delivery id>`, so it can always be found again.
// - We wait for the thread to be idle before starting a turn, as a courtesy
//   only: ownership comes from the event order, not from the wait.
// - Ambiguous: our message joined a turn already running, a foreign message
//   was waiting for the same turn (1.1), the turn wasn't started by our message
//   (1.2), or another user message entered before our turn ended. Only the
//   fact is reported, never that message's text.
// - After a restart: replay the thread's events from the cursor saved with
//   `delivered`. If the replay doesn't cover our turn from before our message
//   to its end, we can't tell: `unknown` (uncertain), never collected (1.3).
// - Our turn's end state is our turn's own (1.4); if it can't be read, uncertain.
// - Reads nothing else from the thread.

import { type Delivery, type EnteredInput, renderDelivery, renderUnmatchedNotice } from "@agent-comms/protocol";
import {
  decodeCursor,
  encodeCursor,
  isBusy,
  startedBy,
  T3Rejected,
  type T3Client,
  type T3StreamItem,
  type T3Thread,
  TurnTracker,
} from "./model.ts";

export interface Target {
  participant: string;
  /** The T3 thread id. */
  locator: string;
}

export type HandOff =
  | { _tag: "accepted"; turnId: string; cursor?: string }
  | { _tag: "rejected"; detail: string }
  /** Never sent: the gate said no or the handoff was cancelled before sending. */
  | { _tag: "aborted"; detail: string }
  | { _tag: "lost"; detail: string };

/** The last check before sending (2.2): `confirm` re-checks the claim and records the cursor; `signal` cancels a waiting handoff. */
export interface Gate {
  confirm(cursor?: string): Promise<boolean>;
  signal: AbortSignal;
}
export type Outcome =
  | { _tag: "replied"; answer: string }
  | { _tag: "ambiguous"; entered: EnteredInput[] }
  | { _tag: "failed"; reason: "aborted" | "refusal" | "error"; detail?: string }
  /** We can't prove what happened in our turn: never collected, never re-run. */
  | { _tag: "uncertain"; detail: string };
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
  /** If the thread's event stream stays down this long, stop waiting on it: the restart check decides (3.2). */
  streamDownLimitMs?: number;
}

export interface T3Adapter {
  ready(target: Target): Promise<boolean>;
  handOff(target: Target, delivery: Delivery, gate?: Gate): Promise<HandOff>;
  awaitOutcome(target: Target, delivery: Delivery, turnId: string): Promise<Outcome | { _tag: "lost"; detail: string }>;
  check(target: Target, delivery: Delivery, turnId: string | undefined): Promise<Check>;
  notifyUnmatched(target: Target, delivery: Delivery): Promise<void>;
  /** Busy while the thread's session runs a turn; offline if T3 or the thread can't be reached. */
  presence(target: Target): Promise<"idle" | "busy" | "offline">;
}

export const messageIdFor = (deliveryId: string) => `comms-${deliveryId}`;
export const noticeIdFor = (deliveryId: string) => `comms-notice-${deliveryId}`;

/** A live subscription feeding a tracker, with a way to wait on it. */
interface Follower {
  tracker: TurnTracker;
  snapshot: T3Thread | undefined;
  synced: boolean;
  lastItemAt: number;
  /** When the stream went down and hasn't come back (undefined while it's up). */
  downSince: number | undefined;
  wait<T>(test: () => T | undefined, timeoutMs?: number): Promise<T | undefined>;
  stop(): void;
}

export function makeT3Adapter(options: T3AdapterOptions): T3Adapter {
  const { client } = options;
  const log = options.log ?? (() => {});
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 60_000;
  const replayQuietMs = options.replayQuietMs ?? 1_500;
  const interruptWindowMs = options.interruptWindowMs ?? 4_000;
  const streamDownLimitMs = options.streamDownLimitMs ?? 5 * 60_000;
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
      downSince: undefined,
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
    /** Whether the current subscription asked for a replay after a sequence (then a snapshot means events were missed). */
    let resumedAfter = afterSequence !== undefined;
    // The outage clock (`downSince`) and the backoff reset only when a stream has proven itself
    // with a snapshot or `synchronized` (docs/09 P2): a subscribe call can resolve and the stream
    // still close at once, and that must not look like recovery.
    let failures = 0;
    const retryLater = () => {
      if (stopped) return;
      setTimeout(resubscribe, Math.min(30_000, 250 * 2 ** Math.min(failures, 7)));
      failures++;
    };
    const resubscribe = () => {
      if (stopped) return;
      // Resume from the last event we saw, without a gap; retry with backoff while T3 is away (3.2).
      resumedAfter = true;
      client
        .subscribe(threadId, { afterSequence: tracker.lastSequence }, onItem)
        .then((u) => {
          if (stopped) return u();
          unsubscribe = u;
        })
        .catch((e) => {
          log(`resubscribing to ${threadId} (attempt ${failures}): ${e instanceof Error ? e.message : String(e)}`);
          retryLater();
        });
    };
    const synced = () => {
      f.downSince = undefined;
      failures = 0;
    };
    const onItem = (item: T3StreamItem | { kind: "closed" }) => {
      f.lastItemAt = Date.now();
      if (item.kind === "snapshot") {
        f.snapshot = item.thread;
        if (resumedAfter && tracker.seenOurs && !tracker.ended) tracker.gap = true; // events after our message were missed
        if (!tracker.seenOurs) tracker.start(item.thread.session, item.thread.snapshotSequence);
        if (afterSequence !== undefined) f.synced = true; // the events were gone; the snapshot is all there is
        synced();
      } else if (item.kind === "event") {
        tracker.feed(item.event);
      } else if (item.kind === "synchronized") {
        f.synced = true;
        synced();
      } else if (item.kind === "closed" && !stopped) {
        f.downSince ??= Date.now();
        retryLater();
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
    const cursor = decodeCursor(delivery.status.cursor);
    if (!cursor) return undefined;
    const tracker = new TurnTracker(messageIdFor(delivery.id));
    tracker.start(null, cursor.sequence);
    const f = await follow(target.locator, tracker, cursor.sequence);
    // Done when our turn has ended, or the replay has gone quiet.
    await f.wait(() => (tracker.ended || f.synced || Date.now() - f.lastItemAt > replayQuietMs ? true : undefined), 30_000);
    if (!tracker.seenOurs) {
      f.stop();
      return undefined;
    }
    if (tracker.turnId !== undefined && cursor.confirmedTurnId === tracker.turnId && tracker.sawStarting) tracker.startedByUs = true;
    following.set(delivery.id, f);
    return f;
  }

  /**
   * The outcome of a turn that has ended, from what the tracker saw and the
   * thread's records. Confirms `startedByUs` from the snapshot if still unknown.
   */
  function outcomeOf(thread: T3Thread, t: TurnTracker): Outcome {
    const turnId = t.turnId!;
    if (t.gap) return { _tag: "uncertain", detail: "some of its turn's events were missed while T3's stream was down" };
    if (t.startedByUs === undefined) t.startedByUs = startedBy(thread, t.messageId, turnId) ?? false;
    if (t.ambiguous) return { _tag: "ambiguous", entered: t.entered() };
    const latest = thread.latestTurn?.turnId === turnId ? thread.latestTurn : null;
    // Our turn's own end state: the latest turn's record if it's ours, else what ended it (1.4).
    const state = latest
      ? latest.state
      : t.endStatus === "interrupted"
        ? "interrupted"
        : t.endStatus === "error"
          ? "error"
          : t.endStatus === "ready" || t.endStatus === "stopped"
            ? "completed"
            : undefined;
    if (state === undefined) return { _tag: "uncertain", detail: "can't read how its turn ended (another turn took over)" };
    if (state === "interrupted") return { _tag: "failed", reason: "aborted", detail: "the turn was interrupted" };
    if (state === "error") {
      return { _tag: "failed", reason: "error", detail: (latest ? thread.session?.lastError : t.endError) ?? "the turn ended in an error" };
    }
    // v0.0.44 reports an interrupted Claude turn as completed with no answer (Hazel's notes §6).
    // Codex keeps the partial text as its answer; that can't be told from a real one.
    if (latest && latest.assistantMessageId === null) {
      return { _tag: "failed", reason: "aborted", detail: "the turn ended without an answer (interrupted)" };
    }
    // Interrupted after part of the answer streamed: recorded as completed with that
    // part as its answer, then the session stops (live on 3780, native Claude).
    if (t.stoppedAfterEnd) return { _tag: "failed", reason: "aborted", detail: "the turn was interrupted; its partial answer wasn't collected" };
    const answerId = latest?.assistantMessageId ?? t.answerId;
    if (!answerId) return { _tag: "failed", reason: "error", detail: "the turn produced no answer" };
    const answer = thread.messages.find((m) => m.id === answerId && m.role === "assistant");
    if (!answer) return { _tag: "uncertain", detail: "its answer isn't in the thread" };
    if (!answer.text?.trim()) return { _tag: "failed", reason: "error", detail: "the turn produced no answer" };
    return { _tag: "replied", answer: answer.text };
  }

  /** After our turn ended: watch briefly for the interrupt signal, then read the outcome. */
  async function settle(target: Target, f: Follower): Promise<Outcome> {
    await f.wait(() => (f.tracker.stoppedAfterEnd || Date.now() - (f.tracker.endedAt ?? 0) > interruptWindowMs ? true : undefined));
    let thread = await client.getThread(target.locator, 5);
    if (!thread) return { _tag: "uncertain", detail: `T3 thread ${target.locator} is gone` };
    const t = f.tracker;
    const latest = thread.latestTurn;
    const wanted = latest && latest.turnId === t.turnId ? latest.assistantMessageId : t.answerId;
    if (wanted && !thread.messages.some((m) => m.id === wanted)) thread = (await client.getThread(target.locator)) ?? thread;
    return outcomeOf(thread, t);
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

    // Only a replay that covers our turn from before our message to its end can vouch for it (1.3).
    const f = await replay(target, delivery).catch(() => undefined);
    if (!f) return { _tag: "unknown", detail: "can't replay its turn's events; nothing is collected" };
    const t = f.tracker;
    if (!t.turnId) return { _tag: "later", detail: "our message isn't in a turn yet" };
    if (!t.ended) return { _tag: "running", turnId: t.turnId };
    const outcome = await settle(target, f);
    f.stop();
    following.delete(delivery.id);
    if (outcome._tag === "uncertain") return { _tag: "unknown", detail: outcome.detail };
    return { _tag: "completed", turnId: t.turnId, outcome };
  }

  return {
    ready: () => client.connected(),

    async handOff(target, delivery, gate) {
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
        if (gate?.signal.aborted) return { _tag: "aborted", detail: "cancelled before sending" };
        const tracker = new TurnTracker(messageId);
        const f = await follow(threadId, tracker);
        // Courtesy wait until idle, from the live session state; a cancelled handoff stops waiting.
        await f.wait(() =>
          gate?.signal.aborted ||
          (f.snapshot && !tracker.sessionBusy) ||
          (f.downSince !== undefined && Date.now() - f.downSince > streamDownLimitMs)
            ? true
            : undefined,
        );
        if (f.downSince !== undefined) {
          f.stop();
          return { _tag: "aborted", detail: "T3's event stream is down; not sending" };
        }
        const cursor = String(tracker.lastSequence);
        // The last check before sending: the claim is still ours, and the cursor is recorded (2.2).
        if (gate && (gate.signal.aborted || !(await gate.confirm(encodeCursor(Number(cursor)))) || gate.signal.aborted)) {
          f.stop();
          return { _tag: "aborted", detail: "claim not held, or cancelled, before sending" };
        }
        log(`t3 dispatch ${messageId} to ${threadId}`);
        try {
          await client.startTurn(threadId, {
            messageId,
            text: renderDelivery(delivery, { harnessLabelsSource: false }),
            runtimeMode: f.snapshot?.runtimeMode ?? before.runtimeMode,
            interactionMode: f.snapshot?.interactionMode ?? before.interactionMode,
          });
        } catch (error) {
          // A definite refusal (HTTP 4xx) never ran. Anything else (5xx, socket, timeout) may have been
          // accepted: lost, so recovery looks for our message in the thread (2.3).
          f.stop();
          if (error instanceof T3Rejected) return { _tag: "rejected", detail: error.message };
          return { _tag: "lost", detail: `turn start may or may not have reached T3: ${error instanceof Error ? error.message : String(error)}` };
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
        // Confirm our message started this turn (1.2), while it's still the latest.
        const now = await client.getThread(threadId, 3).catch(() => null);
        // Ours only if T3 recorded our message as its start AND it began the way a command-started turn does (1.2).
        tracker.startedByUs = tracker.joined || !tracker.sawStarting ? false : (now ? startedBy(now, messageId, tracker.turnId!) : undefined) ?? false;
        // An answer's delivery is never followed: stop its subscription now (3.3).
        if (delivery.message.kind === "request") following.set(delivery.id, f);
        else f.stop();
        return { _tag: "accepted", turnId: tracker.turnId!, cursor: encodeCursor(Number(cursor), tracker.startedByUs ? tracker.turnId : undefined) };
      } catch (error) {
        return { _tag: "lost", detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async awaitOutcome(target, delivery, turnId) {
      try {
        const f = following.get(delivery.id) ?? (await replay(target, delivery));
        if (!f) return { _tag: "lost", detail: "can't follow the turn's events; the restart check decides" };
        const ended = await f.wait(() =>
          f.tracker.ended ? "ended" : f.downSince !== undefined && Date.now() - f.downSince > streamDownLimitMs ? "down" : undefined,
        );
        if (ended === "down") {
          f.stop();
          following.delete(delivery.id);
          return { _tag: "lost", detail: "T3's event stream has been down too long; the restart check decides" };
        }
        f.tracker.turnId ??= turnId;
        const outcome = await settle(target, f);
        f.stop();
        following.delete(delivery.id);
        return outcome;
      } catch (error) {
        return { _tag: "lost", detail: error instanceof Error ? error.message : String(error) };
      }
    },

    check,

    async presence(target) {
      try {
        const thread = await client.getThread(target.locator, 1);
        return !thread ? "offline" : isBusy(thread) ? "busy" : "idle";
      } catch {
        return "offline";
      }
    },

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
