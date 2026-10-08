import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, parseConfig } from "../src/config.ts";
import { Coordinator, RETRY_GIVE_UP, MAX_TIMER_MS, TerminalWakeError, type Timers, type WorkDelivery } from "../src/coordinator.ts";
import { webhookWaker } from "../src/wakers.ts";

/** A clock the test advances by hand. */
class FakeTimers implements Timers {
  t = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { at: this.t + ms, fn });
    return id;
  };
  clear = (h: unknown) => void this.pending.delete(h as number);
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    this.t = end;
  }
}

const d = (id: string, recipient = "grok"): WorkDelivery => ({ id, recipient, state: "delivered", createdAt: 0 });

function setup(opts: { fail?: number; renudgeMs?: number; terminal?: number } = {}) {
  const timers = new FakeTimers();
  const wakes: string[][] = [];
  const logs: string[] = [];
  let failures = opts.fail ?? 0;
  let terminal = opts.terminal ?? 0;
  const c = new Coordinator({
    participant: "grok",
    timers,
    log: (l) => logs.push(l),
    renudgeMs: opts.renudgeMs ?? 0,
    wake: async (ids) => {
      if (failures > 0) {
        failures--;
        throw new Error("HTTP 500");
      }
      if (terminal > 0) {
        terminal--;
        throw new TerminalWakeError("HTTP 410");
      }
      wakes.push(ids);
    },
  });
  return { timers, wakes, logs, c };
}

