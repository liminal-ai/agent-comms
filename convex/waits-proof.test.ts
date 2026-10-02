// Fix pass 1.1 (contract 0.1, 0.2): an answer is acknowledged only when the harness
// confirms the waiting command's own output reached the main model in the turn that ran
// it; the fallback window runs from when the wait ended. Includes Reed's and Alder's
// reproductions (validation/capabilities-fix/repros/), inverted.

import { ACK_WINDOW_MS, WAIT_HELD_MS } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-02T12:00:00Z").getTime();

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const [name, harness] of [["a", "claude-code"], ["b", "t3"], ["c", "t3"]] as const) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: { machine: "m1", harness, locator: `loc-${name}` } });
  }
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;

const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const sweep = (t: T) => t.mutation(internal.waits.sweep, {});
const awaitWait = (t: T, as: string, messageId: string) => t.mutation(api.connector.awaitWait, { machine: m1, as, messageId });
const status = (t: T, as: string, messageId: string) => t.query(api.connector.messageStatus, { machine: m1, as, messageId });
const seen = (t: T, as: string, turnId: string, proofs: { waitId: string; messageId: string; token: string }[]) =>
  t.mutation(api.connector.answerSeen, { machine: m1, as, turnId, proofs });
const deliveriesOf = (t: T, messageId: string) =>
  t.run(async (ctx) => ctx.db.query("deliveries").withIndex("by_message", (q) => q.eq("messageId", messageId as never)).collect());

async function sendWaiting(t: T, as: string, to: string[], extra: Record<string, unknown> = {}) {
  return t.mutation(api.connector.send, { machine: m1, as, to, text: "q", wait: true, waitMs: 9 * 60_000, ...extra } as never);
}
async function answer(t: T, deliveryId: string, text: string) {
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId });
  await t.mutation(api.connector.delivered, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `turn-${deliveryId}` });
  return t.mutation(api.connector.collect, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `turn-${deliveryId}`, answer: text });
}
/** The waiter's answered results as its CLI sees them (await), with their proofs. */
async function proofs(t: T, as: string, messageId: string) {
  const { wait } = await awaitWait(t, as, messageId);
  return wait.results.filter((r) => r.proofToken).map((r) => ({ waitId: wait.id, messageId: r.answer!.id, token: r.proofToken! }));
}
const fallbacksTo = async (t: T, answerId: string) => (await deliveriesOf(t, answerId)).filter((d) => d.fallback).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("1.1 proof: the harness confirms, the CLI doesn't", () => {
  it("a Claude Code foreground answer confirmed by its own turn's proof is acknowledged, and never falls back", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"], { waiterTurnId: "t-1" });
    expect(sent.wait!.waiterTurnId).toBe("t-1");
    const got = await answer(t, sent.deliveries[0]!.id, "4");
    const p = await proofs(t, "a", sent.message.id);
    expect(p).toHaveLength(1);
    expect(p[0]!.token).toMatch(/^[0-9a-f]{32}$/);
    await seen(t, "a", "t-1", p);
    at(ACK_WINDOW_MS * 3);
    await sweep(t);
    expect((await status(t, "a", sent.message.id)).wait!.results[0]!.state).toBe("acknowledged");
    expect(await fallbacksTo(t, got.answerMessageId!)).toBe(0);
  });

  it("the CLI's ack alone is provisional: it records printedAt, and the answer still falls back once", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"], { waiterTurnId: "t-1" });
    const got = await answer(t, sent.deliveries[0]!.id, "4");
    const r = await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: sent.message.id });
    expect(r.wait.results[0]).toMatchObject({ state: "answered", printedAt: NOW });
    at(ACK_WINDOW_MS + 1);
    await sweep(t);
    expect((await status(t, "a", sent.message.id)).wait!.results[0]!.state).toBe("fell-back");
    expect(await fallbacksTo(t, got.answerMessageId!)).toBe(1);
  });

  it("a proof from another turn (a stale waiterTurnId, or a later turn), a wrong token, or another participant confirms nothing", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"], { waiterTurnId: "t-0" });
    await answer(t, sent.deliveries[0]!.id, "4");
    const [p] = await proofs(t, "a", sent.message.id);
    await seen(t, "a", "t-1", [p!]);
    await seen(t, "a", "t-0", [{ ...p!, token: "0".repeat(32) }]);
    await seen(t, "b", "t-0", [p!]);
    expect((await status(t, "a", sent.message.id)).wait!.results[0]!.state).toBe("answered");
    at(ACK_WINDOW_MS + 1);
    await sweep(t);
    expect((await status(t, "a", sent.message.id)).wait!.results[0]!.state).toBe("fell-back");
    // A proof arriving after the fallback changes nothing.
    await seen(t, "a", "t-0", [p!]);
    expect((await status(t, "a", sent.message.id)).wait!.results[0]!.state).toBe("fell-back");
  });

  it("a wait with no known turn (T3, or a turn not yet reported) is never confirmed", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "b", ["c"]);
    expect(sent.wait!.waiterTurnId).toBeUndefined();
    const got = await answer(t, sent.deliveries[0]!.id, "4");
    const [p] = await proofs(t, "b", sent.message.id);
    await seen(t, "b", "anything", [p!]);
    at(ACK_WINDOW_MS + 1);
    await sweep(t);
    expect(await fallbacksTo(t, got.answerMessageId!)).toBe(1);
  });

  it("Reed's repro: a T3 turn ending and another starting under a waiting command falls back (no ack can count)", async () => {
    const t = await setup();
    await t.mutation(api.connector.presence, { machine: m1, participant: "b", status: "busy" });
    at(1_000);
    const sent = await sendWaiting(t, "b", ["c"]);
    at(30_000);
    const got = await answer(t, sent.deliveries[0]!.id, "the answer");
    await t.mutation(api.connector.presence, { machine: m1, participant: "b", status: "busy" });
    const r = await t.mutation(api.connector.ack, { machine: m1, as: "b", messageId: sent.message.id });
    expect(r.wait.results[0]!.state).toBe("answered");
    at(30_000 + ACK_WINDOW_MS + 60_000);
    await sweep(t);
    expect(await fallbacksTo(t, got.answerMessageId!)).toBe(1);
  });

  it("Alder's repro: old CLI output isn't acknowledged when a different T3 turn is busy", async () => {
    const t = await setup();
    await t.mutation(api.connector.presence, { machine: m1, participant: "b", status: "busy" });
    const s = await sendWaiting(t, "b", ["c"]);
    at(10_000);
    await t.mutation(api.connector.presence, { machine: m1, participant: "b", status: "busy" });
    await answer(t, s.deliveries[0]!.id, "answer to old background CLI");
    const result = await t.mutation(api.connector.ack, { machine: m1, as: "b", messageId: s.message.id });
    expect(result.wait.results[0]!.state).toBe("answered");
  });

  it("the proof token is only in the waiter's own await and send: not in message-status, nor to anyone else", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"], { waiterTurnId: "t-1" });
    await answer(t, sent.deliveries[0]!.id, "4");
    const s = await status(t, "a", sent.message.id);
    expect(s.wait!.results[0]!.proofToken).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/[0-9a-f]{32}/);
    const ack = await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: sent.message.id });
    expect(ack.wait.results[0]!.proofToken).toBeUndefined();
  });
});

