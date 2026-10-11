// Fix pass section 2: the dispatcher with a scripted adapter on the `t3`
// harness (participant `tee` in the harness world), real Convex functions.

import { call } from "@agent-comms/comms-cli/client";
import type { Delivery } from "@agent-comms/protocol";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "../../../convex/_generated/api.js";
import type { Check, HandOff, HarnessAdapter, Outcome, Target } from "../src/adapter.ts";
import { ADMIN, type Convex, type Running, sleep, startConnector, until, world } from "./harness.ts";

type Gate = { confirm: (cursor?: string) => Promise<boolean>; signal?: AbortSignal };

/** A scripted harness: what each call returns is set by the test. */
class Scripted {
  handOffs = 0;
  sent = 0;
  checks = 0;
  handOffWaitMs = 0;
  onHandOff: () => HandOff = () => ({ _tag: "accepted", turnId: "t1" });
  onOutcome: () => Outcome | Promise<Outcome> = () => ({ _tag: "lost", detail: "scripted" });
  onCheck: () => Check = () => ({ _tag: "absent" });
  adapter: HarnessAdapter = {
    harness: "t3",
    steersIntoRunningTurn: true,
    ready: () => Effect.succeed(true),
    handOff: ((_target: Target, _delivery: Delivery, gate?: Gate) =>
      Effect.promise(async (signal: AbortSignal) => {
        this.handOffs += 1;
        // The courtesy wait, in which the claim can be lost.
        const end = Date.now() + this.handOffWaitMs;
        while (Date.now() < end && !signal.aborted && !gate?.signal?.aborted) await sleep(20);
        if (signal.aborted || gate?.signal?.aborted) return { _tag: "lost", detail: "aborted" } as HandOff;
        if (gate && !(await gate.confirm("100"))) return { _tag: "lost", detail: "claim not held" } as HandOff;
        this.sent += 1;
        return this.onHandOff();
      })) as HarnessAdapter["handOff"],
    awaitOutcome: () => Effect.promise(async () => this.onOutcome()),
    check: () =>
      Effect.sync(() => {
        this.checks += 1;
        return this.onCheck();
      }),
  };
}

let running: Running[] = [];
afterEach(async () => {
  for (const r of running) await r.stop().catch(() => {});
  running = [];
});

async function deliveryRow(t: Convex, conversationId: string, messageId: string) {
  const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId });
  return view.messages.find((m) => m.message.id === messageId)?.deliveries[0];
}

describe("fix pass section 2: dispatcher", () => {
  it("2.1 recovery reads the delivery's current state: delivered then lost, then absent, is uncertain, not a re-run", async () => {
    const w = await world();
    const s = new Scripted();
    s.onOutcome = () => ({ _tag: "lost", detail: "lost sight of the turn" });
    s.onCheck = () => ({ _tag: "absent" });
    running.push(await startConnector(w.api, w.socket, 1_500, [s.adapter]));
    const sent = await call(w.socket, "send", { as: "a", to: ["tee"], text: "q" });
    if (!sent.ok) throw new Error(sent.error.message);
    const row = await until("settled", async () => {
      const d = await deliveryRow(w.t, sent.message.conversationId, sent.message.id);
      return d && ["uncertain", "replied", "failed"].includes(d.state) ? d : undefined;
    }, 15_000).catch(() => undefined);
    expect(s.sent).toBe(1);
    expect(row?.state).toBe("uncertain");
  });

  it("2.2 losing the claim during the handoff cancels the send", async () => {
    const w = await world();
    const s = new Scripted();
    s.handOffWaitMs = 2_000;
    // A long lease: the periodic renewal won't notice in time; only the check right before sending can.
    running.push(await startConnector(w.api, w.socket, 60_000, [s.adapter]));
    const sent = await call(w.socket, "send", { as: "a", to: ["tee"], text: "q" });
    if (!sent.ok) throw new Error(sent.error.message);
    await until("handoff started", async () => s.handOffs > 0);
    // Another connector takes the claim while we're in the courtesy wait.
    await w.t.run(async (ctx) => {
      const id = ctx.db.normalizeId("deliveries", sent.deliveries[0]!.id)!;
      await ctx.db.patch(id, { claim: { machine: "box", claimId: "someone-else", leaseExpiresAt: Date.now() + 600_000 } });
    });
    await sleep(3_000);
    expect(s.sent).toBe(0);
  });
});

