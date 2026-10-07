import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { it } from "node:test";
import { writeOutput } from "../src/output.ts";

it("a stalled stdout consumer backpressures completion until bytes drain", async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  let finished = false;
  const write = writeOutput(stream, "response payload").then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.ok(stream.writableLength > 0);
  assert.equal(stream.read()?.toString(), "response payload");
  await write;
  assert.equal(finished, true);
  stream.destroy();
});

it("a closed consumer rejects a stalled write rather than leaking the wait", async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  const write = writeOutput(stream, "response payload");
  const rejected = assert.rejects(write, /output closed/);
  stream.destroy();
  await rejected;
  await assert.rejects(writeOutput(stream, "later"), /output is closed/);
});

it("write callback errors reject without a later unhandled stream error", async () => {
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("output failed")); } });
  await assert.rejects(writeOutput(stream, "reply"), /output failed/);
  await new Promise(resolve => setImmediate(resolve));
});
