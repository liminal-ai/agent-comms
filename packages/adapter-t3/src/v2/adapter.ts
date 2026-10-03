// The T3 adapter for orchestration protocol 2 (v0.0.46): delivers a rendered delivery
// into a T3 thread with `message.dispatch`, finds the run our message started, and
// collects that run's answer. Same contract as the v0.0.44 adapter (../adapter.ts).
//
// - Our message id is `comms-<delivery id>` and our command id `comms-cmd-<delivery id>`.
//   T3 never runs a command id twice: a retry after a lost response returns the first
//   result; a command T3 refused fails "previously rejected" for good. So a dispatch
//   error is retried once with the same id, unless the thread already has our message:
//   refused is rejected, anything else is lost and the restart check decides.
// - We dispatch with `start_immediately` after waiting for the thread to be idle, as a
//   courtesy only and for at most `idleWaitMs`: on a busy thread T3 queues our message as
//   its own run.
// - Our run is the run whose `userMessageId` is our message. Ambiguous: another user
//   message in our run (someone steered into it), or a steer restarted it. Only the
//   fact is reported, never that message's text.
// - The stream says when to look; what happened is read from a snapshot, which records
//   every run's status and which run every message is in. So the restart check works
//   from one snapshot, with no replay (T3 replays at most 128 events).
// - The turn is over at `waiting` (checkpoint pending); we read the outcome at
//   `completed`, or after `waitingSettleMs` (30 s) of `waiting`: a heuristic bound for a
//   checkpoint that's slow or never lands. Why and what it risks: docs/t3-v2-notes.md,
//   "the waiting settle".

import { type Delivery, renderDelivery, renderUnmatchedNotice } from "@agent-comms/protocol";
import { type Check, type Gate, type HandOff, messageIdFor, noticeIdFor, type Outcome, type T3Adapter, type Target } from "../adapter.ts";
import { answerOf, encodeCursor, find, isBusy, RunTracker, TURN_OVER, V2Rejected, type V2Client, type V2StreamItem, type V2Thread } from "./model.ts";

export const commandIdFor = (deliveryId: string) => `comms-cmd-${deliveryId}`;
const noticeCommandIdFor = (deliveryId: string) => `comms-notice-cmd-${deliveryId}`;

export interface T3AdapterV2Options {
  client: V2Client;
  log?: (line: string) => void;
  /** How long to wait for our run to appear after dispatching. */
  acceptTimeoutMs?: number;
  /** The longest courtesy wait for an idle thread before sending anyway (T3 queues our message as its own run). */
  idleWaitMs?: number;
  /** How long a run may sit in `waiting` before its outcome is read anyway. */
  waitingSettleMs?: number;
  /** If the thread's event stream stays down this long, stop waiting on it: the restart check decides. */
  streamDownLimitMs?: number;
  /** Between the two tries of a dispatch, and between idle polls for a notice. */
  retryDelayMs?: number;
  idlePollMs?: number;
}

