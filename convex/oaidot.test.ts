import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const m2 = { id: "m2", secret: "m2-secret-0123456789" };
const NOW = new Date("2026-10-06T12:00:00Z").getTime();
const home = { machine: "m1", harness: "oaidot" as const, locator: "dot-parent" };

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  for (const machine of [m1, m2]) await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: machine.id, secret: machine.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const [name, harness] of [["a", "t3"], ["dot", "oaidot"], ["other", "oaidot"]] as const) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: name === "dot" ? home : { machine: "m1", harness, locator: `loc-${name}` } });
  }
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;
const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const send = (t: T, text = "question") => t.mutation(api.connector.send, { machine: m1, as: "a", to: ["dot"], text });
const receive = (t: T, args: { limit?: number; leaseMs?: number; includeDelivered?: boolean; cursor?: string } = {}) => t.mutation(api.connector.receive, { locator: home.locator, machine: m1, as: "dot", ...args });
const row = (t: T, id: string) => t.run(async (ctx) => ctx.db.get(id as Id<"deliveries">));
const readSeq = async (t: T, conversationId: string) => (await t.query(api.connector.list, { machine: m1, as: "dot" })).conversations.find((c) => c.id === conversationId)!.readSeq;
const ack = (t: T, deliveryId: string, claimId: string) => t.mutation(api.connector.receiveAck, { locator: home.locator, machine: m1, as: "dot", deliveryId, claimId });
async function offered(t: T, leaseMs = 1_000) {
  const sent = await send(t);
  const { deliveries } = await receive(t, { leaseMs });
  return { sent, delivery: deliveries[0]!, deliveryId: deliveries[0]!.id, claimId: deliveries[0]!.status.claim!.claimId };
}
async function errorCode(p: Promise<unknown>) {
  try { await p; } catch (e) { return e instanceof ConvexError ? (e.data as { code: string }).code : `plain: ${(e as Error).message}`; }
  return "no error";
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); at(0); });
afterEach(() => vi.useRealTimers());

