// Capabilities pass (W, mod 0.1.3): a notice (a reminder's report or ending, from
// @reminders) is delivered and never collected, like an answer: its turn is the
// agent's own, and no reply is expected.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Tracker } from "../hooks/core/tracker.ts";
import { parseDeliveryHeader } from "../hooks/protocol/render.ts";
import { FakeSession, makeMod, pumpUntil, stubOps, useStub, wrap } from "./support.ts";

const ctx = useStub("comms-mod-cap-");
const { post } = stubOps(ctx);

describe("W notices", () => {
  it("W notice: the tracker finishes a notice at delivered and collects nothing from its turn", () => {
    const t = new Tracker("agent-comms");
    const rendered = "[agent-comms v1] delivery=d_1 message=m_1 kind=notice\nFrom: @reminders (system), via agent-comms\n> @reed answered";
    t.submitted({ deliveryId: "d_1", messageId: "m_1", kind: "notice", rendered, sessionId: "s", at: 0 });
    assert.deepEqual(t.turnStart("t1", wrap(rendered), 1), [
      { type: "delivered", deliveryId: "d_1", turnId: "t1" },
      { type: "done", deliveryId: "d_1" },
    ]);
    assert.deepEqual(t.turnComplete({ turnId: "t1", reason: "answer", answer: "noted", at: 2 }), []);
  });

  it("W notice: the mod submits a notice saying no reply is expected, reports it delivered, and never reports an outcome", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    // The stub can't post notices (only system participants do): take a delivery it
    // renders and make it the notice @reminders would send.
    await post({ sender: "mod-b", to: ["mod-a"], text: "Reminder ci (r_9): @reed answered:\n> CI is green" });
    const d = ctx.comms.record.deliveries.at(-1)!;
    const shaped = (ctx.comms as any).render(d);
    const notice = {
      ...shaped,
      message: { ...shaped.message, kind: "notice", sender: { id: "p_rem", name: "reminders", kind: "system" } },
    };
    await (mod as any).handle({ type: "deliver", delivery: notice });
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    const text = session.submitted[0]!;
    assert.equal(parseDeliveryHeader(text)?.kind, "notice");
    assert.match(text, /No reply is expected/);
    assert.doesNotMatch(text, /comms reply/);

    mod.onTurnStart("turn-1", wrap(text));
    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "Noted: CI is green." });
    await pumpUntil(mod, () => session.ops("delivered").length === 1, "delivered");
    for (let i = 0; i < 3; i++) await mod.tick();
    assert.equal(session.ops("outcome").length, 0, "a notice's turn is never reported as its answer");
  });
});
