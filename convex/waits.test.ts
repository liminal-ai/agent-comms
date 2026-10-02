// The capabilities pass, R2: send-and-wait. The wait is registered with the
// send; an answer is taken into the wait in the same mutation that collects it
// (never a claim, never seen by the dispatcher); the CLI acks what it printed,
// and an answer not acked in time falls back into the thread once.

import { ACK_WINDOW_MS, renderDelivery, WAIT_HELD_MS, WAIT_RETENTION_MS } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-01T12:00:00Z").getTime();

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const name of ["a", "b", "c"]) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${name}` } });
  }
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    return `plain: ${(error as Error).message}`;
  }
  return "no error";
}

const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const busy = (t: T, name: string) => t.mutation(api.connector.presence, { machine: m1, participant: name, status: "busy" });
const idle = (t: T, name: string) => t.mutation(api.connector.presence, { machine: m1, participant: name, status: "idle" });

async function sendWaiting(t: T, as: string, to: string[], text = "q", extra: Record<string, unknown> = {}) {
  return t.mutation(api.connector.send, { machine: m1, as, to, text, wait: true, waitMs: 100_000, ...extra } as never);
}

/** Runs the recipient's delivery of `messageId` through claim, delivered and collect with `answer`. */
async function answer(t: T, deliveryId: string, text: string) {
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId });
  await t.mutation(api.connector.delivered, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `turn-${deliveryId}` });
  return t.mutation(api.connector.collect, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `turn-${deliveryId}`, answer: text });
}

const awaitWait = (t: T, as: string, messageId: string) => t.mutation(api.connector.awaitWait, { machine: m1, as, messageId });
const deliveriesOf = (t: T, messageId: string) =>
  t.run(async (ctx) => ctx.db.query("deliveries").withIndex("by_message", (q) => q.eq("messageId", messageId as never)).collect());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("R2 registering a wait", () => {
  it("registers one open result per addressed agent, lists people as in their inbox, and nobody-to-wait-for without agents", async () => {
    const t = await setup();
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["lee", "a", "b", "c"] });
    const sent = await sendWaiting(t, "a", ["b", "c", "lee"], "q", { conversationId: g.conversation.id });
    expect(sent.wait).toMatchObject({ messageId: sent.message.id, waiter: { name: "a" }, until: NOW + 100_000, active: true, createdAt: NOW });
    expect(sent.wait!.results.map((r) => [r.recipient.name, r.state, r.delivery.state])).toEqual([["b", "open", "pending"], ["c", "open", "pending"]]);
    expect(sent.wait!.inInbox.map((p) => p.name)).toEqual(["lee"]);

    const toLee = await sendWaiting(t, "a", ["owner"]);
    expect(toLee.wait).toBeUndefined();
    expect(toLee.noWait).toEqual({ reason: "nobody-to-wait-for" });

    const again = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "k", wait: true, key: "key-0000001" });
    const replay = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "k", wait: true, key: "key-0000001" });
    expect(replay.wait?.id).toBe(again.wait!.id);
  });

  it("doesn't wait on an agent that is itself busy waiting, but still sends", async () => {
    const t = await setup();
    const bWaits = await sendWaiting(t, "b", ["c"]);
    const aToB = await sendWaiting(t, "a", ["b"]);
    expect(aToB.wait).toBeUndefined();
    expect(aToB.noWait).toEqual({ reason: "busy-waiting", busy: ["b"] });
    expect(aToB.deliveries.map((d) => d.recipient)).toEqual(["b"]);

    // Once b's wait has no open result (answered, even unacknowledged), b isn't busy waiting.
    await answer(t, bWaits.deliveries[0]!.id, "c's answer");
    const later = await sendWaiting(t, "a", ["b"], "again");
    expect(later.wait?.results.map((r) => r.state)).toEqual(["open"]);
  });

  it("a wait past its until isn't busy waiting", async () => {
    const t = await setup();
    await sendWaiting(t, "b", ["c"]);
    at(100_001);
    expect((await sendWaiting(t, "a", ["b"])).wait).toBeDefined();
  });
});

describe("R2 answers return to the wait", () => {
  it("takes the collected answer into the wait in the collecting mutation; the answer's delivery never reaches the dispatcher", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"]);
    const collected = await answer(t, sent.deliveries[0]!.id, "4");
    const answerId = collected.answerMessageId!;
    const [toA] = await deliveriesOf(t, answerId);
    expect(toA).toMatchObject({ state: "delivered", detail: "returned to the waiting send" });
    expect(toA!.claim).toBeUndefined();
    expect((await t.query(api.connector.work, { machine: m1 })).deliveries).toEqual([]);

    const { wait } = await awaitWait(t, "a", sent.message.id);
    expect(wait.results[0]).toMatchObject({ state: "answered", delivery: { state: "replied" }, answer: { id: answerId, text: "4" } });
    expect(wait.active).toBe(false);
  });

  it("in a group wait, the first answer closes only its own result", async () => {
    const t = await setup();
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["a", "b", "c"] });
    const sent = await sendWaiting(t, "a", ["b", "c"], "q", { conversationId: g.conversation.id });
    await answer(t, sent.deliveries[0]!.id, "b says");
    const { wait } = await awaitWait(t, "a", sent.message.id);
    expect(wait.results.map((r) => [r.recipient.name, r.state])).toEqual([["b", "answered"], ["c", "open"]]);
    expect(wait.active).toBe(true);
  });

  it("an ambiguous delivery keeps its result open, and the comms reply that completes it answers the wait", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"]);
    const id = sent.deliveries[0]!.id;
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId: claim.claimId, turnId: "t1" });
    await t.mutation(api.connector.ambiguous, { machine: m1, deliveryId: id, claimId: claim.claimId, turnId: "t1", entered: [{ origin: "composer" }] });
    expect((await awaitWait(t, "a", sent.message.id)).wait.results[0]!.state).toBe("open");
    const replied = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "late but sure" });
    const { wait } = await awaitWait(t, "a", sent.message.id);
    expect(wait.results[0]).toMatchObject({ state: "answered", answer: { id: replied.message.id } });
    expect((await deliveriesOf(t, replied.message.id))[0]).toMatchObject({ state: "delivered", detail: "returned to the waiting send" });
  });

  it("a failed, uncertain or retired recipient's result ends", async () => {
    const t = await setup();
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["a", "b", "c"] });
    const sent = await sendWaiting(t, "a", ["b", "c"], "q", { conversationId: g.conversation.id });
    const [db, dc] = sent.deliveries;
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: db!.id });
    await t.mutation(api.connector.failed, { machine: m1, deliveryId: db!.id, claimId: claim.claimId, reason: "error", detail: "boom" });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "c", state: "retired" });
    const { wait } = await awaitWait(t, "a", sent.message.id);
    expect(wait.results.map((r) => [r.recipient.name, r.state, r.delivery.state])).toEqual([["b", "ended", "failed"], ["c", "ended", "failed"]]);
    expect(wait.active).toBe(false);
    expect(dc).toBeDefined();

    const two = await sendWaiting(t, "a", ["b"], "again");
    const { claim: c2 } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: two.deliveries[0]!.id });
    await t.mutation(api.connector.uncertain, { machine: m1, deliveryId: two.deliveries[0]!.id, claimId: c2.claimId, detail: "restart" });
    expect((await awaitWait(t, "a", two.message.id)).wait.results[0]!.state).toBe("ended");
  });

  it("an answer after the bound, or while no CLI is awaiting, goes into the thread as normal", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"]);
    at(100_000);
    const expired = await awaitWait(t, "a", sent.message.id);
    expect(expired.wait.results[0]!.state).toBe("expired");
    expect(expired.wait.active).toBe(false);
    const late = await answer(t, sent.deliveries[0]!.id, "late");
    expect((await deliveriesOf(t, late.answerMessageId!))[0]!.state).toBe("pending");

    const two = await sendWaiting(t, "a", ["b"], "two");
    at(100_000 + WAIT_HELD_MS + 1);
    const orphan = await answer(t, two.deliveries[0]!.id, "nobody's awaiting");
    expect((await deliveriesOf(t, orphan.answerMessageId!))[0]!.state).toBe("pending");
    expect((await t.query(api.connector.waitView, { machine: m1, as: "a", messageId: two.message.id })).wait.results[0]!.state).toBe("expired");
  });

  it("refuses await and ack on a message the caller isn't waiting on", async () => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "no wait" });
    expect(await errorCode(awaitWait(t, "a", sent.message.id))).toBe("conflict");
    expect(await errorCode(t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: sent.message.id }))).toBe("conflict");
  });
});

describe("R2 ack and the one fallback", () => {
  async function answered(t: T) {
    const sent = await sendWaiting(t, "a", ["b"]);
    const collected = await answer(t, sent.deliveries[0]!.id, "4");
    return { sent, answerId: collected.answerMessageId! };
  }

  it("fix pass 0.1: busy in the turn that ran the CLI is no longer enough; the CLI's ack is provisional", async () => {
    const t = await setup();
    await busy(t, "a");
    at(1_000);
    const { sent } = await answered(t);
    const r = await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: sent.message.id });
    expect(r.wait.results[0]!.state).toBe("answered");
    at(1_000 + ACK_WINDOW_MS + 60_000);
    await t.mutation(internal.waits.sweep, {});
    expect((await awaitWait(t, "a", sent.message.id)).wait.results[0]!.state).toBe("fell-back");
  });

  it("an ack is ignored if the waiter is idle, in a later turn, or its presence is stale", async () => {
    const t = await setup();
    // Idle: the turn that ran the CLI has ended (Claude Code moved it to the background; Codex stopped polling).
    await idle(t, "a");
    const one = await answered(t);
    expect((await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: one.sent.message.id })).wait.results[0]!.state).toBe("answered");
    // A later turn: busy since after the wait began.
    const two = await answered(t);
    at(5_000);
    await busy(t, "a");
    expect((await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: two.sent.message.id })).wait.results[0]!.state).toBe("answered");
    // Stale: the machine hasn't heartbeated.
    const three = await answered(t);
    at(5_000 + 120_000);
    expect((await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: three.sent.message.id })).wait.results[0]!.state).toBe("answered");
  });

  it("an answer not acknowledged in time falls back into the thread exactly once, marked as possibly seen", async () => {
    const t = await setup();
    const { sent, answerId } = await answered(t);
    at(ACK_WINDOW_MS - 1);
    await t.mutation(internal.waits.sweep, {});
    expect((await deliveriesOf(t, answerId)).length).toBe(1);
    at(ACK_WINDOW_MS + 1);
    await t.mutation(internal.waits.sweep, {});
    await t.mutation(internal.waits.sweep, {});
    const ds = await deliveriesOf(t, answerId);
    expect(ds.map((d) => [d.state, d.fallback ?? false])).toEqual([["delivered", false], ["pending", true]]);
    await busy(t, "a");
    expect((await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: sent.message.id })).wait.results[0]!.state).toBe("fell-back");

    const work = (await t.query(api.connector.work, { machine: m1 })).deliveries;
    expect(work.map((w) => w.id)).toEqual([ds[1]!._id]);
    const { delivery: full } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: ds[1]!._id });
    expect(full.fallback).toBe(true);
    expect(renderDelivery(full, { harnessLabelsSource: true })).toMatch(/may already have been returned to your waiting `comms send`/);
  });

  it("deactivates waits past their until and deletes them after the retention period", async () => {
    const t = await setup();
    const sent = await sendWaiting(t, "a", ["b"]);
    at(100_001);
    await t.mutation(internal.waits.sweep, {});
    const view = await t.query(api.connector.waitView, { machine: m1, as: "a", messageId: sent.message.id });
    expect([view.wait.active, view.wait.results[0]!.state]).toEqual([false, "expired"]);
    at(100_001 + WAIT_RETENTION_MS + 1);
    await t.mutation(internal.waits.sweep, {});
    expect(await t.run(async (ctx) => [(await ctx.db.query("waits").collect()).length, (await ctx.db.query("waitResults").collect()).length])).toEqual([0, 0]);
  });
});

describe("R2 comms status <message-id>", () => {
  it("shows each recipient's delivery and answer, people's read state, and the caller's wait", async () => {
    const t = await setup();
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["lee", "a", "b", "c"] });
    const sent = await sendWaiting(t, "a", ["b", "c", "lee"], "q", { conversationId: g.conversation.id });
    await answer(t, sent.deliveries[0]!.id, "b's answer");
    await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "and a follow-up" });
    const s = await t.query(api.connector.messageStatus, { machine: m1, as: "a", messageId: sent.message.id });
    expect(s.message.id).toBe(sent.message.id);
    expect(s.recipients.map((r) => [r.participant.name, r.delivery?.state, r.answer?.text, r.followUps.map((f) => f.text), r.inbox?.readAt])).toEqual([
      ["b", "replied", "b's answer", ["and a follow-up"], undefined],
      ["c", "pending", undefined, [], undefined],
      ["lee", undefined, undefined, [], null],
    ]);
    expect(s.wait?.results.map((r) => r.state)).toEqual(["answered", "open"]);
    expect(await errorCode(t.query(api.connector.messageStatus, { machine: m1, as: "c", messageId: "nope" }))).toBe("unknown_message");
  });
});
