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

  it("doesn't renudge a delivered request while the connector holds its lease, and does once it lapses (#26)", async () => {
    // A collectable request keeps its claim after `delivered`: the dispatcher renews the lease while it awaits the
    // answer (convex/connector.ts `delivered`, dispatcher `withLease`). grok-box claims and hands over inside the
    // coalesce window, so the one wake is built from `delivered`; the run can take 20 min, and a renudge at 10 min
    // would start a second paid run.
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    const lease = () => ({ leaseExpiresAt: timers.now() + 60_000 });
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(500);
    c.update([{ ...d("a"), state: "claimed", claim: lease() }]);
    await timers.advance(500);
    c.update([{ ...d("a"), state: "delivered", claim: lease() }]); // handed over; the claim stays while the run goes on
    await timers.advance(1_000);
    assert.deepEqual(wakes, [["a"]], "one wake, built from delivered, even though the claim is live");
    for (let i = 0; i < 50; i++) {
      await timers.advance(30_000); // the run takes 25 min; the dispatcher renews every 30 s
      c.update([{ ...d("a"), state: "delivered", claim: lease() }]);
    }
    assert.equal(wakes.length, 1, "no renudge while the lease is live: it would start a second run");
    await timers.advance(60_000 + 2_001); // the run died: renewals stop and the lease lapses
    assert.equal(wakes.length, 2, "renudged once the lease lapsed");
    c.update([]);
    await timers.advance(60 * 60_000);
    assert.equal(wakes.length, 2);
  });

  it("a handoff to delivered is woken for even though the connector still holds the claim (#26)", async () => {
    // The handoff wake (a request woken while pending reaching the inbox later) happens under the live claim the
    // dispatcher keeps for the run; only repeat wakes for the same state wait for the lease.
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    const lease = () => ({ leaseExpiresAt: timers.now() + 60_000 });
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]]);
    await timers.advance(5_000);
    c.update([{ ...d("a"), state: "delivered", claim: lease() }]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"], ["a"]], "the handoff is a fresh wake");
    await timers.advance(60_000);
    assert.equal(wakes.length, 2);
  });

  it("an owed handoff is still woken for after a wake built before it lands (#26)", async () => {
    const timers = new FakeTimers();
    let release: () => void = () => {};
    const wakes: string[][] = [];
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
    await timers.advance(2_000); // the wake is out, built while b was pending
    c.update([d("b")]); // handed over while it is out
    c.update([]); // and gone before it lands
    release();
    await new Promise((r) => setImmediate(r));
    await timers.advance(2_001);
    assert.deepEqual(wakes, [["b"], ["b"]], "the inbox item got a wake built after the handoff");
    await timers.advance(60 * 60_000);
    assert.equal(wakes.length, 2, "and only one");
  });

  const failingFirstWake = () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    let release: (e: Error) => void = () => {};
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 10 * 60_000,
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) await new Promise<void>((_, reject) => (release = reject));
      },
    });
    const lease = () => ({ leaseExpiresAt: timers.now() + 60_000 });
    return { timers, wakes, c, lease, fail: (e: Error) => release(e) };
  };

  it("an owed handoff whose wake is refused for good gets one follow-up, not a retry every coalesce delay (#27 review)", async () => {
    const timers = new FakeTimers();
    let release: (e: Error) => void = () => {};
    let calls = 0;
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      wake: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((_, reject) => (release = reject));
        throw new TerminalWakeError("HTTP 410");
      },
    });
    c.update([{ ...d("b"), state: "pending" }]);
    await timers.advance(2_000); // the wake is out
    c.update([d("b")]); // handed over while it is out
    c.update([]); // and gone: owed
    release(new TerminalWakeError("HTTP 410"));
    await new Promise((r) => setImmediate(r));
    await timers.advance(2_001);
    assert.equal(calls, 2, "the handoff got its one follow-up wake, refused too");
    await timers.advance(60 * 60_000);
    assert.equal(calls, 2, "no more: the debt stands, but nothing is retried on its own");
    c.subscriberAvailable(); // the callback was repaired
    await timers.advance(2_001);
    assert.equal(calls, 3, "the re-arm carries it");
  });

  it("an id handed over and gone during a retry delay, whose event the failed wake got accepted, is settled then and carried fresh (#27 review)", async () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    const forgotten: string[][] = [];
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      forget: (ids) => forgotten.push(ids),
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) throw Object.assign(new Error("HTTP 500"), { accepted: ["a"] }); // a's event accepted, b's refused
      },
    });
    c.update([{ ...d("a"), state: "pending" }, { ...d("b"), state: "pending" }]);
    await timers.advance(2_000);
    assert.deepEqual(forgotten, [["a"]], "a is settled at once and the waker drops its event");
    c.update([d("a"), { ...d("b"), state: "pending" }]); // a handed over during the retry delay (an answer: nothing left to do)
    c.update([{ ...d("b"), state: "pending" }]); // and gone: owed
    await timers.advance(2_001);
    assert.deepEqual(wakes, [["a", "b"], ["a", "b"]], "the handoff pulled the retry forward and it carries a, as a new event");
    await timers.advance(60 * 60_000);
    assert.equal(wakes.length, 2);
  });

  it("an owed handoff that landed during a failing wake, whose event that wake got accepted, is still carried by the retry (#27 review)", async () => {
    // The MCP waker keeps a retried wake's accepted events and doesn't send them again; so the ids they covered are
    // settled when the wake fails, and the waker drops them, so the retry's event for a is a new one, built after
    // the handoff.
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    const forgotten: string[][] = [];
    let release: (e: Error) => void = () => {};
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      forget: (ids) => forgotten.push(ids),
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) await new Promise<void>((_, reject) => (release = reject));
      },
    });
    c.update([{ ...d("a"), state: "pending" }, { ...d("b"), state: "pending" }]);
    await timers.advance(2_000); // the wake for [a, b] is out
    c.update([d("a"), { ...d("b"), state: "pending" }]); // a handed over while it is out
    c.update([{ ...d("b"), state: "pending" }]); // and gone
    release(Object.assign(new Error("HTTP 500"), { accepted: ["a"] })); // a's event was accepted before the handoff; b's refused
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(forgotten, [["a"]], "the waker drops a's accepted event; the debt stays (a is owed)");
    await timers.advance(30_000);
    assert.deepEqual(wakes, [["a", "b"], ["a", "b"]], "the retry carries a: a new event, built after the handoff");
    await timers.advance(60 * 60_000);
    assert.equal(wakes.length, 2, "and that paid it");
  });

  it("a request whose event the failed wake got accepted is woken for again only for its later handoff (#27 review)", async () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 10 * 60_000,
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) throw Object.assign(new Error("HTTP 500"), { accepted: ["a"] }); // a's event accepted, b's refused
      },
    });
    const lease = () => ({ leaseExpiresAt: timers.now() + 60_000 });
    c.update([{ ...d("a"), state: "pending" }, { ...d("b"), state: "pending" }]);
    await timers.advance(2_000);
    c.update([{ ...d("a"), state: "delivered", claim: lease() }, { ...d("b"), state: "pending" }]); // a handed over during the retry delay
    await timers.advance(2_001);
    assert.deepEqual(wakes, [["a", "b"], ["a", "b"]], "the handoff is a fresh wake for a (a new event); the retry for b rides along");
    for (let i = 0; i < 40; i++) {
      await timers.advance(30_000);
      c.update([{ ...d("a"), state: "delivered", claim: lease() }]); // b was answered; a's run goes on under its renewed claim
    }
    assert.equal(wakes.length, 2, "then the live lease holds a's renudges");
  });

  it("an id handed over and gone while its wake is out is forgotten by the waker when that wake fails, so the retry's event is new (#27 review)", async () => {
    // A receiver that processed the first event and only lost the response would dedupe a retry of the same event.
    const timers = new FakeTimers();
    const forgotten: string[][] = [];
    const wakes: string[][] = [];
    let release: (e: Error) => void = () => {};
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 0,
      forget: (ids) => forgotten.push(ids),
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) await new Promise<void>((_, reject) => (release = reject));
      },
    });
    c.update([{ ...d("b"), state: "pending" }]);
    await timers.advance(2_000); // the wake is out
    c.update([d("b")]); // handed over while it is out
    c.update([]); // and gone
    release(new Error("socket hang up")); // the response was lost
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(forgotten, [["b"]], "the waker drops the event it may have got through, so the retry mints a new one");
    await timers.advance(30_000);
    assert.deepEqual(wakes, [["b"], ["b"]], "the retry carries b");
    await timers.advance(60 * 60_000);
    assert.equal(wakes.length, 2);
  });

  it("a handoff that lands while a multi-event wake is out, for an id whose event was accepted, is woken for after the coalesce delay, not the retry backoff (#27 review)", async () => {
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    let release: (e: Error) => void = () => {};
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 10 * 60_000,
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) await new Promise<void>((_, reject) => (release = reject));
      },
    });
    const lease = () => ({ leaseExpiresAt: timers.now() + 60_000 });
    c.update([{ ...d("a"), state: "pending" }, { ...d("b"), state: "pending" }]);
    await timers.advance(2_000); // the wake for [a, b] is out
    c.update([{ ...d("a"), state: "delivered", claim: lease() }, { ...d("b"), state: "pending" }]); // a handed over while it is out
    release(Object.assign(new Error("HTTP 500"), { accepted: ["a"] })); // a's event (built from pending) accepted; b's refused
    await new Promise((r) => setImmediate(r));
    await timers.advance(2_001);
    assert.equal(wakes.length, 2, "a's post-handoff wake went out after the coalesce delay");
    assert.ok(wakes[1]!.includes("a"), `and carried a: ${JSON.stringify(wakes[1])}`);
  });

  it("a handoff noted between a failed wake and its retry makes the waker forget the id, so the handoff wake is a new event (#27 review)", async () => {
    // The failed wake may have been processed with its response lost; the retry would be deduped and count as landed.
    const timers = new FakeTimers();
    const forgotten: string[][] = [];
    const wakes: string[][] = [];
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 10 * 60_000,
      forget: (ids) => forgotten.push(ids),
      wake: async (ids) => {
        wakes.push(ids);
        if (wakes.length === 1) throw new Error("socket hang up");
      },
    });
    const lease = () => ({ leaseExpiresAt: timers.now() + 60_000 });
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(2_000); // the wake fails with a lost response; a retry is due in 30 s
    c.update([{ ...d("a"), state: "delivered", claim: lease() }]); // handed over during the retry delay
    assert.deepEqual(forgotten, [["a"]], "the retained event is dropped for a before the handoff wake");
    await timers.advance(2_001);
    assert.deepEqual(wakes, [["a"], ["a"]], "the handoff wake went out after the coalesce delay");
    assert.equal(forgotten.length, 1, "a handoff with no retry pending forgets nothing");
  });

  it("a newcomer whose event is accepted on a retry of a failing wake isn't woken for again by the next retry (#27 review)", async () => {
    // The race Codex and Macroscope found on fc4e5cd: b's event keeps failing; a is handed over and joins the retry
    // as its own event, which is accepted (after the handoff). The next retry must not treat a as unpaid.
    const timers = new FakeTimers();
    const wakes: string[][] = [];
    const c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 10 * 60_000,
      wake: async (ids) => {
        wakes.push(ids);
        // b's event is refused every time; a's, once it joins, is accepted.
        throw Object.assign(new Error("HTTP 500"), { accepted: ids.filter((id) => id === "a") });
      },
    });
    const lease = () => ({ leaseExpiresAt: timers.now() + 60_000 });
    c.update([{ ...d("b"), state: "pending" }]);
    await timers.advance(2_000); // wake for b fails; retry in 30 s
    c.update([{ ...d("b"), state: "pending" }, { ...d("a"), state: "pending" }]); // a arrives
    c.update([{ ...d("b"), state: "pending" }, { ...d("a"), state: "delivered", claim: lease() }]); // and is handed over at once
    await timers.advance(2_001);
    assert.deepEqual(wakes.map((w) => [...w].sort()), [["b"], ["a", "b"]], "a joins the retry");
    for (let i = 0; i < 20; i++) {
      await timers.advance(30_000); // b keeps failing; a's run goes on under its renewed claim
      c.update([{ ...d("b"), state: "pending" }, { ...d("a"), state: "delivered", claim: lease() }]);
    }
    assert.ok(wakes.slice(2).every((w) => !w.includes("a")), `a was accepted on the retry and is not woken for again: ${JSON.stringify(wakes.slice(2))}`);
    assert.ok(wakes.length >= 3, "b's retries went on without a");
  });

  it("a handoff that lands during a failing pre-handoff wake is carried by the retry despite the live claim (#27 review)", async () => {
    const { timers, wakes, c, lease, fail } = failingFirstWake();
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(2_000); // the wake is out, built from pending
    c.update([{ ...d("a"), state: "delivered", claim: lease() }]); // handed over while it is out (noted in `transitioned`)
    fail(new Error("HTTP 500")); // then it fails: a retry is due in 30 s; the row doesn't change again before that
    await new Promise((r) => setImmediate(r));
    await timers.advance(30_000);
    assert.deepEqual(wakes, [["a"], ["a"]], "the retry went out under the live claim: nothing has reached the agent yet");
    await timers.advance(2_001);
    assert.equal(wakes.length, 3, "the retry was built from pending, so the handoff got its own wake after it");
    for (let i = 0; i < 60; i++) {
      await timers.advance(30_000);
      c.update([{ ...d("a"), state: "delivered", claim: lease() }]);
    }
    assert.equal(wakes.length, 3, "once a wake landed, the lease holds the renudges");
  });

  it("a handoff noted during a failing wake and seen again on a lease renewal is woken for once, not twice", async () => {
    const { timers, wakes, c, lease, fail } = failingFirstWake();
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(2_000);
    c.update([{ ...d("a"), state: "delivered", claim: lease() }]); // handed over while the wake is out
    fail(new Error("HTTP 500"));
    await new Promise((r) => setImmediate(r));
    await timers.advance(10_000);
    c.update([{ ...d("a"), state: "delivered", claim: lease() }]); // the dispatcher renewed the claim: same handoff, seen outside a wake
    await timers.advance(2_001);
    assert.deepEqual(wakes, [["a"], ["a"]], "the handoff pulled the retry forward to the coalesce delay");
    await timers.advance(60_000);
    assert.equal(wakes.length, 2, "and isn't woken for a second time off the stale in-flight note");
  });

  it("a handoff wake refused for good is tried again by a subscriber re-arm and by the renudge despite the live claim (#27 review)", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000, terminal: 1 });
    const lease = () => ({ leaseExpiresAt: timers.now() + 60_000 });
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(500);
    c.update([{ ...d("a"), state: "delivered", claim: lease() }]); // handed over inside the coalesce window
    await timers.advance(1_500); // the one wake is refused for good (410): the inbox item is unread, no run started
    assert.equal(wakes.length, 0);
    c.update([{ ...d("a"), state: "delivered", claim: lease() }]);
    c.subscriberAvailable(); // the callback was repaired
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]], "re-armed and woken under the live claim");
    const { timers: t2, wakes: w2, c: c2 } = setup({ renudgeMs: 10 * 60_000, terminal: 1 });
    const lease2 = () => ({ leaseExpiresAt: t2.now() + 60_000 });
    c2.update([{ ...d("a"), state: "pending" }]);
    await t2.advance(500);
    c2.update([{ ...d("a"), state: "delivered", claim: lease2() }]);
    await t2.advance(1_500); // refused for good
    for (let i = 0; i < 21; i++) {
      await t2.advance(30_000);
      c2.update([{ ...d("a"), state: "delivered", claim: lease2() }]); // the claim is renewed throughout
    }
    assert.deepEqual(w2, [["a"]], "the 10 min renudge went out under the live claim: no wake had landed");
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

  it("with renudging off, a delivery first seen under a live lease is still woken for when the lease lapses", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 0 });
    c.update([{ ...d("a"), state: "claimed", claim: { leaseExpiresAt: timers.now() + 2 * 60_000 } }]);
    await timers.advance(60_000);
    assert.equal(wakes.length, 0);
    await timers.advance(60_000 + 2_001);
    assert.deepEqual(wakes, [["a"]]);
  });

  it("an owed delivery isn't forgotten by the waker until its wake lands", async () => {
    const timers = new FakeTimers();
    const forgotten: string[][] = [];
    const wakes: string[][] = [];
    const c = new Coordinator({ participant: "dot", timers, log: () => {}, renudgeMs: 0, wake: async (ids) => void wakes.push(ids), forget: (ids) => forgotten.push(ids) });
    c.update([{ ...d("a", "dot"), state: "claimed", claim: { leaseExpiresAt: timers.now() + 60_000 } }]);
    c.update([]); // handed over and gone: owed
    assert.deepEqual(forgotten, [], "not forgotten while owed: the waker still has to carry it");
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]]);
    assert.deepEqual(forgotten, [["a"]], "forgotten once the wake landed");
  });

  it("a handoff that lands during a failing renudge, whose delivery then goes, is owed and retried", async () => {
    const timers = new FakeTimers();
    const calls: string[][] = [];
    let n = 0;
    // biome-ignore lint/style/useConst: assigned below
    let c: Coordinator;
    c = new Coordinator({
      participant: "grok",
      timers,
      log: () => {},
      renudgeMs: 10 * 60_000,
      wake: async (ids) => {
        calls.push(ids);
        if (++n === 2) {
          c.update([d("a")]); // handed over while the renudge is out
          c.update([]); // ... and gone before it fails
          throw new Error("HTTP 500");
        }
      },
    });
    c.update([{ ...d("a"), state: "pending" }]);
    await timers.advance(2_000); // first wake lands
    await timers.advance(10 * 60_000); // the renudge, which fails with the handoff in flight
    await timers.advance(30_000); // the retry
    assert.deepEqual(calls, [["a"], ["a"], ["a"]], "the retry carried the handed-over delivery");
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
