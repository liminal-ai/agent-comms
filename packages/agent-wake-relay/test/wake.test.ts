import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, parseConfig } from "../src/config.ts";
import { Coordinator, type Timers, type WorkDelivery } from "../src/coordinator.ts";
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

function setup(opts: { fail?: number; renudgeMs?: number } = {}) {
  const timers = new FakeTimers();
  const wakes: string[][] = [];
  let failures = opts.fail ?? 0;
  const c = new Coordinator({
    participant: "grok",
    timers,
    log: () => {},
    renudgeMs: opts.renudgeMs ?? 0,
    wake: async (ids) => {
      if (failures > 0) {
        failures--;
        throw new Error("HTTP 500");
      }
      wakes.push(ids);
    },
  });
  return { timers, wakes, c };
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
