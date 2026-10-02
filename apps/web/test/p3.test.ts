// Capabilities fix pass, Reed's P3 list: the web view's bugs 7 and 8.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Alert } from "@agent-comms/protocol";
import { alertsView, defaultPostingAs } from "../src/lib/view.ts";

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const alert = (id: string, openedAt: number, resolvedAt?: number): Alert => ({
  id,
  cause: "connector-silent",
  subject: { kind: "machine", id: "m1" },
  owner: { id: "p_lee", name: "lee", kind: "human" },
  messageId: `m_${id}`,
  conversationId: "c_alerts",
  openedAt,
  ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  summary: id,
});

describe("P3 bug 7: an old open alert stays visible", () => {
  it("7: an open incident older than the newest 100 is still in the badge and the open list", () => {
    const old = alert("a_old", NOW - 9 * 86_400_000);
    const recent = Array.from({ length: 100 }, (_, i) => alert(`a_${i}`, NOW - i * 60_000, NOW - i * 60_000 + 30_000));
    const v = alertsView([old], recent);
    assert.equal(v.badge, "Alerts (1)");
    assert.deepEqual(v.open.map((a) => a.id), ["a_old"]);
    assert.equal(v.resolved.length, 100);
  });

  it("7: an open alert in both lists is listed once; the badge counts open incidents only", () => {
    const a = alert("a_1", NOW - 60_000);
    const v = alertsView([a], [a, alert("a_2", NOW - 120_000, NOW - 90_000)]);
    assert.deepEqual(v.open.map((x) => x.id), ["a_1"]);
    assert.deepEqual(v.resolved.map((x) => x.id), ["a_2"]);
    assert.equal(v.badge, "Alerts (1)");
  });
});

describe("P3 bug 8: no phantom @lee", () => {
  const people = (...names: [string, string][]) => names.map(([name, state]) => ({ name, kind: "human", state }));
  it("8: with no @lee, posting as defaults to the first active person", () => {
    assert.equal(defaultPostingAs(null, people(["pat", "active"])), "pat");
  });
  it("8: a saved choice that's no longer an active person isn't kept", () => {
    assert.equal(defaultPostingAs("gone", people(["lee", "active"], ["gone", "retired"])), "lee");
  });
  it("8: @lee is still the default when it exists, and a saved active person wins", () => {
    assert.equal(defaultPostingAs(null, people(["pat", "active"], ["lee", "active"])), "lee");
    assert.equal(defaultPostingAs("pat", people(["pat", "active"], ["lee", "active"])), "pat");
  });
  it("8: before the directory has loaded, the saved choice is kept", () => {
    assert.equal(defaultPostingAs("pat", []), "pat");
  });
});
