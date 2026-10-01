// Fix pass 1, section 1 (docs/03-fix-pass.md): one test per item, written to
// fail before the fix. Event shapes are the ones Claude Code 2.1.286 produced
// live (task-notification text, Agent/Bash tool results, agent.spawn, the
// subagent hand-back frame).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Tracker } from "../hooks/core/tracker.ts";

const HEADER = "[agent-comms v1] delivery=d_1 message=m_1 kind=request";
const RENDERED = `${HEADER}\nFrom: @reed (agent), via agent-comms\n> say OK`;
const wrap = (text: string) =>
  `The agent-comms plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;

const notification = (task: { taskId: string; toolUseId?: string }) =>
  [
    "<task-notification>",
    `<task-id>${task.taskId}</task-id>`,
    ...(task.toolUseId ? [`<tool-use-id>${task.toolUseId}</tool-use-id>`] : []),
    `<output-file>/tmp/x/tasks/${task.taskId}.output</output-file>`,
    "<status>completed</status>",
    "<summary>done</summary>",
    "</task-notification>",
  ].join("\n");

const handBack = (agentId: string, report: string) =>
  `<agent-message from="${agentId}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:\n  ${report}\n</agent-message>`;

function ourTurn() {
  const t = new Tracker("agent-comms");
  t.submitted({ deliveryId: "d_1", messageId: "m_1", kind: "request", rendered: RENDERED, sessionId: "s", at: 0 });
  t.turnStart("t1", wrap(RENDERED), 1);
  return t;
}

/** Our main turn starts a background shell and a background helper (results as 2.1.286 reports them). */
function startOurWork(t: Tracker) {
  t.toolCall({ toolUseId: "toolu_bash", tool: "Bash", background: true });
  t.toolResult?.({ toolUseId: "toolu_bash", result: { stdout: "", backgroundTaskId: "bshell1" } });
  t.toolCall({ toolUseId: "toolu_agent", tool: "Agent" });
  t.agentSpawned?.({ agentId: "a_ours", engine: true });
  t.toolResult?.({ toolUseId: "toolu_agent", result: { isAsync: true, status: "async_launched", agentId: "a_ours" } });
}

const outcomeOf = (actions: ReturnType<Tracker["turnComplete"]>) => {
  const a = actions.find((x) => x.type === "outcome");
  return a?.type === "outcome" ? a.outcome : undefined;
};

describe("1.5 notifications are linked by identity only", () => {
  it("1.5: a foreign notification is other input even when our rows outnumber notifications (Wrenn B1)", () => {
    const t = ourTurn();
    startOurWork(t);
    // One notification reports both of our tasks; both rows are drawn.
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: notification({ taskId: "bshell1", toolUseId: "toolu_bash" }) + "\n" + notification({ taskId: "a_ours" }), at: 2 });
    t.taskRow({ id: "bshell1", toolUseId: "toolu_bash" });
    t.taskRow({ id: "a_ours", toolUseId: "toolu_agent" });
    // Then a task Lee started in an earlier turn notifies into ours.
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: notification({ taskId: "bleeold", toolUseId: "toolu_lee" }), at: 3 });
    t.taskRow({ id: "bleeold", toolUseId: "toolu_lee" });
    const outcome = outcomeOf(t.turnComplete({ turnId: "t1", reason: "answer", answer: "did both things", at: 4 }));
    assert.equal(outcome?.outcome, "ambiguous");
  });

  it("1.5: our background shell's notification is ours by its tool-use id, with no row drawn (headless)", () => {
    const t = ourTurn();
    startOurWork(t);
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: notification({ taskId: "bshell1", toolUseId: "toolu_bash" }), at: 2 });
    const outcome = outcomeOf(t.turnComplete({ turnId: "t1", reason: "answer", answer: "shell done", at: 3 }));
    assert.deepEqual(outcome, { outcome: "replied", answer: "shell done" });
  });

  it("1.5: a notification naming no id at all is other input", () => {
    const t = ourTurn();
    startOurWork(t);
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: "<task-notification><status>completed</status></task-notification>", at: 2 });
    const outcome = outcomeOf(t.turnComplete({ turnId: "t1", reason: "answer", answer: "x", at: 3 }));
    assert.equal(outcome?.outcome, "ambiguous");
  });
});

