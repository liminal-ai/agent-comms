// The Claude Code sessions adapter on its own, for orderings the socket tests can't force.
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { makePoke } from "../src/adapter.ts";
import { ClaudeCodeSessions } from "../src/claude-code.ts";

const home = { machine: "box", harness: "claude-code" as const, locator: "b" };
const homed = async () => [{ participant: { id: "p_b", name: "b", kind: "agent" as const }, home, state: "active" as const }];
const target = { participant: "b", locator: "b" };
const delivery = {
  id: "d_1",
  message: { id: "m_1", kind: "request", createdAt: 1, text: "q" },
  status: { state: "delivered" },
} as never;

describe("acceptance 11a: a session superseded right after it reported delivered", () => {
  it("the outcome isn't awaited from the new session (which never ran the turn): it's lost, so recovery asks", async () => {
    const sessions = new ClaudeCodeSessions({ pollWaitMs: 1_000, homed, presence: () => {}, poke: makePoke() });
    await sessions.register({ participant: "b", harness: "claude-code", sessionId: "old", cwd: "/", status: "busy" });
    sessions.delivered({ sessionId: "old", deliveryId: "d_1", turnId: "t-old" });
    // The new session registers before the dispatcher starts waiting for the turn's outcome.
    await sessions.register({ participant: "b", harness: "claude-code", sessionId: "new", cwd: "/", status: "idle" });
    const outcome = await Promise.race([
      Effect.runPromise(sessions.adapter.awaitOutcome(target, delivery, "t-old")),
      new Promise((r) => setTimeout(() => r("still waiting"), 500)),
    ]);
    expect(outcome).toMatchObject({ _tag: "lost" });
  });
});
