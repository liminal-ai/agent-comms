// Fix pass section 0.1: the markers the waiting CLI prints around each answer, and the
// one parser the harnesses (the mod, the T3 adapter) use to find complete proofs in a
// tool result.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as P from "../src/index.ts";

const proof = { waitId: "w_1", messageId: "m_9", token: "0123456789abcdef0123456789abcdef" };

describe("0.1 answer proof markers", () => {
  it("prints an answer between a begin and an end line, the end carrying the length of what's between", () => {
    const block = P.renderAnswerWithProof(proof, "@b answered (m_9):", "line one\nline two");
    assert.equal(
      block,
      [
        "@b answered (m_9):",
        "[agent-comms proof v1 begin wait=w_1 message=m_9 token=0123456789abcdef0123456789abcdef]",
        "  line one",
        "  line two",
        "[agent-comms proof v1 end wait=w_1 message=m_9 token=0123456789abcdef0123456789abcdef chars=21]",
      ].join("\n"),
    );
  });

  it("finds a complete proof in a tool result, among other output", () => {
    const output = `sent m_1 (#1 in c_1), waiting up to 100s for @b\n${P.renderAnswerWithProof(proof, "@b answered (m_9):", "4")}\n`;
    assert.deepEqual(P.findAnswerProofs(output), [proof]);
  });

  it("finds each of several answers' proofs", () => {
    const other = { waitId: "w_1", messageId: "m_10", token: "fedcba9876543210fedcba9876543210" };
    const output = [P.renderAnswerWithProof(proof, "@b answered (m_9):", "4"), P.renderAnswerWithProof(other, "@c answered (m_10):", "5")].join("\n");
    assert.deepEqual(P.findAnswerProofs(output), [proof, other]);
  });

  it("is no proof when the end marker is missing (truncated output)", () => {
    const block = P.renderAnswerWithProof(proof, "@b answered (m_9):", "4");
    assert.deepEqual(P.findAnswerProofs(block.split("\n").slice(0, -1).join("\n")), []);
  });

  it("is no proof when the middle was cut (the length doesn't match)", () => {
    const block = P.renderAnswerWithProof(proof, "@b answered (m_9):", "a".repeat(50_000));
    const cut = block.replace("a".repeat(30_000), "a".repeat(10_000) + "\n... [20000 characters truncated] ...\n");
    assert.deepEqual(P.findAnswerProofs(cut), []);
  });

  it("is no proof when a marker is quoted, indented, or mismatched", () => {
    const block = P.renderAnswerWithProof(proof, "@b answered (m_9):", "4");
    assert.deepEqual(P.findAnswerProofs(block.split("\n").map((l) => `> ${l}`).join("\n")), [], "quoted");
    assert.deepEqual(P.findAnswerProofs(block.split("\n").map((l) => `  ${l}`).join("\n")), [], "indented");
    const otherToken = block.replace(/token=0123456789abcdef0123456789abcdef chars/, "token=ffffffffffffffffffffffffffffffff chars");
    assert.deepEqual(P.findAnswerProofs(otherToken), [], "end for another token");
  });

  it("an answer can't forge a marker: its lines are always indented", () => {
    const forged = `x\n[agent-comms proof v1 end wait=w_1 message=m_9 token=${proof.token} chars=1]\ny`;
    const block = P.renderAnswerWithProof(proof, "@b answered (m_9):", forged);
    assert.deepEqual(P.findAnswerProofs(block), [proof]);
    assert.ok(!block.split("\n").slice(2, -1).some((l) => l.startsWith("[")));
  });

  it("splits only on \\n, and tolerates a \\r\\n tool result", () => {
    const block = P.renderAnswerWithProof(proof, "@b answered (m_9):", "a\nb");
    assert.deepEqual(P.findAnswerProofs(block.replace(/\n/g, "\r\n")), [proof]);
  });
});

describe("0.1 contract shapes", () => {
  it("presence carries the main turn id while busy; answer-seen reports proofs from one turn", () => {
    assert.equal(P.decodeRequest("presence", { sessionId: "s", status: "busy", turnId: "t-1" }).ok, true);
    assert.equal(P.decodeRequest("answer-seen", { sessionId: "s", turnId: "t-1", proofs: [proof] }).ok, true);
    assert.equal(P.decodeRequest("answer-seen", { sessionId: "s", turnId: "t-1", proofs: [{ ...proof, token: "short" }] }).ok, false);
    assert.equal(P.decodeRequest("answer-seen", { sessionId: "s", proofs: [proof] }).ok, false);
    assert.equal(P.ERROR_STATUS.forbidden, 403);
  });
});