describe("oaidot pull receipt lifecycle", () => {
  it("offers without acknowledging or advancing read; active leases are omitted rather than renewed", async () => {
    const t = await setup();
    const sent = await send(t);
    expect((await t.query(api.connector.work, { machine: m1 })).deliveries[0]).toMatchObject({ id: sent.deliveries[0]!.id, harness: "oaidot", state: "pending" });
    const first = await receive(t);
    const delivery = first.deliveries[0]!;
    expect(first.hasMore).toBe(false);
    expect(delivery).toMatchObject({ message: sent.message, recipient: { name: "dot" }, status: { state: "claimed", claim: { machine: "m1", leaseExpiresAt: NOW + 60_000 } } });
    expect(await row(t, delivery.id)).toMatchObject({ state: "claimed", target: home, collect: true, claimCount: 1 });
    expect(await readSeq(t, sent.message.conversationId)).toBe(0);
    at(500);
    expect(await receive(t)).toEqual({ deliveries: [], hasMore: false });
    expect((await row(t, delivery.id))!.claim).toEqual(delivery.status.claim);
    expect((await t.query(api.connector.work, { machine: m1 })).deliveries[0]!.state).toBe("claimed");
  });

  it("selects bounded oldest offers, defaults to one, and skips active claims", async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) { at(i); ids.push((await send(t, `question ${i}`)).deliveries[0]!.id); }
    const first = await receive(t);
    expect(first.deliveries.map((d) => d.id)).toEqual(ids.slice(0, 1));
    expect(first.hasMore).toBe(true);
    const next = await receive(t, { limit: 2 });
    expect(next.deliveries.map((d) => d.id)).toEqual(ids.slice(1, 3));
    expect(next.hasMore).toBe(true);
    expect((await receive(t, { limit: 20 })).deliveries.map((d) => d.id)).toEqual(ids.slice(3));
    expect(await receive(t)).toEqual({ deliveries: [], hasMore: false });
  });

  it("validates bounds, credentials, participant home, and first-class harness", async () => {
    const t = await setup();
    for (const limit of [0, 21, 1.5]) expect(await errorCode(receive(t, { limit }))).toBe("bad_request");
    for (const leaseMs of [999, 600_001, 1_000.5]) expect(await errorCode(receive(t, { leaseMs }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.connector.receive, { locator: home.locator, machine: m1, as: "a" }))).toBe("bad_request");
    expect(await errorCode(t.mutation(api.connector.receive, { locator: home.locator, machine: m2, as: "dot" }))).toBe("not_homed_here");
    expect(await errorCode(t.mutation(api.connector.receive, { locator: home.locator, machine: { ...m1, secret: "wrong" }, as: "dot" }))).toBe("plain: machine credential rejected");
    expect(await errorCode(t.mutation(api.connector.receive, { locator: home.locator, machine: m1, as: "ghost" }))).toBe("unknown_participant");
  });

  it("rotates expired claims, fences stale ACKs, and persists a receipt across ACK retry and lease expiry", async () => {
    const t = await setup();
    const original = await offered(t);
    at(1_000);
    expect(await errorCode(ack(t, original.deliveryId, original.claimId))).toBe("conflict");
    const retry = (await receive(t, { leaseMs: 1_000 })).deliveries[0]!;
    expect(retry.id).toBe(original.deliveryId);
    expect(retry.status.claim!.claimId).not.toBe(original.claimId);
    expect(await errorCode(ack(t, retry.id, original.claimId))).toBe("conflict");
    const claimed = await row(t, retry.id);
    expect(claimed!.claimCount).toBe(2);
    const received = await ack(t, retry.id, retry.status.claim!.claimId);
    expect(received.delivery.state).toBe("delivered");
    expect(await readSeq(t, original.sent.message.conversationId)).toBe(1);
    const saved = (await row(t, retry.id))!;
    expect(saved.turnId).toBeUndefined();
    expect(saved.claim).toBeUndefined();
    expect(saved.received).toEqual({ machine: "m1", claimId: retry.status.claim!.claimId, at: NOW + 1_000 });
    at(120_000);
    expect(await ack(t, retry.id, retry.status.claim!.claimId)).toEqual(received);
    expect(await row(t, retry.id)).toEqual(saved);
    expect(await errorCode(ack(t, retry.id, "forged"))).toBe("conflict");
    expect((await t.query(api.connector.work, { machine: m1 })).deliveries).toEqual([]);
  });

  it("rejects ACK before an offer, cross-participant ACK, wrong-machine ACK, and a push-harness delivery", async () => {
    const t = await setup();
    const sent = await send(t);
    const deliveryId = sent.deliveries[0]!.id;
    expect(await errorCode(ack(t, deliveryId, "guessed"))).toBe("bad_request");
    const offer = (await receive(t)).deliveries[0]!;
    const claimId = offer.status.claim!.claimId;
    expect(await errorCode(t.mutation(api.connector.receiveAck, { locator: home.locator, machine: m1, as: "other", deliveryId, claimId }))).toBe("not_homed_here");
    expect(await errorCode(t.mutation(api.connector.receiveAck, { locator: home.locator, machine: m2, as: "dot", deliveryId, claimId }))).toBe("not_homed_here");
    expect(await errorCode(ack(t, "invalid-id", claimId))).toBe("unknown_delivery");
    const push = await t.mutation(api.connector.send, { machine: m1, as: "dot", to: ["a"], text: "outbound" });
    const claimed = await t.mutation(api.connector.claim, { machine: m1, deliveryId: push.deliveries[0]!.id });
    await t.mutation(api.connector.prepare, { machine: m1, deliveryId: push.deliveries[0]!.id, claimId: claimed.claim.claimId });
    expect(await errorCode(t.mutation(api.connector.receiveAck, { locator: home.locator, machine: m1, as: "a", deliveryId: push.deliveries[0]!.id, claimId: claimed.claim.claimId }))).toBe("bad_request");
    expect((await row(t, deliveryId))!.state).toBe("claimed");
  });

  it("blocks every legacy push lifecycle mutation from claiming, renewing, or collecting oaidot", async () => {
    const t = await setup();
    const sent = await send(t);
    const deliveryId = sent.deliveries[0]!.id;
    expect(await errorCode(t.mutation(api.connector.claim, { machine: m1, deliveryId }))).toBe("conflict");
    const offer = (await receive(t)).deliveries[0]!;
    const common = { machine: m1, deliveryId, claimId: offer.status.claim!.claimId };
    const before = await row(t, deliveryId);
    for (const call of [
      () => t.mutation(api.connector.renew, common),
      () => t.mutation(api.connector.prepare, common),
      () => t.mutation(api.connector.delivered, { ...common, turnId: "fabricated" }),
      () => t.mutation(api.connector.collect, { ...common, turnId: "fabricated", answer: "wrong" }),
      () => t.mutation(api.connector.failed, { ...common, reason: "error" }),
      () => t.mutation(api.connector.uncertain, { ...common, detail: "wrong" }),
      () => t.mutation(api.connector.ambiguous, { ...common, turnId: "fabricated", entered: [] }),
    ]) expect(await errorCode(call())).toBe("conflict");
    expect(await row(t, deliveryId)).toEqual(before);
  });

  it("recovers delivered requests only on request, read-only and without exposing receipt tokens", async () => {
    const t = await setup();
    const one = await offered(t);
    await ack(t, one.deliveryId, one.claimId);
    const saved = await row(t, one.deliveryId);
    expect(await receive(t)).toEqual({ deliveries: [], hasMore: false });
    at(50_000);
    const recovered = await receive(t, { includeDelivered: true });
    expect(recovered.deliveries.map((d) => [d.id, d.status.state])).toEqual([[one.deliveryId, "delivered"]]);
    expect(recovered.deliveries[0]!.status.claim).toBeUndefined();
    expect(JSON.stringify(recovered)).not.toContain(one.claimId);
    expect(await row(t, one.deliveryId)).toEqual(saved);
    const fresh = await send(t, "new request");
    const next = await receive(t, { includeDelivered: true });
    expect(next.deliveries.map((d) => d.id)).toEqual([one.deliveryId]);
    expect(next.hasMore).toBe(false);
    expect((await row(t, fresh.deliveries[0]!.id))!.state).toBe("pending");
    expect((await receive(t)).deliveries.map((d) => d.id)).toEqual([fresh.deliveries[0]!.id]);
  });

  it("paginates more than twenty acknowledged requests without changing claims or read state, including after retirement", async () => {
    const t = await setup();
    const ids: string[] = [];
    let conversationId = "";
    for (let i = 0; i < 23; i++) {
      at(i);
      const current = await offered(t);
      ids.push(current.deliveryId);
      conversationId = current.sent.message.conversationId;
      await ack(t, current.deliveryId, current.claimId);
    }
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "dot", state: "retired" });
    const saved = await Promise.all(ids.map((id) => row(t, id)));
    const beforeRead = await readSeq(t, conversationId);
    const page1 = await receive(t, { includeDelivered: true, limit: 20 });
    expect(page1.deliveries.map((d) => d.id)).toEqual(ids.slice(0, 20));
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await receive(t, { includeDelivered: true, limit: 20, cursor: page1.nextCursor });
    expect(page2.deliveries.map((d) => d.id)).toEqual(ids.slice(20));
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeUndefined();
    expect([...page1.deliveries, ...page2.deliveries].every((d) => d.status.state === "delivered" && d.status.claim === undefined)).toBe(true);
    expect(await Promise.all(ids.map((id) => row(t, id)))).toEqual(saved);
    expect(await readSeq(t, conversationId)).toBe(beforeRead);
    expect(await errorCode(receive(t, { cursor: page1.nextCursor }))).toBe("bad_request");
    expect(await errorCode(receive(t, { includeDelivered: true, cursor: "x".repeat(4097) }))).toBe("bad_request");
    expect(await receive(t)).toEqual({ deliveries: [], hasMore: false });
  });

  it("leaves paused pending work untouched, resumes it, and offers nothing new to retired agents", async () => {
    const t = await setup();
    const sent = await send(t);
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "dot", state: "paused" });
    expect(await receive(t)).toEqual({ deliveries: [], hasMore: false });
    expect((await row(t, sent.deliveries[0]!.id))!.state).toBe("pending");
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "dot", state: "active" });
    const offer = (await receive(t)).deliveries[0]!;
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "dot", state: "retired" });
    expect(await receive(t)).toEqual({ deliveries: [], hasMore: false });
    expect((await ack(t, offer.id, offer.status.claim!.claimId)).delivery.state).toBe("delivered");
    const reply = await t.mutation(api.connector.reply, { machine: m1, as: "dot", messageId: sent.message.id, text: "finished", key: "retired-reply" });
    expect(reply.completed).toBe(offer.id);
    expect((await t.mutation(api.connector.reply, { machine: m1, as: "dot", messageId: sent.message.id, text: "finished", key: "retired-reply" })).message.id).toBe(reply.message.id);
    expect(await errorCode(t.mutation(api.connector.send, { machine: m1, as: "dot", to: ["a"], text: "new work" }))).toBe("conflict");
  });
});

