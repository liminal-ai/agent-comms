import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasOtherPrompt, Tracker } from "../hooks/core/tracker.ts";

const HEADER = "[agent-comms v1] delivery=d_1 message=m_1 kind=request";
const RENDERED = `${HEADER}\nFrom: @reed (agent), via agent-comms\n> say OK`;
const wrap = (text: string) =>
  `The agent-comms plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;

function started(kind: "request" | "answer" = "request") {
  const t = new Tracker("agent-comms");
  t.submitted({ deliveryId: "d_1", messageId: "m_1", kind, rendered: kind === "request" ? RENDERED : RENDERED.replace("kind=request", "kind=answer"), sessionId: "s", at: 0 });
  return t;
}

describe("Tracker", () => {
  it("finds our turn from the header inside the plugin wrapper and collects the answer", () => {
    const t = started();
    assert.deepEqual(t.turnStart("t1", wrap(RENDERED), 1), [{ type: "delivered", deliveryId: "d_1", turnId: "t1" }]);
    const actions = t.turnComplete({ turnId: "t1", reason: "answer", answer: "OK", at: 2 });
    assert.deepEqual(actions[0], { type: "outcome", deliveryId: "d_1", turnId: "t1", outcome: { outcome: "replied", answer: "OK" } });
  });

  it("ignores turns that don't carry our header, and a header for another delivery", () => {
    const t = started();
    assert.deepEqual(t.turnStart("t0", "hello", 1), []);
    assert.deepEqual(t.turnStart("t1", wrap(RENDERED.replace("d_1", "d_9")), 2), []);
    assert.deepEqual(t.turnComplete({ turnId: "t1", reason: "answer", answer: "x", at: 3 }), []);
  });

  it("delivers an answer delivery and never collects its turn", () => {
    const t = started("answer");
    const text = wrap(RENDERED.replace("kind=request", "kind=answer"));
    assert.deepEqual(t.turnStart("t1", text, 1), [
      { type: "delivered", deliveryId: "d_1", turnId: "t1" },
      { type: "done", deliveryId: "d_1" },
    ]);
    assert.deepEqual(t.turnComplete({ turnId: "t1", reason: "answer", answer: "thanks", at: 2 }), []);
  });

  it("reports aborted, refused and errored turns as failed, and an empty answer as failed", () => {
    for (const reason of ["aborted", "refusal", "error"] as const) {
      const t = started();
      t.turnStart("t1", wrap(RENDERED), 1);
      const [outcome] = t.turnComplete({ turnId: "t1", reason, answer: "", at: 2 });
      assert.deepEqual(outcome, { type: "outcome", deliveryId: "d_1", turnId: "t1", outcome: { outcome: "failed", reason } });
    }
    const t = started();
    t.turnStart("t1", wrap(RENDERED), 1);
    const [outcome] = t.turnComplete({ turnId: "t1", reason: "answer", answer: "  ", at: 2 });
    assert.equal(outcome?.type === "outcome" && outcome.outcome.outcome, "failed");
  });

  it("a subagent's turn.complete is not ours, even with our turn id", () => {
    const t = started();
    t.turnStart("t1", wrap(RENDERED), 1);
    assert.deepEqual(t.turnComplete({ turnId: "t1", agentId: "a1", reason: "answer", answer: "helper says hi", at: 2 }), []);
    const [outcome] = t.turnComplete({ turnId: "t1", reason: "answer", answer: "final", at: 3 });
    assert.deepEqual(outcome, { type: "outcome", deliveryId: "d_1", turnId: "t1", outcome: { outcome: "replied", answer: "final" } });
  });

  it("a task notification for our own background shell or subagent keeps the reply collectable", () => {
    const t = started();
    t.turnStart("t1", wrap(RENDERED), 1);
    t.toolCall({ toolUseId: "toolu_bash", tool: "Bash", background: true });
    t.toolResult({ toolUseId: "toolu_bash", result: { backgroundTaskId: "shell_1" } });
    t.toolCall({ toolUseId: "toolu_agent", tool: "Agent" });
    t.agentSpawned({ agentId: "agent_7", engine: true });
    t.toolResult({ toolUseId: "toolu_agent", result: { agentId: "agent_7" } });
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: "<task-notification>\n<task-id>shell_1</task-id>\n<tool-use-id>toolu_bash</tool-use-id>\n</task-notification>", at: 2 });
    t.taskRow({ id: "shell_1", toolUseId: "toolu_bash" });
    t.taskRow({ id: "shell_1", toolUseId: "toolu_bash" });
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: "<task-notification>\n<task-id>agent_7</task-id>\n</task-notification>", at: 3 });
    t.taskRow({ id: "agent_7" });
    const [outcome] = t.turnComplete({ turnId: "t1", reason: "answer", answer: "done", at: 4 });
    assert.equal(outcome?.type === "outcome" && outcome.outcome.outcome, "replied");
  });

  it("an unlinked task notification makes it ambiguous", () => {
    const t = started();
    t.turnStart("t1", wrap(RENDERED), 1);
    t.toolCall({ toolUseId: "toolu_bash" });
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: "<task-notification>\n<task-id>shell_9</task-id>\n<tool-use-id>toolu_other</tool-use-id>\n</task-notification>", at: 2 });
    t.taskRow({ id: "shell_9", toolUseId: "toolu_other" });
    const [outcome] = t.turnComplete({ turnId: "t1", reason: "answer", answer: "done", at: 3 });
    assert.deepEqual(outcome?.type === "outcome" && outcome.outcome, { outcome: "ambiguous", entered: [{ origin: "task-notification", at: 2 }] });
  });

  it("a prompt typed during our turn is ambiguous", () => {
    const t = started();
    t.turnStart("t1", wrap(RENDERED), 1);
    t.promptSubmit({ turnId: "t1", origin: { kind: "composer" }, text: "also check the logs", at: 2 });
    const [outcome] = t.turnComplete({ turnId: "t1", reason: "answer", answer: "done", at: 3 });
    assert.deepEqual(outcome?.type === "outcome" && outcome.outcome, { outcome: "ambiguous", entered: [{ origin: "composer", at: 2 }] });
  });

  it("input typed during another turn, or while idle, doesn't touch ours", () => {
    const t = started();
    t.promptSubmit({ turnId: "t0", origin: { kind: "composer" }, text: "earlier", at: 0 });
    t.turnStart("t1", wrap(RENDERED), 1);
    t.promptSubmit({ origin: { kind: "composer" }, text: "no turn id", at: 2 });
    t.promptSubmit({ turnId: "t0", origin: { kind: "peer" }, text: "old turn", at: 2 });
    const [outcome] = t.turnComplete({ turnId: "t1", reason: "answer", answer: "ok", at: 3 });
    assert.equal(outcome?.type === "outcome" && outcome.outcome.outcome, "replied");
  });

  it("names the request a later notification of our background work belongs to", () => {
    const t = started();
    t.turnStart("t1", wrap(RENDERED), 1);
    t.toolCall({ toolUseId: "toolu_bg", background: true });
    t.toolCall({ toolUseId: "toolu_fg" });
    t.turnComplete({ turnId: "t1", reason: "answer", answer: "started it", at: 2 });
    const note = (id: string) => `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n</task-notification>`;
    assert.equal(t.followUpFor(note("toolu_bg"))?.messageId, "m_1");
    assert.equal(t.followUpFor(note("toolu_fg")), undefined);
    assert.equal(t.followUpFor(note("toolu_other")), undefined);
  });

  it("a turn that merged someone else's queued prompt with ours is ambiguous", () => {
    const t = started();
    t.turnStart("t1", `fix the tests\n\n${wrap(RENDERED)}`, 1);
    const [outcome] = t.turnComplete({ turnId: "t1", reason: "answer", answer: "ok", at: 2 });
    assert.deepEqual(outcome?.type === "outcome" && outcome.outcome, { outcome: "ambiguous", entered: [{ origin: "merged-prompt", at: 1 }] });
  });
});

describe("hasOtherPrompt", () => {
  it("accepts our rendering alone or inside the wrapper, and flags anything else", () => {
    assert.equal(hasOtherPrompt(RENDERED, RENDERED), false);
    assert.equal(hasOtherPrompt(wrap(RENDERED), RENDERED), false);
    assert.equal(hasOtherPrompt(`${wrap(RENDERED)}\nand one more thing`, RENDERED), true);
    assert.equal(hasOtherPrompt(wrap("something else"), RENDERED), true);
  });
});
