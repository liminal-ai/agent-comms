// Capabilities fix pass 1.1 (contract section 0.1), the mod's part: stamp the waiter's main
// turn (presence and register carry turnId), and confirm an answer only from a main-loop tool
// result whose text holds a complete proof (answer-seen).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StubComms } from "@agent-comms/connector-stub";
import { renderAnswerWithProof } from "../hooks/protocol/proof.ts";
import { FakeSession, makeMod, pumpUntil, until, useStub } from "./support.ts";

const ctx = useStub("comms-mod-fpc-");
const proof = { waitId: "w_1", messageId: "m_1", token: "a".repeat(32) };
const printed = ["sent m_q (#1 in c_1), waiting up to 100s for @t3-native", renderAnswerWithProof(proof, "@t3-native answered (m_1):", "Forty-two.")].join("\n");

describe("fix pass 1.1: the waiter's turn", () => {
  it("1.1: presence carries the main turn id when busy", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    mod.onTurnStart("turn-1", "hello");
    await pumpUntil(mod, () => session.ops("presence").length === 1, "presence");
    assert.deepEqual(session.ops("presence")[0], { sessionId: "sess-1", status: "busy", turnId: "turn-1" });
  });

  it("1.1: a new main turn while still busy sends presence again with the new turn id", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    mod.onTurnStart("turn-1", "hello");
    mod.onTurnStart("turn-2", "a queued prompt starts the next turn");
    await pumpUntil(mod, () => session.ops("presence").length === 2, "two presences");
    assert.deepEqual(
      session.ops("presence").map((p) => [p.status, p.turnId]),
      [
        ["busy", "turn-1"],
        ["busy", "turn-2"],
      ],
    );
  });

  it("1.1: re-registering after a connector restart mid-turn carries the running turn id", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    mod.onTurnStart("turn-1", "hello");
    await pumpUntil(mod, () => session.ops("presence").length === 1, "presence");
    await ctx.restart(new StubComms(ctx.comms.record));
    await pumpUntil(mod, () => session.ops("register").length >= 2, "re-registration");
    const again = session.ops("register").at(-1)!;
    assert.equal(again.status, "busy");
    assert.equal(again.turnId, "turn-1");
  });

  it("1.1: idle presence and an idle registration carry no turn id", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    assert.equal(session.ops("register")[0].turnId, undefined);
    mod.onTurnStart("turn-1", "hello");
    mod.onTurnComplete({ turnId: "turn-1", reason: "answer", answer: "hi" });
    await pumpUntil(mod, () => session.ops("presence").length === 2, "busy then idle");
    assert.deepEqual(session.ops("presence")[1], { sessionId: "sess-1", status: "idle" });
  });
});

describe("fix pass 1.1: answer-seen", () => {
  /**
   * Follow-up 7: a "never confirms" check proves the queue drained before it asserts. A main-loop
   * proof sent after the case under test must arrive, and be the only one: answer-seen reports go
   * out in order, so anything the case wrongly queued would have been sent first.
   */
  const drainProof = { waitId: "w_drain", messageId: "m_drain", token: "d".repeat(32) };
  async function drained(session: FakeSession, mod: ReturnType<typeof makeMod>): Promise<string[]> {
    mod.onToolResult({ toolUseId: "tu_drain", text: renderAnswerWithProof(drainProof, "@d answered (m_drain):", "ok") });
    await pumpUntil(mod, () => session.ops("answer-seen").some((o) => o.proofs.some((p: { waitId: string }) => p.waitId === "w_drain")), "the main-loop proof sent after it");
    return session.ops("answer-seen").flatMap((o) => o.proofs.map((p: { waitId: string }) => p.waitId));
  }

  async function inTurn(extra: { callTimeoutMs?: number } = {}) {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session, "sess-1", "mod-a", extra);
    await mod.start();
    mod.onTurnStart("turn-1", "ask t3-native");
    return { session, mod };
  }

  it("1.1: a main-loop tool result with a complete proof sends answer-seen with the session, turn and proof", async () => {
    const { session, mod } = await inTurn();
    mod.onToolCall({ toolUseId: "tu_1", tool: "Bash" });
    mod.onToolResult({ toolUseId: "tu_1", text: printed });
    await pumpUntil(mod, () => session.ops("answer-seen").length === 1, "answer-seen");
    assert.deepEqual(session.ops("answer-seen")[0], { sessionId: "sess-1", turnId: "turn-1", proofs: [proof] });
  });

  it("1.1: a helper subagent's tool result never confirms, even with a complete proof", async () => {
    const { session, mod } = await inTurn();
    mod.onToolCall({ toolUseId: "tu_2", tool: "Bash", agentId: "a_helper" });
    mod.onToolResult({ toolUseId: "tu_2", agentId: "a_helper", text: printed });
    assert.deepEqual(await drained(session, mod), ["w_drain"]);
  });

  it("1.1: truncated output (Claude Code's persisted preview, no end line) never confirms", async () => {
    const { session, mod } = await inTurn();
    const preview = `<persisted-output>\nOutput too large (56.4KB). Full output saved to: /tmp/x.txt\n\nPreview (first 2KB):\n${printed.split("\n").slice(0, 4).join("\n")}`;
    mod.onToolResult({ toolUseId: "tu_3", text: preview });
    assert.deepEqual(await drained(session, mod), ["w_drain"]);
  });

  it("1.1: the ids alone (a comms status listing, quoted text) never confirm", async () => {
    const { session, mod } = await inTurn();
    mod.onToolResult({ toolUseId: "tu_4", text: "message m_1 in wait w_1: @t3-native answered\n> Forty-two." });
    mod.onToolResult({ toolUseId: "tu_5", text: printed.split("\n").map((l) => `> ${l}`).join("\n") });
    assert.deepEqual(await drained(session, mod), ["w_drain"]);
  });

  it("1.1: a backgrounded command's tool result never confirms", async () => {
    const { session, mod } = await inTurn();
    mod.onToolCall({ toolUseId: "tu_6", tool: "Bash", background: true });
    mod.onToolResult({ toolUseId: "tu_6", text: "Command running in background with ID: b1. Output is being written to: /tmp/b1.output" });
    assert.deepEqual(await drained(session, mod), ["w_drain"]);
  });

  it("1.1: a tool result with no main turn running sends nothing", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    mod.onToolResult({ toolUseId: "tu_7", text: printed });
    mod.onTurnStart("turn-1", "a later turn");
    assert.deepEqual(await drained(session, mod), ["w_drain"]);
  });

  it("1.1: answer-seen is retried if the connector can't be reached, so a restart inside the window doesn't lose it", async () => {
    const { session, mod } = await inTurn({ callTimeoutMs: 200 });
    session.hangPaths.add("/v1/answer-seen");
    mod.onToolResult({ toolUseId: "tu_8", text: printed });
    await until(() => session.ops("answer-seen").length === 1, "the first attempt");
    session.hangPaths.delete("/v1/answer-seen");
    await pumpUntil(mod, () => session.ops("answer-seen").length >= 2, "the retry");
    assert.deepEqual(session.ops("answer-seen").at(-1), { sessionId: "sess-1", turnId: "turn-1", proofs: [proof] });
  });
});