describe("reaching a busy agent (Mira #371: a stop waited 75 minutes)", () => {
  /** An outcome that waits until the test ends the turn. */
  const turn = () => {
    let end!: (o: Outcome) => void;
    const done = new Promise<Outcome>((r) => (end = r));
    return { done, end };
  };

  it("a delivery steered into a running turn doesn't hold the agent: the next one is handed over at once", async () => {
    const w = await world();
    const s = new Scripted();
    const t1 = turn();
    s.onHandOff = () => ({ _tag: "accepted", turnId: "long-run", steered: true });
    s.onOutcome = () => t1.done;
    running.push(await startConnector(w.api, w.socket, 60_000, [s.adapter]));
    const first = await call(w.socket, "send", { as: "a", to: ["tee"], text: "first" });
    if (!first.ok) throw new Error(first.error.message);
    await until("first handed over", async () => s.sent === 1);
    const second = await call(w.socket, "send", { as: "a", to: ["tee"], text: "second" });
    if (!second.ok) throw new Error(second.error.message);
    // The long turn is still running, and the second goes in anyway.
    await until("second handed over while the turn runs", async () => s.sent === 2, 10_000);
    t1.end({ _tag: "ambiguous", entered: [{ origin: "t3-steered" }] });
    const row = await until("first settled", async () => {
      const d = await deliveryRow(w.t, first.message.conversationId, first.message.id);
      return d?.state === "ambiguous" ? d : undefined;
    }, 10_000);
    expect(row.state).toBe("ambiguous");
  });

  it("after a restart, a delivery found steered into a running turn doesn't hold the agent", async () => {
    const w = await world();
    const s = new Scripted();
    const t1 = turn();
    // The first handoff is lost (as in a crash); the restart check finds it steered into a running turn.
    s.onHandOff = () => (s.sent === 1 ? { _tag: "lost", detail: "connector restarted" } : { _tag: "accepted", turnId: "own-run" });
    s.onCheck = () => ({ _tag: "running", turnId: "long-run", steered: true });
    s.onOutcome = () => (s.sent === 1 ? t1.done : { _tag: "replied", answer: "ok" });
    running.push(await startConnector(w.api, w.socket, 1_500, [s.adapter]));
    const first = await call(w.socket, "send", { as: "a", to: ["tee"], text: "first" });
    if (!first.ok) throw new Error(first.error.message);
    await until("first recovered as steered", async () => s.checks > 0, 15_000);
    const second = await call(w.socket, "send", { as: "a", to: ["tee"], text: "second" });
    if (!second.ok) throw new Error(second.error.message);
    await until("second handed over while the recovered turn runs", async () => s.sent === 2, 15_000);
    t1.end({ _tag: "ambiguous", entered: [{ origin: "t3-steered" }] });
  }, 40_000);

  it("an urgent delivery that bypasses the holder only joins a running turn; if none, it sends nothing then goes in turn", async () => {
    const w = await world();
    const s = new Scripted();
    const t1 = turn();
    const gates: (boolean | undefined)[] = [];
    const inner = s.adapter.handOff;
    s.adapter = { ...s.adapter, handOff: ((t: Target, d: Delivery, g: Gate & { steerOnly?: boolean }) => (gates.push(g?.steerOnly), inner(t, d, g))) as HarnessAdapter["handOff"] };
    // Steer-only handoffs find no running turn (the thread went idle): aborted, nothing sent.
    s.onHandOff = () => (gates.at(-1) ? { _tag: "aborted", detail: "no turn running to join" } : { _tag: "accepted", turnId: `run-${s.sent}` });
    s.onOutcome = () => (s.sent === 1 ? t1.done : { _tag: "replied", answer: "ok" });
    running.push(await startConnector(w.api, w.socket, 60_000, [s.adapter]));
    const first = await call(w.socket, "send", { as: "a", to: ["tee"], text: "long job" });
    if (!first.ok) throw new Error(first.error.message);
    await until("first handed over", async () => s.sent === 1);
    const stop = await call(w.socket, "send", { as: "a", to: ["tee"], text: "STOP", urgent: true });
    if (!stop.ok) throw new Error(stop.error.message);
    await until("urgent tried steer-only", async () => gates.includes(true), 10_000);
    expect(s.sent).toBe(2);
    t1.end({ _tag: "replied", answer: "done" });
    await until("urgent handed over normally once the agent is free", async () => gates.filter((g) => !g).length >= 2 && s.sent >= 3, 15_000);
    const row = await until("urgent settled", async () => {
      const d = await deliveryRow(w.t, stop.message.conversationId, stop.message.id);
      return d && ["replied", "ambiguous", "failed", "uncertain"].includes(d.state) ? d : undefined;
    }, 15_000);
    expect(row.state).toBe("replied");
  }, 40_000);

  it("an ordinary delivery doesn't wait for the turn holding the agent either: it joins that turn", async () => {
    const w = await world();
    const s = new Scripted();
    const t1 = turn();
    // The first request runs as its own turn (not steered): it holds the agent until the turn ends.
    s.onHandOff = () => ({ _tag: "accepted", turnId: `run-${s.sent}`, ...(s.sent > 1 ? { steered: true } : {}) });
    s.onOutcome = () => (s.sent === 1 ? t1.done : { _tag: "replied", answer: "ok" });
    running.push(await startConnector(w.api, w.socket, 60_000, [s.adapter]));
    const first = await call(w.socket, "send", { as: "a", to: ["tee"], text: "long job" });
    if (!first.ok) throw new Error(first.error.message);
    await until("first handed over", async () => s.sent === 1);
    const ordinary = await call(w.socket, "send", { as: "a", to: ["tee"], text: "ordinary" });
    if (!ordinary.ok) throw new Error(ordinary.error.message);
    await until("ordinary joined the running turn", async () => s.sent === 2, 10_000);
    const ordinaryRow = await deliveryRow(w.t, ordinary.message.conversationId, ordinary.message.id);
    expect(ordinaryRow?.state).not.toBe("pending");
    const second = await call(w.socket, "send", { as: "a", to: ["tee"], text: "another" });
    if (!second.ok) throw new Error(second.error.message);
    await until("and the next one too, one at a time", async () => s.sent === 3, 10_000);
    t1.end({ _tag: "replied", answer: "done" });
  });
});