describe("coordinator", () => {
  it("wakes once for a burst of new deliveries, only for its participant", async () => {
    const { timers, wakes, c } = setup();
    c.update([]);
    c.update([d("a"), d("x", "dot")]);
    await timers.advance(500);
    c.update([d("a"), d("b"), d("x", "dot")]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a", "b"]]);
    c.update([d("a"), d("b")]);
    await timers.advance(60_000);
    assert.equal(wakes.length, 1, "no new delivery, no new wake");
  });

  it("wakes for what's already outstanding when it starts", async () => {
    const { timers, wakes, c } = setup();
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]]);
  });

  it("retries a failed wake", async () => {
    const { timers, wakes, c } = setup({ fail: 1 });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, []);
    await timers.advance(30_000);
    assert.deepEqual(wakes, [["a"]]);
  });

  it("logs a wake that keeps failing the same way every 5 min, not every retry", async () => {
    const timers = new FakeTimers();
    const logs: string[] = [];
    const c = new Coordinator({
      participant: "dot",
      timers,
      log: (l) => logs.push(l),
      renudgeMs: 0,
      wake: async () => {
        throw new Error("no subscriber");
      },
    });
    c.update([d("a", "dot")]);
    // Retries back off: 30 s, 60 s, 120 s, 240 s, then 300 s (the cap) each time.
    await timers.advance(2_000 + 30_000 + 60_000 + 120_000);
    assert.equal(logs.filter((l) => l.includes("wake failed")).length, 1, "one report for the first 5 min");
    await timers.advance(240_000 + 300_000 + 300_000);
    const failed = logs.filter((l) => l.includes("wake failed"));
    assert.equal(failed.length, 2);
    assert.match(failed[1]!, /failed the same way \d+ more time\(s\)/);
    c.close();
  });

  it("wakes again for a delivery still outstanding after renudgeMs, and stops once it's gone", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(2_000);
    await timers.advance(10 * 60_000);
    assert.deepEqual(wakes, [["a"], ["a"]]);
    c.update([]);
    await timers.advance(30 * 60_000);
    assert.equal(wakes.length, 2);
  });
  it("wakes again when a delivery woken while pending is later handed over as delivered", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    const pending = (id: string): WorkDelivery => ({ ...d(id), state: "pending" });
    c.update([d("a"), pending("b")]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a", "b"]]);
    // The bridge is answering "a"; "b" stays pending. Nothing new to wake for.
    c.update([d("a"), pending("b")]);
    await timers.advance(60_000);
    assert.equal(wakes.length, 1);
    // "a" is answered, the connector hands "b" over: it reaches the inbox now.
    c.update([d("b")]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a", "b"], ["b"]], "the handoff to delivered is a fresh wake");
    // Staying delivered doesn't wake again before the renudge.
    c.update([d("b")]);
    await timers.advance(60_000);
    assert.equal(wakes.length, 2);
  });

  it("a transition seen before the wake goes out is covered by that wake, not by a second one", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([{ ...d("b"), state: "pending" }]);
    await timers.advance(500);
    c.update([d("b")]); // handed over during the coalesce window
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["b"]]);
    c.update([d("b")]);
    await timers.advance(60_000);
    assert.equal(wakes.length, 1, "already delivered when woken; nothing new happened");
  });

  it("a handoff to delivered that lands while a wake is in flight gets its own wake", async () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    let release: () => void = () => {};
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) await new Promise<void>((r) => (release = r));
      },
    });
    c.update([{ ...d("b"), state: "pending" }]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["b"]], "first wake is out, still in flight");
    c.update([d("b")]); // handed over while the wake is out
    release();
    await new Promise((r) => setImmediate(r));
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["b"], ["b"]], "the handoff was woken for separately, even with renudging off");
    c.update([d("b")]);
    await timers.advance(60_000);
    assert.equal(wakes.length, 2);
  });

  it("a handoff that lands while a wake is in flight still gets its own wake when that wake is refused for good", async () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    let release: (e?: Error) => void = () => {};
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) await new Promise<void>((_, reject) => (release = (e) => reject(e)));
      },
    });
    c.update([{ ...d("b"), state: "pending" }]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["b"]], "first wake is out, still in flight");
    c.update([d("b")]); // handed over while the wake is out
    release(new TerminalWakeError("HTTP 410"));
    await new Promise((r) => setImmediate(r));
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["b"], ["b"]], "the handoff was woken for even though the first wake ended terminally");
  });

  it("a new delivery during a 30 s retry wait is woken for after the 2 s coalesce, not the full retry wait", async () => {
    const { timers, wakes, c } = setup({ fail: 1 });
    c.update([d("a")]);
    await timers.advance(2_000); // first wake fails; a 30 s retry is pending
    assert.equal(wakes.length, 0);
    await timers.advance(5_000);
    c.update([d("a"), d("b")]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a", "b"]], "the retry was pulled forward to the coalesce delay");
    await timers.advance(60_000);
    assert.equal(wakes.length, 1, "and the old retry timer didn't fire a second wake");
  });

  it("a renudge that fails transiently waits the retry delay instead of hammering the webhook", async () => {
    const { timers, wakes, c, logs } = setup({ renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.equal(wakes.length, 1);
    // From now on the webhook fails for a while.
    const failing = c as unknown as { o: { wake: (ids: string[]) => Promise<void> } };
    const good = failing.o.wake;
    let calls = 0;
    failing.o.wake = async () => {
      calls++;
      throw new Error("HTTP 500");
    };
    await timers.advance(10 * 60_000); // the renudge fires and fails
    assert.equal(calls, 1);
    await timers.advance(1_000);
    assert.equal(calls, 1, "no immediate re-wake while the 30 s retry is pending");
    await timers.advance(29_000);
    assert.equal(calls, 2, "retried after retryMs");
    await timers.advance(1_000);
    assert.equal(calls, 2);
    failing.o.wake = good;
    await timers.advance(60_000); // the second retry waits 60 s (backoff)
    assert.equal(wakes.length, 2, "and the renudge gets through once the webhook recovers");
    assert.ok(logs.some((l) => /retrying in 30s/.test(l)));
  });

  it("a renudge pre-empted by a coalesced wake is reinstalled after it", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]]);
    await timers.advance(5 * 60_000);
    c.update([d("a"), d("b")]); // a fresh delivery: a coalesced wake is scheduled, the renudge timer cleared
    c.update([d("a")]); // and it's handed over and gone again before that wake fires: still owed its one wake
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"], ["b"]], "the coalesced wake carried b only; a wasn't due");
    await timers.advance(5 * 60_000);
    assert.deepEqual(wakes, [["a"], ["b"], ["a"]], "a was still renudged on time");
  });

  it("a handoff noted during an in-flight wake whose delivery then goes is owed, not forgotten, when that wake fails", async () => {
    const timers = new FakeTimers();
    let release: (e?: Error) => void = () => {};
    let calls = 0;
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      wake: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((_, reject) => (release = (e) => reject(e)));
      },
    });
    c.update([{ ...d("b"), state: "pending" }]);
    await timers.advance(2_000);
    c.update([d("b")]); // handed over while the wake is out
    c.update([]); // and gone before the wake ends
    release(new Error("HTTP 500"));
    await new Promise((r) => setImmediate(r));
    assert.equal((c as unknown as { transitioned: Set<string> }).transitioned.size, 0, "nothing stale is kept in transitioned");
    await timers.advance(60_000);
    assert.equal(calls, 2, "the retry carried it: the inbox item still needs a wake that lands");
    await timers.advance(60 * 60_000);
    assert.equal(calls, 2, "and once that landed, nothing more");
  });

  it("a handoff that lands while a renudge is in flight gets its own wake right after", async () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    let release: () => void = () => {};
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 10 * 60_000,
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 2) await new Promise<void>((r) => (release = r));
      },
    });
    c.update([{ ...d("b"), state: "pending" }]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["b"]]);
    await timers.advance(10 * 60_000); // the renudge goes out and is held in flight
    assert.equal(wakes.length, 2);
    c.update([d("b")]); // handed over while the renudge is out
    release();
    await new Promise((r) => setImmediate(r));
    await timers.advance(2_000);
    assert.equal(wakes.length, 3, "the handoff got its own wake after the coalesce delay, not a full renudge interval later");
  });

  it("tells the waker which deliveries are no longer outstanding", async () => {
    const timers = new FakeTimers();
    const forgotten: string[][] = [];
    const c = new Coordinator({ participant: "grok", timers, log: () => {}, renudgeMs: 0, wake: async () => {}, forget: (ids) => forgotten.push(ids) });
    c.update([d("a"), d("b"), d("c")]);
    await timers.advance(2_000);
    c.update([d("b")]);
    assert.deepEqual(forgotten, [["a", "c"]]);
    c.update([]);
    assert.deepEqual(forgotten, [["a", "c"], ["b"]]);
  });

  it("renudges a stuck delivery three times with widening gaps, then stops and says so once", async () => {
    const { timers, wakes, logs, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.equal(wakes.length, 1);
    await timers.advance(10 * 60_000); // +10 min
    assert.equal(wakes.length, 2, "first renudge after 10 min");
    await timers.advance(30 * 60_000); // +30 min
    assert.equal(wakes.length, 3, "second after 30 min");
    await timers.advance(120 * 60_000); // +2 h
    assert.equal(wakes.length, 4, "third after 2 h");
    await timers.advance(48 * 60 * 60_000); // two days
    assert.equal(wakes.length, 4, "no more: a stuck delivery doesn't burn turns forever");
    assert.equal(logs.filter((l) => /not waking for it again/.test(l)).length, 1, "said once");
    c.update([d("a"), d("b")]); // something new arrives: it is woken for, a is not
    await timers.advance(2_000);
    assert.deepEqual(wakes.at(-1), ["b"]);
  });

  it("doesn't renudge a claimed delivery while its lease is live", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.equal(wakes.length, 1);
    const lease = timers.now() + 30 * 60_000;
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: lease } }]); // the agent picked it up
    await timers.advance(20 * 60_000);
    assert.equal(wakes.length, 1, "no renudge while the agent holds the lease");
    await timers.advance(15 * 60_000); // the lease expired without an answer
    assert.equal(wakes.length, 2, "renudged once the lease lapsed");
  });

  it("backs off failed retries up to a cap, then gives up until something changes", async () => {
    const timers = new FakeTimers();
    const logs: string[] = [];
    let calls = 0;
    const at: number[] = [];
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: (l) => logs.push(l),
      renudgeMs: 0,
      wake: async () => {
        calls++;
        at.push(timers.now());
        throw new Error("HTTP 500");
      },
    });
    c.update([d("a")]);
    await timers.advance(24 * 60 * 60_000);
    const gaps = at.slice(1).map((t, i) => (t - at[i]!) / 1000);
    assert.deepEqual(gaps.slice(0, 5), [30, 60, 120, 240, 300], "doubling from 30 s, capped at 300 s");
    assert.equal(calls, 12, "gives up after 12 consecutive failures");
    assert.equal(logs.filter((l) => /giving up/.test(l)).length, 1);
    c.update([d("a"), d("b")]); // a new delivery: tried again
    await timers.advance(2_000);
    assert.equal(calls, 13);
  });

  it("a webhook that never answers gets a bounded number of POSTs with the default renudge, then nothing until something changes", async () => {
    const timers = new FakeTimers();
    const logs: string[] = [];
    const at: number[] = [];
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: (l) => logs.push(l),
      renudgeMs: 10 * 60_000, // the default
      wake: async () => {
        at.push(timers.now());
        throw new Error("HTTP 500");
      },
    });
    c.update([d("a")]);
    await timers.advance(7 * 86_400_000); // a week
    // Each wake (the first and the three renudges) is one retry run of RETRY_GIVE_UP POSTs; after the last renudge step, nothing.
    assert.equal(at.length, 4 * RETRY_GIVE_UP, "four runs of twelve, not a fresh run every time the first step comes due");
    const runStarts = at.filter((_, i) => i % RETRY_GIVE_UP === 0);
    const gapsMin = runStarts.slice(1).map((t, i) => Math.round((t - runStarts[i]!) / 60_000));
    // A run lasts 30+60+120+240 s, then 300 s × 7 (42.5 min); the next starts a renudge step after it gave up.
    const run = Math.round((30 + 60 + 120 + 240 + 300 * 7) / 60);
    assert.deepEqual(gapsMin, [run + 10, run + 30, run + 120], "renudge steps widen from the give-up, not from the first failure");
    assert.equal(logs.filter((l) => /giving up/.test(l)).length, 4);
    assert.equal(logs.filter((l) => /not waking for it again/.test(l)).length, 1);
    const before = at.length;
    c.update([d("a"), d("b")]); // something new: one more run, for both
    await timers.advance(2_000);
    assert.equal(at.length, before + 1);
  });

  it("a delivery first seen under a live lease is woken for when the lease lapses without a change", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    const lease = timers.now() + 2 * 60_000;
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: lease } }]); // the relay started while a connector held it
    await timers.advance(60_000);
    assert.equal(wakes.length, 0, "not while the lease is live");
    await timers.advance(60_000 + 2_001); // the claimant died: the row never changes
    assert.deepEqual(wakes, [["a"]], "woken once the lease lapsed");
  });

  it("a delivery that reaches delivered before it was ever woken for is woken for (Bugbot autofix 7e0dacf)", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    const lease = timers.now() + 30 * 60_000;
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: lease } }]);
    await timers.advance(2_000);
    assert.equal(wakes.length, 0);
    c.update([{ ...d("a"), state: "delivered" }]); // the connector handed it over
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]]);
  });

  it("a delivery handed over and gone within the coalesce window is still woken for once", async () => {
    // grok-box's connector claims an answer and puts it in the agent's inbox in well under 2 s; it then
    // has nothing left to do and leaves the work list. The agent still has to be woken to read it.
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(500);
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: timers.now() + 60_000 } }]);
    await timers.advance(500);
    c.update([]); // delivered; an answer isn't collected, so it's gone
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]], "woken for it although it had already been handed over");
    await timers.advance(24 * 60 * 60_000);
    assert.equal(wakes.length, 1, "owed one wake, not renudged");
  });

  it("a delivery that goes while its wake is in flight isn't woken for twice", async () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    let release!: () => void;
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      wake: async (ids) => {
        wakes.push(ids);
        await new Promise<void>((r) => (release = r));
      },
    });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.equal(wakes.length, 1);
    c.update([]); // gone while the POST is out
    release();
    await timers.advance(5_000);
    assert.equal(wakes.length, 1);
  });

  it("a delivery that goes while its first wake is in flight, and that wake fails, is still woken for on the retry", async () => {
    const timers = new FakeTimers();
    const calls: string[][] = [];
    let fail = 1;
    let release!: () => void;
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      wake: async (ids) => {
        calls.push(ids);
        await new Promise<void>((r) => (release = r));
        if (fail-- > 0) throw new Error("HTTP 500");
      },
    });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.equal(calls.length, 1);
    c.update([]); // collected and gone while the POST is out
    release(); // ... and that POST fails
    await new Promise((r) => setImmediate(r)); // let the rejection settle and the retry be scheduled
    await timers.advance(30_000); // the retry
    release();
    await timers.advance(1_000);
    assert.deepEqual(calls, [["a"], ["a"]], "the retry still carried it; the inbox item got a wake that landed");
  });

  it("a handoff to delivered that lands during the last failed retry gets its own wake after the give-up", async () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    const logs: string[] = [];
    let n = 0;
    // biome-ignore lint/style/useConst: assigned below
    let c: Coordinator;
    c = new Coordinator({
      participant: "grok",
      timers,
      log: (l) => logs.push(l),
      renudgeMs: 0,
      wake: async (ids) => {
        n++;
        if (n === RETRY_GIVE_UP) c.update([d("a")]); // the connector hands it over while the final retry is out
        if (n <= RETRY_GIVE_UP) throw new Error("HTTP 500");
        wakes.push(ids);
      },
    });
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(2 * 60 * 60_000);
    assert.equal(logs.filter((l) => /giving up/.test(l)).length, 1);
    assert.deepEqual(wakes, [["a"]], "the handoff got its own wake once the failed run gave up");
  });

  it("deliveries whose wakes never landed are woken for again when a subscriber connects; ones whose wake landed are not", async () => {
    // Nothing could receive the wakes: every attempt is refused for good, through all the renudge steps.
    const { timers, wakes, logs, c } = setup({ terminal: 4, renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(4 * 60 * 60_000); // first wake and all three renudges, all refused
    assert.equal(wakes.length, 0);
    assert.equal(logs.filter((l) => /not waking for it again/.test(l)).length, 1);
    c.subscriberAvailable(); // ChatGPT subscribed
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]], "woken for once more, now, and it lands");
    c.subscriberAvailable(); // a refresh 2 s after a wake that landed
    await timers.advance(2_000);
    assert.equal(wakes.length, 1, "a refresh after a good wake doesn't wake again");
    await timers.advance(10 * 60_000);
    assert.equal(wakes.length, 2, "the renudge steps started over from the wake that landed");
    for (let i = 0; i < 24; i++) {
      c.subscriberAvailable(); // hourly refreshes for a day
      await timers.advance(60 * 60_000);
    }
    assert.equal(wakes.length, 4, "a pending delivery still gets its capped 4 wakes, whatever the refresh rate");
  });

  it("a subscriber connecting re-arms a delivery given up on after failed retries", async () => {
    const { timers, wakes, c } = setup({ fail: RETRY_GIVE_UP, renudgeMs: 0 });
    c.update([d("a")]);
    await timers.advance(2 * 60 * 60_000);
    assert.equal(wakes.length, 0, "every retry failed; given up");
    c.subscriberAvailable();
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]]);
  });

  it("a pending delivery that vanishes before its wake (participant paused, or message withdrawn) isn't woken for", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(500);
    c.update([]); // never claimed or delivered: nothing reached the agent
    await timers.advance(24 * 60 * 60_000);
    assert.equal(wakes.length, 0);
  });

  it("a delivery that vanishes and returns inside the coalesce window is woken for once, with its id once (Bugbot autofix 14c4e01)", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: timers.now() + 60_000 } }]);
    await timers.advance(300);
    c.update([]);
    await timers.advance(300);
    c.update([d("a")]); // back in the list (handed over, collected)
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]]);
    await timers.advance(10 * 60_000 + 1);
    assert.equal(wakes.length, 2, "renudged once, so it was counted as one wake, not two");
  });

  it("an owed delivery whose wake was refused for good is still carried by the next wake, and by a subscriber connecting", async () => {
    const { timers, wakes, c } = setup({ terminal: 1, renudgeMs: 10 * 60_000 });
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: timers.now() + 60_000 } }]);
    c.update([]); // handed over and gone: owed one wake
    await timers.advance(2_000);
    assert.equal(wakes.length, 0, "the owed wake was refused for good");
    c.subscriberAvailable(); // a subscriber turns up
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]], "the debt survived the refusal and was paid when something could receive it");
  });

  it("an owed delivery given up on after failed retries rides along with the next wake for anything", async () => {
    const { timers, wakes, c } = setup({ fail: RETRY_GIVE_UP, renudgeMs: 0 });
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: timers.now() + 60_000 } }]);
    c.update([]);
    await timers.advance(2 * 60 * 60_000); // 12 failed POSTs, give-up
    assert.equal(wakes.length, 0);
    c.update([d("b")]); // a new delivery
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a", "b"]], "the owed one is still carried");
  });

  it("a pending delivery handed over during its failing first wake, then gone, is still woken for on the retry", async () => {
    const timers = new FakeTimers();
    const calls: string[][] = [];
    let n = 0;
    // biome-ignore lint/style/useConst: assigned below
    let c: Coordinator;
    c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      wake: async (ids) => {
        calls.push(ids);
        if (++n === 1) {
          c.update([d("a")]); // handed over while the POST is out (noted in `transitioned`)
          c.update([]); // ... and collected and gone before the POST fails
          throw new Error("HTTP 500");
        }
      },
    });
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(2_000);
    await timers.advance(30_000); // the retry
    assert.deepEqual(calls, [["a"], ["a"]], "the handoff seen during the failed wake made it owed");
  });

  it("a subscriber connecting re-arms a delivery at most once until a wake lands, so a failing callback isn't retried per refresh", async () => {
    const timers = new FakeTimers();
    const logs: string[] = [];
    let calls = 0;
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: (l) => logs.push(l),
      renudgeMs: 0,
      wake: async () => {
        calls++;
        throw new Error("HTTP 500");
      },
    });
    c.update([d("a")]);
    await timers.advance(2 * 60 * 60_000); // one full run of 12, then give-up
    assert.equal(calls, RETRY_GIVE_UP);
    for (let i = 0; i < 24; i++) {
      c.subscriberAvailable(); // hourly refreshes
      await timers.advance(60 * 60_000);
    }
    assert.equal(calls, 2 * RETRY_GIVE_UP, "exactly one more run from the first refresh; later refreshes don't restart it");
  });

  it("an owed delivery that is gone and whose wake fails doesn't linger as unreached", async () => {
    const { timers, wakes, c } = setup({ terminal: 1, renudgeMs: 0 });
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: timers.now() + 60_000 } }]);
    c.update([]); // owed
    await timers.advance(2_000); // refused for good: still owed, and unreached
    assert.equal(wakes.length, 0);
    const sets = c as unknown as { unreached: Set<string>; owed: Set<string> };
    assert.deepEqual([...sets.unreached], ["a"]);
    c.subscriberAvailable();
    await timers.advance(2_000); // this one lands
    assert.deepEqual(wakes, [["a"]]);
    assert.equal(sets.unreached.size, 0);
    assert.equal(sets.owed.size, 0);
  });

  it("gives the webhook a wake id that is stable across retries of the same set and new for a new set", async () => {
    const timers = new FakeTimers();
    const seen: { ids: string[]; wakeId: string }[] = [];
    let fail = 2;
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      wake: async (ids, info) => {
        seen.push({ ids, wakeId: info!.wakeId });
        if (fail-- > 0) throw new Error("HTTP 500");
      },
    });
    c.update([d("a"), d("b")]);
    await timers.advance(2_000 + 30_000 + 60_000);
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen.map((s) => s.wakeId)).size, 1, "one id across the retries of [a,b]");
    c.update([d("a"), d("b"), d("c")]);
    await timers.advance(2_000);
    assert.equal(seen.length, 4);
    assert.notEqual(seen[3]!.wakeId, seen[0]!.wakeId, "a different set gets a new id");
  });

  it("a terminal wake failure isn't retried every 30 s; the renudge tries again later", async () => {
    const { timers, wakes, logs, c } = setup({ terminal: 1, renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.equal(wakes.length, 0);
    assert.match(logs.at(-1)!, /wake rejected .*not retrying, renudging in 10 min/);
    await timers.advance(5 * 60_000);
    assert.equal(wakes.length, 0, "no 30 s retries");
    await timers.advance(5 * 60_000 + 1);
    assert.deepEqual(wakes, [["a"]], "renudged after 10 min");
  });

  it("never asks a timer to wait past Node's limit, and still renudges at the right time", async () => {
    const renudgeMs = 30 * 86_400_000; // 30 days: longer than a Node timer can wait
    const { timers, wakes, c } = setup({ renudgeMs });
    const asked: number[] = [];
    const origSet = timers.set;
    timers.set = (fn, ms) => {
      asked.push(ms);
      return origSet(fn, ms);
    };
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.equal(wakes.length, 1);
    assert.ok(asked.every((ms) => ms <= MAX_TIMER_MS), `a timer was asked for ${Math.max(...asked)} ms`);
    await timers.advance(MAX_TIMER_MS + 1_000);
    assert.equal(wakes.length, 1, "the capped timer firing early must not wake again");
    await timers.advance(renudgeMs);
    assert.equal(wakes.length, 2, "renudged once the real interval passed");
  });
});