describe("1.6 only helpers our turn started", () => {
  it("1.6: a helper Lee started before our turn, finishing during it, is other input", () => {
    const t = new Tracker("agent-comms");
    // Lee's turn starts a background helper.
    t.turnStart("t0", "run a long helper in the background", 0);
    t.toolCall({ toolUseId: "toolu_lee_agent", tool: "Agent" });
    t.agentSpawned?.({ agentId: "a_lee", engine: true });
    t.toolResult?.({ toolUseId: "toolu_lee_agent", result: { agentId: "a_lee", status: "async_launched" } });
    t.turnComplete({ turnId: "t0", reason: "answer", answer: "started", at: 1 });
    // Our delivery runs; Lee's helper keeps working and finishes inside our turn.
    t.submitted({ deliveryId: "d_1", messageId: "m_1", kind: "request", rendered: RENDERED, sessionId: "s", at: 2 });
    t.turnStart("t1", wrap(RENDERED), 3);
    t.toolCall({ toolUseId: "toolu_lee_inner", tool: "Bash", agentId: "a_lee" });
    t.turnComplete({ turnId: "t_lee_sub", agentId: "a_lee", reason: "answer", answer: "lee's helper result", at: 4 });
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: notification({ taskId: "a_lee" }), at: 5 });
    t.taskRow({ id: "a_lee", toolUseId: "toolu_lee_agent" });
    const outcome = outcomeOf(t.turnComplete({ turnId: "t1", reason: "answer", answer: "both", at: 6 }));
    assert.equal(outcome?.outcome, "ambiguous");
  });

  it("1.6: our helper, and a helper it spawns, are ours", () => {
    const t = ourTurn();
    startOurWork(t);
    // Inside our helper: a nested Agent call spawning a child.
    t.toolCall({ toolUseId: "toolu_nested", tool: "Agent", agentId: "a_ours" });
    t.agentSpawned?.({ agentId: "a_child", parentAgentId: "a_ours", engine: true });
    t.toolResult?.({ toolUseId: "toolu_nested", result: { agentId: "a_child" } });
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: notification({ taskId: "a_child" }), at: 2 });
    t.promptSubmit({ turnId: "t1", origin: { kind: "task-notification" }, text: notification({ taskId: "a_ours" }), at: 3 });
    const outcome = outcomeOf(t.turnComplete({ turnId: "t1", reason: "answer", answer: "ok", at: 4 }));
    assert.deepEqual(outcome, { outcome: "replied", answer: "ok" });
  });

  it("1.6: our helper's hand-back is ours; a hand-back from someone else's helper is other input", () => {
    const ours = ourTurn();
    startOurWork(ours);
    ours.promptSubmit({ turnId: "t1", origin: { kind: "peer" }, text: handBack("a_ours", "4"), at: 2 });
    assert.equal(outcomeOf(ours.turnComplete({ turnId: "t1", reason: "answer", answer: "4", at: 3 }))?.outcome, "replied");

    const foreign = ourTurn();
    startOurWork(foreign);
    foreign.promptSubmit({ turnId: "t1", origin: { kind: "peer" }, text: handBack("a_other", "secret"), at: 2 });
    assert.equal(outcomeOf(foreign.turnComplete({ turnId: "t1", reason: "answer", answer: "x", at: 3 }))?.outcome, "ambiguous");
  });
});

describe("1.7 no queued-prompt guess", () => {
  it("1.7: typed input with our turn id is other input, even if the next turn's text contains it (Alder: yes/yesterday)", () => {
    const t = ourTurn();
    t.promptSubmit({ turnId: "t1", origin: { kind: "composer" }, text: "yes", at: 2 });
    const done = t.turnComplete({ turnId: "t1", reason: "answer", answer: "done", at: 3 });
    const late = t.turnStart("t2", "what happened yesterday?", 4);
    const outcome = outcomeOf(done) ?? outcomeOf(late);
    assert.deepEqual(outcome, { outcome: "ambiguous", entered: [{ origin: "composer", at: 2 }] });
  });

  it("1.7: peer, bridge, sdk and another plugin's prompts with our turn id are other input", () => {
    for (const origin of [{ kind: "peer" }, { kind: "bridge" }, { kind: "sdk" }, { kind: "plugin", name: "other" }]) {
      const t = ourTurn();
      t.promptSubmit({ turnId: "t1", origin, text: "hello", at: 2 });
      const outcome = outcomeOf(t.turnComplete({ turnId: "t1", reason: "answer", answer: "ok", at: 3 }));
      assert.equal(outcome?.outcome, "ambiguous", origin.kind);
    }
  });
});

describe("1.9 more than 50 entered inputs", () => {
  it("1.9: the report stays within the protocol's 50 and says how many more", () => {
    const t = ourTurn();
    for (let i = 0; i < 60; i++) t.promptSubmit({ turnId: "t1", origin: { kind: "composer" }, text: `x${i}`, at: 2 + i });
    const outcome = outcomeOf(t.turnComplete({ turnId: "t1", reason: "answer", answer: "ok", at: 100 }));
    assert.equal(outcome?.outcome, "ambiguous");
    const entered = outcome?.outcome === "ambiguous" ? outcome.entered : [];
    assert.equal(entered.length, 50);
    assert.equal(entered.at(-1)?.origin, "+11 more");
  });
});
