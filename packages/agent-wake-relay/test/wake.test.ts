import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, parseConfig } from "../src/config.ts";
import { Coordinator, MAX_TIMER_MS, TerminalWakeError, type Timers, type WorkDelivery } from "../src/coordinator.ts";
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
    await timers.advance(2_000 + 4 * 30_000);
    assert.equal(logs.filter((l) => l.includes("wake failed")).length, 1);
    await timers.advance(3 * 60_000);
    const failed = logs.filter((l) => l.includes("wake failed"));
    assert.equal(failed.length, 2);
    assert.match(failed[1]!, /failed the same way 9 more time\(s\)/);
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
    await timers.advance(30_000);
    assert.equal(wakes.length, 2, "and the renudge gets through once the webhook recovers");
    assert.ok(logs.some((l) => /retrying every 30s/.test(l)));
  });

  it("a renudge pre-empted by a wake that turns out empty is reinstalled", async () => {
    const { timers, wakes, c } = setup({ renudgeMs: 10 * 60_000 });
    c.update([d("a")]);
    await timers.advance(2_000);
    assert.deepEqual(wakes, [["a"]]);
    await timers.advance(5 * 60_000);
    c.update([d("a"), d("b")]); // a fresh delivery: a coalesced wake is scheduled, the renudge timer cleared
    c.update([d("a")]); // and it's gone again before that wake fires
    await timers.advance(2_000);
    assert.equal(wakes.length, 1, "nothing was due for the coalesced wake");
    await timers.advance(5 * 60_000);
    assert.deepEqual(wakes, [["a"], ["a"]], "a was still renudged on time");
  });

  it("a handoff noted during an in-flight wake is forgotten with its delivery", async () => {
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
    assert.equal((c as unknown as { transitioned: Set<string> }).transitioned.size, 0, "nothing stale is kept");
    await timers.advance(60_000);
    assert.equal(calls, 1, "and nothing is woken for");
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
