// RunTracker: a snapshot loaded out of band isn't undone by older stream events.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunTracker } from "../src/v2/model.ts";
import type { V2Event, V2Thread } from "../src/v2/model.ts";

const runId = "run:thread:th1:ordinal:1";
const thread = (status: string, snapshotSequence: number) =>
  ({ id: "th1", snapshotSequence, runs: [{ id: runId, ordinal: 1, userMessageId: "m1", status }], attempts: [], messages: [], answers: [], errors: [] }) as unknown as V2Thread;
const runEvent = (status: string, sequence: number) => ({ type: "run", sequence, run: { id: runId, ordinal: 1, userMessageId: "m1", status } }) as unknown as V2Event;

describe("RunTracker", () => {
  it("ignores stream events at or below a loaded snapshot's sequence", () => {
    const t = new RunTracker("m1");
    t.load(thread("completed", 10));
    t.feed(runEvent("running", 9));
    assert.equal(t.status, "completed");
    t.feed(runEvent("running", 10));
    assert.equal(t.status, "completed");
  });

  it("applies newer events", () => {
    const t = new RunTracker("m1");
    t.load(thread("running", 5));
    t.feed(runEvent("completed", 6));
    assert.equal(t.status, "completed");
    assert.equal(t.lastSequence, 6);
  });
});
