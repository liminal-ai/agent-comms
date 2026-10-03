// rv2: the fallback pass reads the oldest 500 `answered` rows and skips those not yet due.
import { ACK_WINDOW_MS } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-02T12:00:00Z").getTime();
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => vi.useRealTimers());

it("500 not-yet-due answered rows (long group waits still running) starve a due fallback", async () => {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const n of ["a", "b"]) await t.mutation(api.directory.promote, { adminToken: ADMIN, name: n, kind: "agent", owner: "lee", home: { machine: "m1", harness: "claude-code", locator: n } });
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  // The due one: a single wait, answered at NOW, ended at NOW.
  const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", wait: true, waitMs: 9 * 60_000 } as never);
  const due = sent.deliveries[0]!.id;
  // 500 answered results with an older `at`, in a wait that's still running (until in an hour, CLI checking in).
  await t.run(async (ctx) => {
    const d = (await ctx.db.get(due as never)) as any;
    const w = await ctx.db.insert("waits", { waiterId: d.recipientId, messageId: d.messageId, until: NOW + 60 * 60_000, active: true, lastAwaitAt: NOW + 10 * 60_000, inInboxIds: [], createdAt: NOW - 1 });
    for (let i = 0; i < 500; i++) await ctx.db.insert("waitResults", { waitId: w, recipientId: d.recipientId, deliveryId: d._id, state: "answered", at: NOW - 1 });
  });
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: due });
  await t.mutation(api.connector.delivered, { machine: m1, deliveryId: due, claimId: claim.claimId, turnId: "tb" });
  const got = await t.mutation(api.connector.collect, { machine: m1, deliveryId: due, claimId: claim.claimId, turnId: "tb", answer: "4" });
  vi.setSystemTime(new Date(NOW + ACK_WINDOW_MS + 60_000));
  await t.mutation(internal.waits.sweep, {});
  const fb = await t.run(async (ctx) => (await ctx.db.query("deliveries").withIndex("by_message", (q) => q.eq("messageId", got.answerMessageId as never)).collect()).filter((x) => x.fallback).length);
  expect(fb, "the due answer should have fallen back").toBe(1);
});