describe("oaidot explicit answers", () => {
  it.each(["pending", "claimed", "delivered"] as const)("an explicit reply settles %s and the existing wait exactly once", async (state) => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["dot"], text: "question", wait: true });
    const deliveryId = sent.deliveries[0]!.id;
    let claimId: string | undefined;
    if (state !== "pending") claimId = (await receive(t)).deliveries[0]!.status.claim!.claimId;
    if (state === "delivered") await ack(t, deliveryId, claimId!);
    const replyArgs = { machine: m1, as: "dot", messageId: sent.message.id, text: "answer", key: `reply-${state}` };
    const reply = await t.mutation(api.connector.reply, replyArgs);
    expect(reply.completed).toBe(deliveryId);
    const retry = await t.mutation(api.connector.reply, replyArgs);
    expect(retry.message.id).toBe(reply.message.id);
    expect(await row(t, deliveryId)).toMatchObject({ state: "replied", answerMessageId: reply.message.id });
    const { wait } = await t.mutation(api.connector.awaitWait, { machine: m1, as: "a", messageId: sent.message.id });
    expect(wait.results[0]).toMatchObject({ state: "answered", answer: { id: reply.message.id } });
    if (claimId) {
      expect((await ack(t, deliveryId, claimId)).delivery.state).toBe("replied");
      at(100_000);
      expect((await ack(t, deliveryId, claimId)).delivery.state).toBe("replied");
    }
    expect((await receive(t, { includeDelivered: true })).deliveries).toEqual([]);
    const answers = await t.run(async (ctx) => ctx.db.query("messages").withIndex("by_inReplyTo", (q) => q.eq("inReplyTo", sent.message.id as Id<"messages">)).collect());
    expect(answers.map((m) => m.text)).toEqual(["answer"]);
  });

  it("answer receipts finish transport without creating another answer or collection loop", async () => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "dot", to: ["a"], text: "question" });
    const answer = await t.mutation(api.connector.reply, { machine: m1, as: "a", messageId: sent.message.id, text: "answer" });
    const offer = (await receive(t)).deliveries[0]!;
    expect(offer.message.kind).toBe("answer");
    expect(offer.inReplyTo!.id).toBe(sent.message.id);
    expect((await row(t, offer.id))!.collect).toBe(false);
    await ack(t, offer.id, offer.status.claim!.claimId);
    expect((await receive(t, { includeDelivered: true })).deliveries).toEqual([]);
    expect((await t.query(api.connector.work, { machine: m1 })).deliveries.map((d) => d.id)).not.toContain(offer.id);
    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: answer.message.conversationId });
    expect(view.messages).toHaveLength(2);
  });

  it("records and reports a pending reminder fire's explicit answer once", async () => {
    const t = await setup();
    await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "dot", text: "status?", everyMs: 600_000, name: "dot-status", reportTo: "lee" });
    at(600_000);
    await t.mutation(internal.reminders.tick, {});
    const work = (await t.query(api.connector.work, { machine: m1 })).deliveries.find((d) => d.recipient === "dot")!;
    const fire = (await row(t, work.id))!;
    const replyArgs = { machine: m1, as: "dot", messageId: fire.messageId, text: "all green", key: "reminder-reply" };
    expect((await t.mutation(api.connector.reply, replyArgs)).completed).toBe(work.id);
    await t.mutation(api.connector.reply, replyArgs);
    const detail = await t.query(api.reminders.get, { adminToken: ADMIN, id: reminder.id });
    expect(detail.fires[0]!.answer?.text).toBe("all green");
    expect((await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee" })).items).toHaveLength(1);
    expect((await receive(t, { includeDelivered: true })).deliveries).toEqual([]);
  });

  it("does not let another conversation member settle the recipient's pending request", async () => {
    const t = await setup();
    const { conversation } = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "group", members: ["a", "dot", "other"] });
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", conversationId: conversation.id, to: ["dot"], text: "question" });
    const other = await t.mutation(api.connector.reply, { machine: m1, as: "other", messageId: sent.message.id, text: "interjection" });
    expect(other.completed).toBeUndefined();
    expect((await row(t, sent.deliveries[0]!.id))!.state).toBe("pending");
  });
});

