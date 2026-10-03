// The V2 client's wire slice: protocol-2 snapshots and events narrowed to what the adapter
// reads. Shapes from v0.0.46 contracts (orchestrationV2.ts OrchestrationV2ThreadStreamItem).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slice, toEvent, toItem } from "../src/v2/client.ts";

const runId = "run:thread:th1:ordinal:1";
const projection = {
  thread: { id: "th1" },
  runs: [{ id: runId, ordinal: 1, userMessageId: "comms-d_1", status: "completed", providerInstanceId: "claudeAgent" }],
  attempts: [{ id: "a1", runId, attemptOrdinal: 1, reason: "initial", status: "completed" }],
  messages: [
    { id: "comms-d_1", role: "user", runId, text: "the delivery text", streaming: false },
    { id: "lee-1", role: "user", runId, text: "Lee's private words", streaming: false },
    { id: "asst-1", role: "assistant", runId, text: "4", streaming: false },
  ],
  turnItems: [
    { type: "user_message", runId, ordinal: 1, messageId: "comms-d_1", text: "the delivery text", inputIntent: "turn_start" },
    { type: "command_execution", runId, ordinal: 2, input: "comms send", status: "completed" },
    { type: "assistant_message", runId, ordinal: 3, messageId: "asst-1", text: "4", streaming: false },
    { type: "error", runId, ordinal: 4, failure: { class: "provider", message: "provider crashed" } },
  ],
};

describe("T3 V2 wire slice", () => {
  it("a snapshot keeps runs, attempts, message ids and runs, assistant text and errors; never user text", () => {
    const thread = slice("th1", projection as never, 42);
    assert.deepEqual(thread, {
      id: "th1",
      snapshotSequence: 42,
      runs: [{ id: runId, ordinal: 1, userMessageId: "comms-d_1", status: "completed" }],
      attempts: [{ runId, reason: "initial" }],
      messages: [
        { id: "comms-d_1", role: "user", runId },
        { id: "lee-1", role: "user", runId },
        { id: "asst-1", role: "assistant", runId },
      ],
      answers: [{ runId, messageId: "asst-1", ordinal: 3, streaming: false, text: "4" }],
      errors: [{ runId, message: "provider crashed" }],
    });
    assert.doesNotMatch(JSON.stringify(thread), /private|delivery text/);
  });

  it("stream items: snapshot, events, synchronized; unknown event types advance the cursor as other", () => {
    assert.equal(toItem("th1", { kind: "snapshot", snapshotSequence: 7, projection } as never)?.kind, "snapshot");
    assert.deepEqual(toItem("th1", { kind: "synchronized" }), { kind: "synchronized" });
    assert.deepEqual(toItem("th1", { kind: "event", sequence: 9, event: { type: "thread.pinned-somewhere-new", payload: {} } }), {
      kind: "event",
      event: { type: "other", sequence: 9 },
    });
    assert.deepEqual(toEvent(10, { type: "run.updated", payload: projection.runs[0] }), {
      type: "run",
      sequence: 10,
      run: { id: runId, ordinal: 1, userMessageId: "comms-d_1", status: "completed" },
    });
    assert.deepEqual(toEvent(11, { type: "message.updated", payload: projection.messages[1] }), {
      type: "message",
      sequence: 11,
      message: { id: "lee-1", role: "user", runId },
    });
    assert.deepEqual(toEvent(12, { type: "turn-item.updated", payload: { ...projection.turnItems[2], streaming: true, text: "4 an" } }), {
      type: "answer",
      sequence: 12,
      answer: { runId, messageId: "asst-1", ordinal: 3, streaming: true, text: "4 an" },
    });
    assert.deepEqual(toEvent(13, { type: "run-attempt.created", payload: { runId, reason: "steering_restart" } }), {
      type: "attempt",
      sequence: 13,
      attempt: { runId, reason: "steering_restart" },
    });
    assert.deepEqual(toEvent(14, { type: "turn-item.updated", payload: projection.turnItems[0] }), { type: "other", sequence: 14 });
  });
});
