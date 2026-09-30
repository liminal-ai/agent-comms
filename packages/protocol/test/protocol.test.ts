import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundHistory, decodeRequest, isOp, OPS, parseResponse, socketPath } from "../src/index.ts";
import { message } from "./fixtures.ts";

describe("boundHistory", () => {
  const unread = [3, 1, 5, 2, 4].map((seq) => message({ seq, text: "x".repeat(10) }));

  it("keeps the newest messages, oldest first, and counts the rest", () => {
    const h = boundHistory(unread, { maxMessages: 2, maxChars: 1000 });
    assert.deepEqual(h.messages.map((m) => m.seq), [4, 5]);
    assert.equal(h.omitted, 3);
  });

  it("stops at the character cap", () => {
    const h = boundHistory(unread, { maxMessages: 10, maxChars: 25 });
    assert.deepEqual(h.messages.map((m) => m.seq), [4, 5]);
    assert.equal(h.omitted, 3);
  });

  it("clips the newest message rather than showing nothing", () => {
    const h = boundHistory([message({ seq: 1, text: "y".repeat(100) })], { maxMessages: 5, maxChars: 20 });
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0]!.text.length, 20);
    assert.ok(h.messages[0]!.text.endsWith(" […]"));
    assert.equal(h.omitted, 0);
  });

  it("handles no unread messages", () => {
    assert.deepEqual(boundHistory([]), { messages: [], omitted: 0 });
  });
});

describe("socketPath", () => {
  it("prefers the override, then XDG_RUNTIME_DIR, then /run/user/<uid> on Linux", () => {
    assert.equal(socketPath({ platform: "linux", override: "/tmp/s.sock", xdgRuntimeDir: "/run/user/1" }), "/tmp/s.sock");
    assert.equal(socketPath({ platform: "linux", xdgRuntimeDir: "/run/user/1000" }), "/run/user/1000/agent-comms/connector.sock");
    assert.equal(socketPath({ platform: "linux", uid: 1000 }), "/run/user/1000/agent-comms/connector.sock");
    assert.equal(socketPath({ platform: "linux" }), null);
  });

  it("uses ~/.agent-comms on macOS", () => {
    assert.equal(socketPath({ platform: "darwin", home: "/Users/lee" }), "/Users/lee/.agent-comms/connector.sock");
  });
});

