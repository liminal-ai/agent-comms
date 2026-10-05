// The mod against the real connector stub over a Unix socket: registration,
// polling, submission, reports, restart checks, reconnection, slow polls.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StubComms } from "@agent-comms/connector-stub";
import { CommsMod } from "../hooks/core/mod.ts";
import { parseDeliveryHeader, parseNoticeHeader } from "../hooks/protocol/render.ts";
import { FakeSession, makeMod, pumpUntil, rawCall, stubOps, until, useStub, wrap } from "./support.ts";

const ctx = useStub("comms-mod-test-");
const { post, deliveryState } = stubOps(ctx);

describe("CommsMod against the stub", () => {
  it("registers, submits a delivery, reports delivered and the collected answer", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    assert.equal(session.ops("register")[0].participant, "mod-a");
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "what's 2+2?" });
    const deliveryId = sent.deliveries[0].id;
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    const header = parseDeliveryHeader(session.submitted[0]!)!;
    assert.equal(header.deliveryId, deliveryId);

    mod.onTurnStart("turn-1", wrap(session.submitted[0]!));
    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "4" });
    await pumpUntil(mod, () => session.ops("outcome").length === 1, "the outcome");
    assert.equal(await deliveryState(deliveryId), "replied");
    assert.deepEqual(session.ops("delivered")[0], { sessionId: "sess-1", deliveryId, turnId: "turn-1" });
    assert.deepEqual(session.ops("presence").map((p) => p.status), ["busy", "idle"]);
  });

  it("reports other input in our turn as ambiguous and tells the agent to comms reply", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "run the tests" });
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    mod.onTurnStart("turn-1", wrap(session.submitted[0]!));
    mod.onPromptSubmit({ turnId: "turn-1", origin: { kind: "composer" }, text: "also 2+2?" });
    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "tests pass; 4" });
    session.clock += 5_000;
    await pumpUntil(mod, () => session.ops("outcome").length === 1 && session.submitted.length === 2, "outcome and notice");
    assert.equal(session.ops("outcome")[0].outcome, "ambiguous");
    assert.equal(await deliveryState(sent.deliveries[0].id), "ambiguous");
    const notice = session.submitted[1]!;
    assert.match(notice, /comms reply --as mod-a m_\d+ /);
    assert.equal(parseDeliveryHeader(notice), null);
    assert.equal(parseNoticeHeader(notice)?.deliveryId, sent.deliveries[0].id);
    // The notice's own turn is never reported.
    mod.onTurnStart("turn-2", wrap(notice));
    mod.onTurnComplete({ turnId: "turn-2", reason: "answer", answer: "replied with comms" });
    await mod.tick();
    assert.equal(session.ops("outcome").length, 1);
  });

  it("an answer delivery is delivered and nothing its turn does is collected", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    const req = await post({ sender: "mod-a", to: ["mod-b"], text: "ping" });
    await post({ sender: "mod-b", to: ["mod-a"], kind: "answer", inReplyTo: req.message.id, text: "pong" });
    await pumpUntil(mod, () => session.submitted.length === 1, "the answer delivery");
    mod.onTurnStart("turn-1", wrap(session.submitted[0]!));
    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "got pong, sending another ping" });
    await pumpUntil(mod, () => session.ops("delivered").length === 1, "delivered");
    await mod.tick();
    assert.equal(session.ops("outcome").length, 0);
  });

  it("dedupes a delivery handed out twice", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    await post({ sender: "mod-b", to: ["mod-a"], text: "once" });
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    // The same delivery handed out again (a replayed poll) is not submitted twice.
    const d = ctx.comms.record.deliveries[0]!;
    await (mod as any).handle({ type: "deliver", delivery: (ctx.comms as any).render(d) });
    await mod.tick();
    assert.equal(session.submitted.length, 1);
  });

  it("never overlaps polls when the connector is slow", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = new CommsMod(session.host(), { participant: "mod-a", sessionId: "sess-1", cwd: "/tmp", pluginName: "agent-comms", pollWaitMs: 1_000 });
    await mod.start();
    for (let i = 0; i < 10; i++) {
      await mod.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(session.maxInFlightPolls, 1);
    const pollErrors = session.logs.filter((l) => l.includes("poll_in_progress"));
    assert.deepEqual(pollErrors, []);
  });

  it("re-registers after the connector restarts and answers the restart check without re-running", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "long job" });
    const deliveryId = sent.deliveries[0].id;
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    mod.onTurnStart("turn-1", wrap(session.submitted[0]!));
    await pumpUntil(mod, () => session.ops("delivered").length === 1, "delivered");

    // Restart: same record, sessions gone. The delivery comes back as a check.
    await ctx.restart(new StubComms(ctx.comms.record));

    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "finished" });
    // Cold Windows helper recovery can cross the 10s call deadline and 15s
    // bridge startup guard; keep a finite bound without shortening either.
    const recoveryMs = process.platform === "win32" ? 20_000 : 5_000;
    try {
      await pumpUntil(mod, () => session.ops("register").length >= 2 || session.ops("outcome").length >= 1, "re-registration or outcome", recoveryMs);
      await pumpUntil(mod, async () => (await deliveryState(deliveryId)) === "replied", "replied", recoveryMs);
    } catch (error) {
      // Fixture-only calls contain dummy participants and messages, never credentials.
      throw new Error(`Restart recovery failed: ${JSON.stringify({logs:session.logs,calls:session.calls,inFlightPolls:session.inFlightPolls})}`, {cause:error});
    }
    assert.equal(session.submitted.length, 1, "never submitted twice");
  });

  it("answers a check for something it never saw with no, and for a transcript-only one with unknown", async () => {
    const session = new FakeSession(ctx.socketPath);
    // A journal with intact history (an existing, readable file).
    session.journal = JSON.stringify({ participant: "mod-a", deliveries: [], seen: [] });
    const mod = makeMod(session);
    await mod.start();
    await (mod as any).check({ deliveryId: "d_x", messageId: "m_x", state: "claimed" });
    session.transcript.push("[agent-comms v1] delivery=d_y message=m_y kind=request");
    await (mod as any).check({ deliveryId: "d_y", messageId: "m_y", state: "claimed" });
    await until(() => session.ops("check-result").length === 2, "both check results");
    const results = session.ops("check-result").map((c) => [c.deliveryId, c.found]);
    assert.deepEqual(results, [
      ["d_x", "no"],
      ["d_y", "unknown"],
    ]);
  });

  it("a later session of the same participant knows what an earlier one submitted", async () => {
    await ctx.restart();
    const first = new FakeSession(ctx.socketPath);
    const mod1 = makeMod(first, "sess-1");
    await mod1.start();
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "before a crash" });
    await pumpUntil(mod1, () => first.submitted.length === 1, "the submission");
    mod1.onTurnStart("turn-1", wrap(first.submitted[0]!));
    await pumpUntil(mod1, () => first.ops("delivered").length === 1, "delivered");

    const second = new FakeSession(ctx.socketPath);
    second.journal = first.journal;
    const mod2 = makeMod(second, "sess-2");
    await mod2.start();
    await pumpUntil(mod2, () => second.ops("check-result").length === 1, "the check result");
    assert.equal(second.ops("check-result")[0].found, "unknown");
    assert.equal(second.submitted.length, 0);
    assert.equal(await deliveryState(sent.deliveries[0].id), "uncertain");
  });

  it("stops polling when a newer session supersedes it", async () => {
    const a = new FakeSession(ctx.socketPath);
    const mod1 = makeMod(a, "sess-1");
    await mod1.start();
    const b = new FakeSession(ctx.socketPath);
    const mod2 = makeMod(b, "sess-2");
    await mod2.start();
    await mod1.tick();
    await until(() => mod1.isStopped, "mod1 stops");
  });

  it("reports a prompt a hook dropped as failed", async () => {
    const session = new FakeSession(ctx.socketPath);
    session.dropNext = "blocked by policy";
    const mod = makeMod(session);
    await mod.start();
    await post({ sender: "mod-b", to: ["mod-a"], text: "please" });
    await pumpUntil(mod, () => session.ops("outcome").length === 1, "the failure report");
    assert.equal(session.ops("outcome")[0].reason, "rejected");
    assert.equal(session.ops("outcome")[0].turnId, undefined);
    await until(async () => (await deliveryState(session.ops("outcome")[0].deliveryId)) === "failed", "failed");
  });
});
