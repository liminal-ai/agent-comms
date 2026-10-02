// Prints a waiting send's output with proof markers, as the CLI will (renderAnswerWithProof).
// Usage: node fake-answer.ts <case> where case is small | blank-lines | big
import { renderAnswerWithProof } from "/srv/agents/hazel/agent-comms/packages/protocol/src/proof.ts";
const c = process.argv[2] ?? "small";
const token = c === "mid" ? "d".repeat(32) : c === "edge" ? "e".repeat(32) : c === "big" ? "b".repeat(32) : c === "blank-lines" ? "c".repeat(32) : "a".repeat(32);
const text =
  c === "mid" ? Array.from({ length: 300 }, (_, i) => `line ${i} ` + "y".repeat(90)).join("\n")
  : c === "edge" ? Array.from({ length: 280 }, (_, i) => `line ${i} ` + "z".repeat(90)).join("\n")
  : c === "big" ? Array.from({ length: 800 }, (_, i) => `line ${i} ` + "x".repeat(60)).join("\n")
  : c === "blank-lines" ? "First paragraph.\n\nSecond paragraph, trailing spaces   \n\tA tabbed line.\n"
  : "The answer is forty-two.";
console.log(`sent m_q (#1 in c_1), waiting up to 100s for @t3-native`);
console.log(renderAnswerWithProof({ waitId: "w_" + c, messageId: "m_" + c, token }, `@t3-native answered (m_${c}):`, text));
