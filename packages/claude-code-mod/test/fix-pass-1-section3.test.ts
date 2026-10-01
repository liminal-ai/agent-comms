// Fix pass 1, section 3 mod items (3.8, 3.8a) against the connector stub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { followUpNote } from "../hooks/core/mod.ts";
import { FakeSession, makeMod, pumpUntil, stubOps, until, useStub, wrap } from "./support.ts";

const ctx = useStub("comms-mod-fp1s3-");
const { post, deliveryState } = stubOps(ctx);

describe("3.8 timeouts and the start deadline", () => {
  it("3.8: a poll the connector never answers times out; the mod registers again and keeps polling", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session, "sess-1", "mod-a", { pollGraceMs: 100 });
    await mod.start();
    session.hangPaths.add("/v1/poll");
    await mod.tick();
    await until(() => session.logs.some((l) => l.includes("poll: no answer")), "the poll timeout");
    session.hangPaths.clear();
    const registersBefore = session.ops("register").length;
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "still there?" });
    await pumpUntil(mod, () => session.submitted.length === 1, "a delivery after the hang");
    assert.ok(session.ops("register").length > registersBefore, "registered again");
    assert.equal(session.submitted[0]!.includes(sent.deliveries[0].id), true);
  });

  it("3.8: a report call that never answers is bounded and retried", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session, "sess-1", "mod-a", { callTimeoutMs: 150 });
    await mod.start();
    session.hangPaths.add("/v1/presence");
    mod.onTurnStart("t-other", "Lee's own prompt");
    await until(() => session.logs.some((l) => l.includes("presence: no answer")), "the presence timeout");
    session.hangPaths.clear();
    await pumpUntil(mod, () => session.ops("presence").length >= 2, "presence retried");
  });

  it("3.8: a submitted prompt that never starts: after the deadline a check is unknown; a late start is still reported", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session, "sess-1", "mod-a", { startDeadlineMs: 1_000 });
    await mod.start();
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "queued" });
    const id = sent.deliveries[0].id;
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    // Before the deadline a check waits for the prompt to start.
    await (mod as any).check({ deliveryId: id, messageId: sent.message.id, state: "claimed" });
    assert.equal(session.ops("check-result").length, 0);
    session.clock += 2_000;
    await pumpUntil(mod, () => session.ops("check-result").length === 1, "the deferred check answered");
    assert.equal(session.ops("check-result")[0].found, "unknown");
    // The prompt starts after all: still reported.
    mod.onTurnStart("t-late", wrap(session.submitted[0]!));
    await pumpUntil(mod, () => session.ops("delivered").length === 1, "late delivered");
    assert.equal(session.ops("delivered")[0].deliveryId, id);
    void deliveryState;
  });
});

describe("3.8a follow-up note wording", () => {
  it("3.8a: the note says what happened to the turn's reply", () => {
    const base = { messageId: "m_1", sender: "reed", recipient: "cc-a" };
    assert.match(followUpNote({ ...base, outcome: { outcome: "replied", answer: "x" } }, "cc-a"), /was sent as the answer/);
    assert.match(followUpNote({ ...base, outcome: { outcome: "ambiguous", entered: [] } }, "cc-a"), /was not sent, because other input entered/);
    assert.match(followUpNote({ ...base, outcome: { outcome: "failed", reason: "aborted" } }, "cc-a"), /without an answer being sent \(aborted\)/);
    assert.doesNotMatch(followUpNote({ ...base, outcome: { outcome: "ambiguous", entered: [] } }, "cc-a"), /already sent/);
  });
});