describe("oaidot pinned home fencing", () => {
  it("never reoffers old-home work at the new home, but lets the exact old offer ACK and reply", async () => {
    const t = await setup();
    const old = await offered(t, 10_000);
    await t.mutation(api.directory.rebind, { adminToken: ADMIN, name: "dot", home: { machine: "m2", harness: "oaidot", locator: "new-parent" } });
    expect(await errorCode(receive(t))).toBe("not_homed_here");
    expect(await t.mutation(api.connector.receive, { locator: "new-parent", machine: m2, as: "dot", includeDelivered: true })).toEqual({ deliveries: [], hasMore: false });
    const fresh = await send(t, "new home work");
    const newOffer = (await t.mutation(api.connector.receive, { locator: "new-parent", machine: m2, as: "dot" })).deliveries[0]!;
    expect(newOffer.id).toBe(fresh.deliveries[0]!.id);
    expect(await errorCode(ack(t, newOffer.id, newOffer.status.claim!.claimId))).toBe("not_homed_here");
    expect((await ack(t, old.deliveryId, old.claimId)).delivery.state).toBe("delivered");
    const replyArgs = { machine: m1, as: "dot", messageId: old.sent.message.id, text: "old home finished", key: "old-home-reply" };
    const reply = await t.mutation(api.connector.reply, replyArgs);
    expect(reply.completed).toBe(old.deliveryId);
    expect((await t.mutation(api.connector.reply, replyArgs)).message.id).toBe(reply.message.id);
    expect(await errorCode(t.mutation(api.connector.reply, { ...replyArgs, messageId: fresh.message.id, key: "new-work-forged" }))).toBe("not_homed_here");
    expect(await row(t, old.deliveryId)).toMatchObject({ target: home, state: "replied" });
  });

  it("fails closed for expired claims after a same-machine locator or harness rebind", async () => {
    for (const harness of ["oaidot", "t3"] as const) {
      const t = await setup();
      const old = await offered(t);
      await t.mutation(api.directory.rebind, { adminToken: ADMIN, name: "dot", home: { machine: "m1", harness, locator: "new-parent" } });
      at(1_000);
      if (harness === "oaidot") {
        expect(await errorCode(receive(t, { includeDelivered: true }))).toBe("not_homed_here");
        expect((await t.mutation(api.connector.receive, { machine: m1, as: "dot", locator: "new-parent", includeDelivered: true })).deliveries).toEqual([]);
      } else expect(await errorCode(receive(t))).toBe("bad_request");
      expect(await errorCode(ack(t, old.deliveryId, old.claimId))).toBe("conflict");
      expect(await row(t, old.deliveryId)).toMatchObject({ target: home, state: "claimed", claim: { claimId: old.claimId } });
      at(0);
    }
  });

  it("checks the configured locator on every receive and ACK through same-machine rebinding", async () => {
    const t = await setup();
    const old = await offered(t, 10_000);
    await t.mutation(api.directory.rebind, { adminToken: ADMIN, name: "dot", home: { machine: "m1", harness: "oaidot", locator: "new-parent" } });
    const fresh = await send(t, "new parent work");
    expect(await errorCode(receive(t))).toBe("not_homed_here");
    expect(await errorCode(receive(t, { includeDelivered: true }))).toBe("not_homed_here");
    expect((await row(t, fresh.deliveries[0]!.id))!.state).toBe("pending");
    const next = (await t.mutation(api.connector.receive, { machine: m1, as: "dot", locator: "new-parent" })).deliveries[0]!;
    expect(next.id).toBe(fresh.deliveries[0]!.id);
    expect(await errorCode(ack(t, next.id, next.status.claim!.claimId))).toBe("not_homed_here");
    expect(await errorCode(t.mutation(api.connector.receiveAck, { machine: m1, as: "dot", locator: "new-parent", deliveryId: old.deliveryId, claimId: old.claimId }))).toBe("not_homed_here");
    expect((await ack(t, old.deliveryId, old.claimId)).delivery.state).toBe("delivered");
    // A durable successful receipt must not let a different locator reuse its proof.
    expect(await errorCode(t.mutation(api.connector.receiveAck, { machine: m1, as: "dot", locator: "new-parent", deliveryId: old.deliveryId, claimId: old.claimId }))).toBe("not_homed_here");
    expect((await t.mutation(api.connector.receiveAck, { machine: m1, as: "dot", locator: "new-parent", deliveryId: next.id, claimId: next.status.claim!.claimId })).delivery.state).toBe("delivered");
  });

  it("lets an already offered request finish after its recipient leaves the group", async () => {
    const t = await setup();
    const { conversation } = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "group", members: ["a", "dot"] });
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", conversationId: conversation.id, to: ["dot"], text: "question" });
    await receive(t);
    await t.mutation(api.conversations.removeMember, { adminToken: ADMIN, conversationId: conversation.id, name: "dot" });
    const reply = await t.mutation(api.connector.reply, { machine: m1, as: "dot", messageId: sent.message.id, text: "finished" });
    expect(reply.completed).toBe(sent.deliveries[0]!.id);
  });
});