describe("decodeRequest", () => {
  it("knows every operation", () => {
    assert.deepEqual(OPS, [
      "status", "register", "unregister", "poll", "delivered", "outcome",
      "check-result", "presence", "send", "reply", "read", "list",
    ]);
    assert.equal(isOp("send"), true);
    assert.equal(isOp("toString"), false);
  });

  it("accepts a valid send and drops unknown fields", () => {
    const r = decodeRequest("send", { as: "cedar", to: ["reed"], text: "hi", extra: 1 });
    assert.deepEqual(r, { ok: true, value: { as: "cedar", to: ["reed"], text: "hi" } });
  });

  it("names the failing path", () => {
    assert.deepEqual(decodeRequest("send", { as: "Cedar", to: [], text: "hi" }), {
      ok: false,
      error: "as: expected a participant name (lowercase [a-z0-9_-], 1-48)",
    });
    const r = decodeRequest("send", { as: "cedar", to: ["reed", 3], text: "hi" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /^to\[1\]:/);
    assert.equal(decodeRequest("send", { as: "cedar", to: [], text: "" }).ok, false);
  });

  it("bounds poll waits", () => {
    assert.equal(decodeRequest("poll", { sessionId: "s-1", waitMs: 25_000 }).ok, true);
    assert.equal(decodeRequest("poll", { sessionId: "s-1", waitMs: 25_001 }).ok, false);
  });

  it("decodes each outcome kind", () => {
    const head = { sessionId: "s-1", deliveryId: "d_1", turnId: "t-1" };
    assert.deepEqual(decodeRequest("outcome", { ...head, outcome: "replied", answer: "done" }), {
      ok: true,
      value: { ...head, outcome: "replied", answer: "done" },
    });
    assert.equal(decodeRequest("outcome", { ...head, outcome: "ambiguous", entered: [{ origin: "composer" }] }).ok, true);
    assert.equal(decodeRequest("outcome", { ...head, outcome: "failed", reason: "aborted" }).ok, true);
    assert.equal(decodeRequest("outcome", { ...head, outcome: "failed", reason: "bored" }).ok, false);
    assert.equal(decodeRequest("outcome", { ...head, outcome: "maybe" }).ok, false);
    assert.equal(decodeRequest("outcome", { outcome: "replied", answer: "x" }).ok, false);
  });

  it("decodes check results", () => {
    const head = { sessionId: "s-1", deliveryId: "d_1" };
    assert.deepEqual(decodeRequest("check-result", { ...head, found: "yes", turnId: "t", turn: "running" }), {
      ok: true,
      value: { ...head, found: "yes", turnId: "t", turn: "running" },
    });
    assert.deepEqual(
      decodeRequest("check-result", { ...head, found: "yes", turnId: "t", turn: "completed", outcome: "replied", answer: "a" }),
      { ok: true, value: { ...head, found: "yes", turnId: "t", turn: "completed", outcome: { outcome: "replied", answer: "a" } } },
    );
    assert.equal(decodeRequest("check-result", { ...head, found: "yes", turnId: "t", turn: "completed", outcome: "maybe" }).ok, false);
    assert.equal(decodeRequest("check-result", { ...head, found: "no" }).ok, true);
    assert.equal(decodeRequest("check-result", { ...head, found: "unknown", detail: "resumed" }).ok, true);
  });
});

describe("parseResponse", () => {
  it("passes success and coded errors through", () => {
    assert.deepEqual(parseResponse(200, '{"ok":true,"items":[]}'), { ok: true, items: [] });
    assert.deepEqual(parseResponse(409, '{"ok":false,"error":{"code":"poll_in_progress","message":"one at a time"}}'), {
      ok: false,
      error: { code: "poll_in_progress", message: "one at a time" },
    });
  });

  it("turns anything else into an internal error", () => {
    assert.equal(parseResponse(502, "<html>").ok, false);
    const r = parseResponse(500, '{"ok":false,"error":{"code":"weird"}}');
    assert.deepEqual(r, { ok: false, error: { code: "internal", message: "HTTP 500" } });
  });
});

describe("contract changes from Hazel's review", () => {
  it("lets only a failed outcome omit turnId", () => {
    const head = { sessionId: "s-1", deliveryId: "d_1" };
    assert.equal(decodeRequest("outcome", { ...head, outcome: "failed", reason: "rejected", detail: "prompt dropped" }).ok, true);
    const r = decodeRequest("outcome", { ...head, outcome: "replied", answer: "x" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /^turnId:/);
  });

  it("accepts over-long answers and clips them on collection", async () => {
    const { clipAnswer, MAX_TEXT_CHARS } = await import("../src/index.ts");
    const long = "x".repeat(MAX_TEXT_CHARS + 500);
    assert.equal(decodeRequest("outcome", { sessionId: "s", deliveryId: "d", turnId: "t", outcome: "replied", answer: long }).ok, true);
    const clipped = clipAnswer(long);
    assert.equal(clipped.length, MAX_TEXT_CHARS);
    assert.match(clipped, /\[… clipped by agent-comms: \d+ more characters\]$/);
    assert.equal(clipAnswer("short"), "short");
  });

  it("lets a completed check omit the outcome (an answer's delivery)", () => {
    const r = decodeRequest("check-result", { sessionId: "s", deliveryId: "d", found: "yes", turnId: "t", turn: "completed" });
    assert.deepEqual(r, { ok: true, value: { sessionId: "s", deliveryId: "d", found: "yes", turnId: "t", turn: "completed" } });
  });
});
