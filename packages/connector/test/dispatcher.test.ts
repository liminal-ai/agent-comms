// Fix pass section 2: the dispatcher with a scripted adapter on the `t3`
// harness (participant `tee` in the harness world), real Convex functions.

import { call } from "@agent-comms/comms-cli/client";
import type { Delivery } from "@agent-comms/protocol";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "../../../convex/_generated/api.js";
import type { Check, HandOff, HarnessAdapter, Outcome, Target } from "../src/adapter.ts";
import { ADMIN, type Convex, type Running, sleep, startConnector, until, world } from "./harness.ts";

type Gate = { confirm: (cursor?: string) => Promise<boolean>; signal: AbortSignal };

/** A scripted harness: what each call returns is set by the test. */
class Scripted {
  handOffs = 0;
  sent = 0;
  checks = 0;
  handOffWaitMs = 0;
  onHandOff: () => HandOff = () => ({ _tag: "accepted", turnId: "t1" });
  onOutcome: () => Outcome = () => ({ _tag: "lost", detail: "scripted" });
  onCheck: () => Check = () => ({ _tag: "absent" });
  readonly adapter: HarnessAdapter = {
    harness: "t3",
    ready: () => Effect.succeed(true),
    handOff: ((_target: Target, _delivery: Delivery, gate?: Gate) =>
      Effect.promise(async (signal: AbortSignal) => {
        this.handOffs += 1;
        // The courtesy wait, in which the claim can be lost.
        const end = Date.now() + this.handOffWaitMs;
        while (Date.now() < end && !signal.aborted && !gate?.signal.aborted) await sleep(20);
        if (signal.aborted || gate?.signal.aborted) return { _tag: "lost", detail: "aborted" } as HandOff;
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
      const d = await ctx.db.get(sent.deliveries[0]!.id as never);
      await ctx.db.patch((d as { _id: never })._id, { claim: { machine: "box", claimId: "someone-else", leaseExpiresAt: Date.now() + 600_000 } } as never);
    });
    await sleep(3_000);
    expect(s.sent).toBe(0);
  });
});