/** A live subscription feeding a tracker, with a way to wait on it. */
interface Follower {
  tracker: RunTracker;
  /** A snapshot has been loaded (the tracker knows every run). */
  loaded: boolean;
  /** When the stream went down and hasn't come back (undefined while it's up). */
  downSince: number | undefined;
  wait<T>(test: () => T | undefined, timeoutMs?: number): Promise<T | undefined>;
  stop(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function makeT3AdapterV2(options: T3AdapterV2Options): T3Adapter {
  const { client } = options;
  const log = options.log ?? (() => {});
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 60_000;
  const waitingSettleMs = options.waitingSettleMs ?? 30_000;
  const idleWaitMs = options.idleWaitMs ?? 90_000;
  const streamDownLimitMs = options.streamDownLimitMs ?? 5 * 60_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const idlePollMs = options.idlePollMs ?? 1_000;
  /** Deliveries we're following in this process, by delivery id. */
  const following = new Map<string, Follower>();

  async function follow(threadId: string, tracker: RunTracker): Promise<Follower> {
    const waiters = new Set<() => void>();
    let unsubscribe: (() => void) | undefined;
    let stopped = false;
    const f: Follower = {
      tracker,
      loaded: false,
      downSince: undefined,
      wait: (test, timeoutMs) =>
        new Promise((resolve) => {
          const check = () => {
            const value = test();
            if (value !== undefined) done(value);
          };
          const tick = setInterval(check, 100); // some tests depend on time, not just items
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
      // Resume from the last event we saw; if T3 can't replay that far it sends a snapshot, which is as good.
      client
        .subscribe(threadId, { afterSequence: tracker.lastSequence }, onItem)
        .then((u) => {
          if (stopped) return u();
          unsubscribe = u;
        })
        .catch((e) => {
          log(`resubscribing to ${threadId} (attempt ${failures}): ${message(e)}`);
          retryLater();
        });
    };
    const synced = () => {
      f.downSince = undefined;
      failures = 0;
    };
    const onItem = (item: V2StreamItem | { kind: "closed" }) => {
      if (item.kind === "snapshot") {
        tracker.load(item.thread);
        f.loaded = true;
        synced();
      } else if (item.kind === "synchronized") {
        synced();
      } else if (item.kind === "event") {
        tracker.feed(item.event);
      } else if (item.kind === "closed" && !stopped) {
        f.downSince ??= Date.now();
        retryLater();
      }
      for (const w of [...waiters]) w();
    };
    unsubscribe = await client.subscribe(threadId, {}, onItem);
    return f;
  }

  const downTooLong = (f: Follower) => f.downSince !== undefined && Date.now() - f.downSince > streamDownLimitMs;

  /**
   * Dispatches, retrying once with the same command id: T3 runs it at most once. A refusal
   * is certain only when T3 says the command was rejected; anything else may have gone in.
   */
  async function send(
    threadId: string,
    m: { commandId: string; messageId: string; text: string },
    /** Re-checks the claim before a fresh dispatch (docs/09 P1); the first is checked by the caller. */
    stillOurs: () => Promise<boolean> = async () => true,
  ): Promise<{ _tag: "sent" } | HandOff> {
    log(`t3 dispatch ${m.messageId} to ${threadId}`);
    let first: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        // Before the retry, the thread itself: if our message is there it went in, whatever
        // T3's command receipts remember (they might not survive a T3 restart). If the
        // thread can't be read, don't retry blind: lost, and the restart check decides.
        const now = await client.getThread(threadId).catch(() => undefined);
        if (now && find(now, m.messageId).present) return { _tag: "sent" };
        if (!now) break;
        // A fresh dispatch: only while the claim is still ours. The first attempt may still
        // have reached T3, so a lost claim here is `lost` (the restart check decides), not aborted.
        if (!(await stillOurs())) {
          return { _tag: "lost", detail: `claim lost before the retry; the first attempt may have reached T3: ${message(first)}` };
        }
      }
      try {
        await client.dispatch(threadId, m);
        return { _tag: "sent" };
      } catch (error) {
        if (error instanceof V2Rejected) return { _tag: "rejected", detail: error.message };
        first ??= error;
        log(`t3 dispatch ${m.messageId}: ${message(error)}${attempt === 0 ? "; retrying with the same command id" : ""}`);
      }
    }
    return { _tag: "lost", detail: `the dispatch may or may not have reached T3: ${message(first)}` };
  }

  /** What happened in our run, from a snapshot; undefined while the run isn't over. */
  function outcomeOf(thread: V2Thread, messageId: string, settled: boolean): Outcome | undefined {
    const { run, steeredInto, entered } = find(thread, messageId);
    if (!run) return { _tag: "uncertain", detail: steeredInto ? "our message is in a run it didn't start" : "our run isn't in the thread" };
    if (run.status === "rolled_back") return { _tag: "uncertain", detail: "the run was rolled back; its outcome no longer stands" };
    if (!TURN_OVER.includes(run.status) || (run.status === "waiting" && !settled)) return undefined;
    if (entered.length > 0) return { _tag: "ambiguous", entered };
    if (run.status === "interrupted" || run.status === "cancelled") return { _tag: "failed", reason: "aborted", detail: `the run was ${run.status}` };
    if (run.status === "failed") {
      return { _tag: "failed", reason: "error", detail: thread.errors.filter((e) => e.runId === run.id).at(-1)?.message ?? "the run failed" };
    }
    const answer = answerOf(thread, run.id);
    if (!answer?.text.trim()) return { _tag: "failed", reason: "error", detail: "the run produced no answer" };
    return { _tag: "replied", answer: answer.text };
  }

  async function check(target: Target, delivery: Delivery): Promise<Check> {
    const messageId = messageIdFor(delivery.id);
    let thread: V2Thread | null;
    try {
      thread = await client.getThread(target.locator);
    } catch (error) {
      return { _tag: "later", detail: message(error) };
    }
    if (!thread) return { _tag: "unknown", detail: `T3 thread ${target.locator} not found` };
    const { present, run, steeredInto } = find(thread, messageId);
    if (!present) return { _tag: "absent" };
    if (!run) return steeredInto ? { _tag: "unknown", detail: "our message is in a run it didn't start" } : { _tag: "later", detail: "our message isn't in a run yet" };
    const outcome = outcomeOf(thread, messageId, run.status !== "waiting");
    if (!outcome) return { _tag: "running", turnId: run.id };
    if (outcome._tag === "uncertain") return { _tag: "unknown", detail: outcome.detail };
    return { _tag: "completed", turnId: run.id, outcome };
  }

  /** Waits (by polling snapshots) for the thread to go idle. Used for notices. */
  async function waitIdle(threadId: string): Promise<V2Thread | null> {
    for (;;) {
      const t = await client.getThread(threadId);
      if (!t || !isBusy(t)) return t;
      await new Promise((r) => setTimeout(r, idlePollMs));
    }
  }

  return {
    ready: () => client.connected(),

    async handOff(target, delivery, gate?: Gate) {
      const threadId = target.locator;
      const messageId = messageIdFor(delivery.id);
      try {
        const before = await client.getThread(threadId);
        if (!before) return { _tag: "rejected", detail: `T3 thread ${threadId} not found` };
        if (find(before, messageId).present) {
          // Already there (an earlier handoff, maybe another process's): find its run, send nothing.
          const c = await check(target, delivery);
          if (c._tag === "running" || c._tag === "completed") return { _tag: "accepted", turnId: c.turnId };
          return { _tag: "lost", detail: `message ${messageId} is in the thread but its run is unclear (${c._tag})` };
        }
        if (gate?.signal.aborted) return { _tag: "aborted", detail: "cancelled before sending" };
        const tracker = new RunTracker(messageId);
        const f = await follow(threadId, tracker);
        // Courtesy wait until idle, at most `idleWaitMs` (docs/09 3): on a thread that stays busy
        // T3 queues our message as its own run, so waiting longer only churns the claim. A
        // cancelled handoff stops waiting.
        await f.wait(() => (gate?.signal.aborted || (f.loaded && !tracker.busy) || downTooLong(f) ? true : undefined), idleWaitMs);
        if (!f.loaded) {
          f.stop();
          return { _tag: "aborted", detail: "T3's thread stream gave no snapshot; not sending" };
        }
        if (downTooLong(f)) {
          f.stop();
          return { _tag: "aborted", detail: "T3's event stream is down; not sending" };
        }
        const cursor = encodeCursor(tracker.lastSequence);
        // The last check before sending: the claim is still ours, and the cursor is recorded (2.2).
        if (gate && (gate.signal.aborted || !(await gate.confirm(cursor)) || gate.signal.aborted)) {
          f.stop();
          return { _tag: "aborted", detail: "claim not held, or cancelled, before sending" };
        }
        const sent = await send(
          threadId,
          { commandId: commandIdFor(delivery.id), messageId, text: renderDelivery(delivery, { harnessLabelsSource: false }) },
          async () => !gate || (!gate.signal.aborted && (await gate.confirm(cursor)) && !gate.signal.aborted),
        );
        if (sent._tag !== "sent") {
          f.stop();
          return sent;
        }
        if (!(await f.wait(() => tracker.runId, acceptTimeoutMs))) {
          // The stream may be behind: T3 committed our message and its run together.
          const now = await client.getThread(threadId).catch(() => null);
          if (now && find(now, messageId).run) tracker.load(now);
          else {
            f.stop();
            return { _tag: "lost", detail: `no run for message ${messageId} after ${acceptTimeoutMs} ms` };
          }
        }
        // An answer's delivery is never followed: stop its subscription now (3.3).
        if (delivery.message.kind === "request") following.set(delivery.id, f);
        else f.stop();
        return { _tag: "accepted", turnId: tracker.runId!, cursor };
      } catch (error) {
        return { _tag: "lost", detail: message(error) };
      }
    },

    async awaitOutcome(target, delivery) {
      try {
        const f = following.get(delivery.id) ?? (await follow(target.locator, new RunTracker(messageIdFor(delivery.id))));
        following.set(delivery.id, f);
        const t = f.tracker;
        const r = await f.wait(() =>
          t.final || (t.status === "waiting" && Date.now() - (t.waitingSince ?? 0) > waitingSettleMs)
            ? "ended"
            : f.loaded && !t.runId
              ? "missing"
              : downTooLong(f)
                ? "down"
                : undefined,
        );
        f.stop();
        following.delete(delivery.id);
        if (r === "down") return { _tag: "lost", detail: "T3's event stream has been down too long; the restart check decides" };
        const thread = await client.getThread(target.locator);
        if (!thread) return { _tag: "uncertain", detail: `T3 thread ${target.locator} is gone` };
        return outcomeOf(thread, messageIdFor(delivery.id), true) ?? { _tag: "lost", detail: "the stream said the run ended; the thread doesn't yet" };
      } catch (error) {
        return { _tag: "lost", detail: message(error) };
      }
    },

    check,

    async presence(target) {
      try {
        const thread = await client.getThread(target.locator);
        return !thread ? "offline" : isBusy(thread) ? "busy" : "idle";
      } catch {
        return "offline";
      }
    },

    async notifyUnmatched(target, delivery) {
      const noticeId = noticeIdFor(delivery.id);
      const sentAlready = (t: V2Thread | null) => !t || find(t, noticeId).present;
      if (sentAlready(await client.getThread(target.locator))) return;
      if (sentAlready(await waitIdle(target.locator))) return;
      const sent = await send(target.locator, {
        commandId: noticeCommandIdFor(delivery.id),
        messageId: noticeId,
        text: renderUnmatchedNotice(delivery, { harnessLabelsSource: false }),
      });
      if (sent._tag !== "sent") throw new Error(`the unmatched notice wasn't sent: ${"detail" in sent ? sent.detail : sent._tag}`);
    },
  };
}