describe("webhook waker", () => {
  it("POSTs to the URL from its file with the bearer key from its file, re-read each time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-"));
    const seen: { auth?: string; body: { participant: string; deliveryIds: string[] } }[] = [];
    let status = 200;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.statusCode = status;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await writeFile(join(dir, "url"), `http://127.0.0.1:${port}/hook\n`);
      await writeFile(join(dir, "key"), "k1\n");
      const wake = webhookWaker("grok", { kind: "webhook", urlFile: join(dir, "url"), bearerKeyFile: join(dir, "key") });
      await wake(["a"]);
      await writeFile(join(dir, "key"), "k2");
      await wake(["b"]);
      assert.deepEqual(seen.map((s) => s.auth), ["Bearer k1", "Bearer k2"]);
      assert.deepEqual(seen[0]!.body.deliveryIds, ["a"]);
      assert.equal(seen[0]!.body.participant, "grok");
      status = 401;
      await assert.rejects(wake(["c"]), /HTTP 401/);
    } finally {
      server.close();
    }
  });
  it("won't send over plain http off this machine, with or without a bearer key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-"));
    await writeFile(join(dir, "key"), "k");
    let hits = 0;
    const wake = webhookWaker("grok", { kind: "webhook", urlFile: join(dir, "url"), bearerKeyFile: join(dir, "key") }, async () => (hits++, new Response("{}")));
    const keyless = webhookWaker("grok", { kind: "webhook", urlFile: join(dir, "url") }, async () => (hits++, new Response("{}")));
    await writeFile(join(dir, "url"), "http://10.0.0.5/hook?token=s3cret");
    await assert.rejects(wake(["a"]), /must be https/);
    await assert.rejects(keyless(["a"]), /must be https/);
    assert.equal(hits, 0, "nothing was sent");
    await writeFile(join(dir, "url"), "https://example.com/hook");
    await wake(["a"]);
    await writeFile(join(dir, "url"), "http://127.0.0.1:9/hook");
    await wake(["a"]);
    assert.equal(hits, 2);
  });

  it("puts the wake id in the webhook body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-"));
    await writeFile(join(dir, "url"), "https://example.com/hook");
    let body = "";
    const wake = webhookWaker("grok", { kind: "webhook", urlFile: join(dir, "url") }, async (_url, init) => ((body = String(init?.body)), new Response("{}")));
    await wake(["a"], { wakeId: "wake_grok_1_x" });
    assert.equal(JSON.parse(body).wakeId, "wake_grok_1_x");
  });

  it("never buffers the webhook's response body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-"));
    await writeFile(join(dir, "url"), "https://example.com/hook");
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1 << 20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const wake = webhookWaker("grok", { kind: "webhook", urlFile: join(dir, "url") }, async () => new Response(endless, { status: 200 }));
    await wake(["a"]);
    assert.ok(cancelled, "the body was cancelled");
    assert.ok(pulls <= 2, `the body was not drained (pulled ${pulls} chunks)`);
  });

  it("refuses to follow a redirect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-"));
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      if (req.url === "/hook") {
        res.statusCode = 307;
        res.setHeader("location", "/elsewhere");
        return res.end();
      }
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await writeFile(join(dir, "url"), `http://127.0.0.1:${port}/hook`);
      await assert.rejects(webhookWaker("grok", { kind: "webhook", urlFile: join(dir, "url") })(["a"]), /webhook request failed/);
      assert.equal(hits, 1, "the redirect target was never requested");
    } finally {
      server.close();
    }
  });

  it("reports a connection failure by code only, never the URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-"));
    const url = "http://127.0.0.1:9/hook-with-secret-path";
    await writeFile(join(dir, "url"), url);
    const wake = webhookWaker("grok", { kind: "webhook", urlFile: join(dir, "url") });
    await assert.rejects(wake(["a"]), (e: Error) => {
      assert.ok(!e.message.includes("hook-with-secret-path"), `leaked the URL: ${e.message}`);
      assert.match(e.message, /webhook request failed \(/);
      return true;
    });
  });
});

describe("config", () => {
  it("validates targets and requires every secret file to exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-"));
    for (const f of ["secret", "url", "key"]) await writeFile(join(dir, f), "x");
    const target = {
      participant: "grok",
      machine: "grok-box",
      machineSecretFile: join(dir, "secret"),
      waker: { kind: "webhook", urlFile: join(dir, "url"), bearerKeyFile: join(dir, "key") },
    };
    const c = parseConfig({ convexUrl: "https://x.convex.cloud", targets: [target] });
    assert.equal(c.targets[0]!.renudgeMs, 10 * 60_000);
    assert.equal(parseConfig({ convexUrl: "https://x.convex.cloud", targets: [{ ...target, renudgeAfter: "0" }] }).targets[0]!.renudgeMs, 0);
    assert.throws(() => parseConfig({ convexUrl: "https://x.convex.cloud", targets: [{ ...target, machineSecretFile: join(dir, "nope") }] }), ConfigError);
    assert.throws(() => parseConfig({ convexUrl: "https://x.convex.cloud", targets: [{ ...target, waker: { kind: "email" } }] }), /waker.kind/);
    assert.throws(() => parseConfig({ convexUrl: "https://x.convex.cloud", targets: [target, target] }), /listed twice/);
  });
});
