// Capabilities fix pass follow-up, the web view's item 6.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conversationReadKey } from "../src/lib/view.ts";

const page = (from: number, to: number) => ({ messages: Array.from({ length: to - from + 1 }, (_, i) => ({ message: { id: `m_${from + i}`, seq: from + i } })) });

describe("follow-up 6: an open conversation past 100 messages", () => {
  it("6: a new message changes the read key even when the view still holds 100 messages", () => {
    // The view returns the latest 100: messages 101-200, then 102-201 once #201 arrives.
    assert.notEqual(conversationReadKey(page(102, 201)), conversationReadKey(page(101, 200)));
  });
  it("6: the key doesn't change when nothing new arrived, and is undefined before the view loads", () => {
    assert.equal(conversationReadKey(page(101, 200)), conversationReadKey(page(101, 200)));
    assert.equal(conversationReadKey(undefined), undefined);
  });
});