describe("1.1 the fallback clock (0.2)", () => {
  it("Reed's repro: an early group answer doesn't fall back while the CLI is still waiting on the other", async () => {
    const t = await setup();
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["a", "b", "c"] });
    const sent = await sendWaiting(t, "a", ["b", "c"], { conversationId: g.conversation.id, waiterTurnId: "t-1" });
    const fromB = await answer(t, sent.deliveries[0]!.id, "b first");
    for (let s = 25_000; s <= 4 * 60_000; s += 25_000) {
      at(s);
      await awaitWait(t, "a", sent.message.id);
      await sweep(t);
    }
    expect(await fallbacksTo(t, fromB.answerMessageId!)).toBe(0);
    await answer(t, sent.deliveries[1]!.id, "c later");
    const p = await proofs(t, "a", sent.message.id);
    await seen(t, "a", "t-1", p);
    at(4 * 60_000 + ACK_WINDOW_MS + 60_000);
    await sweep(t);
    expect((await status(t, "a", sent.message.id)).wait!.results.map((r) => r.state)).toEqual(["acknowledged", "acknowledged"]);
    expect(await fallbacksTo(t, fromB.answerMessageId!)).toBe(0);
  });

  it("a CLI that disappears mid-wait: the wait ends a hold after its last check-in, and the window runs from there", async () => {
    const t = await setup();
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["a", "b", "c"] });
    const sent = await sendWaiting(t, "a", ["b", "c"], { conversationId: g.conversation.id, waiterTurnId: "t-1" });
    const fromB = await answer(t, sent.deliveries[0]!.id, "b");
    at(10_000);
    await awaitWait(t, "a", sent.message.id); // the last check-in
    at(10_000 + WAIT_HELD_MS + 1);
    await sweep(t);
    const s = await status(t, "a", sent.message.id);
    expect(s.wait!.active).toBe(false);
    expect(s.wait!.endedAt).toBe(NOW + 10_000 + WAIT_HELD_MS);
    expect(s.wait!.results.map((r) => r.state)).toEqual(["answered", "expired"]);
    at(10_000 + WAIT_HELD_MS + ACK_WINDOW_MS - 1);
    await sweep(t);
    expect(await fallbacksTo(t, fromB.answerMessageId!)).toBe(0);
    at(10_000 + WAIT_HELD_MS + ACK_WINDOW_MS + 1);
    await sweep(t);
    expect(await fallbacksTo(t, fromB.answerMessageId!)).toBe(1);
  });

  it("a CLI reconnecting after the wait ended doesn't postpone the due fallback, which happens once", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"], { waiterTurnId: "t-1" });
    const got = await answer(t, sent.deliveries[0]!.id, "4"); // the wait ends now: no result open
    expect((await status(t, "a", sent.message.id)).wait!.endedAt).toBe(NOW);
    at(ACK_WINDOW_MS - 1_000);
    await awaitWait(t, "a", sent.message.id);
    at(ACK_WINDOW_MS + 1);
    await sweep(t);
    await awaitWait(t, "a", sent.message.id);
    await sweep(t);
    expect((await status(t, "a", sent.message.id)).wait!.endedAt).toBe(NOW);
    expect(await fallbacksTo(t, got.answerMessageId!)).toBe(1);
  });
});
