// docs/09 item 4 (option A, docs/finding-reply-then-collect.md): an explicit `comms reply`
// to a delivered request is its answer. It completes the delivery as `replied` and settles
// the wait at once; the turn's later final text isn't collected; a later outcome never
// reopens, overwrites or posts on it. For every harness (T3 v0.0.44 and V2, Claude Code).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-03T12:00:00Z").getTime();
const MIN = 60_000;

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const name of ["a", "b"]) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${name}` } });
  }
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}
type T = Awaited<ReturnType<typeof setup>>;

const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const answersTo = (t: T, messageId: string) =>
  t.run(async (ctx) => ctx.db.query("messages").withIndex("by_inReplyTo", (q) => q.eq("inReplyTo", messageId as never)).collect());
const delivery = (t: T, id: string) => t.run(async (ctx) => ctx.db.get(id as never));
const awaitWait = (t: T, as: string, messageId: string) => t.mutation(api.connector.awaitWait, { machine: m1, as, messageId });

/** @a asks @b and waits; the connector hands it to @b's turn `t1`. */
async function inTurn(t: T) {
  const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", wait: true, waitMs: 100_000 } as never);
  const deliveryId = sent.deliveries[0]!.id;
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId });
  await t.mutation(api.connector.delivered, { machine: m1, deliveryId, claimId: claim.claimId, turnId: "t1" });
  const outcome = { machine: m1, deliveryId, claimId: claim.claimId, turnId: "t1" };
  return { sent, deliveryId, outcome };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("docs/09 4: an explicit reply settles the request", () => {
  it("reply during the turn completes the delivery and settles the wait; the turn's final text isn't collected", async () => {
    const t = await setup();
    const { sent, deliveryId, outcome } = await inTurn(t);
    const reply = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "4" });
    expect(reply.completed).toBe(deliveryId);
    expect(await delivery(t, deliveryId)).toMatchObject({ state: "replied", answerMessageId: reply.message.id });
    const { wait } = await awaitWait(t, "a", sent.message.id);
    expect(wait.results[0]).toMatchObject({ state: "answered", answer: { id: reply.message.id } });

    // The turn ends with "Reply sent to @a.": nothing more is posted.
    const collected = await t.mutation(api.connector.collect, { ...outcome, answer: "Reply sent to @a." });
    expect(collected).toMatchObject({ answerMessageId: reply.message.id, duplicate: true, delivery: { state: "replied" } });
    expect((await answersTo(t, sent.message.id)).map((m) => m.text)).toEqual(["4"]);
    expect((await delivery(t, deliveryId))!).toMatchObject({ state: "replied", answerMessageId: reply.message.id });
  });

  it("a later outcome never reopens or overwrites it, and posts nothing", async () => {
    for (const late of ["ambiguous", "failed", "uncertain"] as const) {
      const t = await setup();
      const { sent, deliveryId, outcome } = await inTurn(t);
      const reply = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "4" });
      const r =
        late === "ambiguous"
          ? await t.mutation(api.connector.ambiguous, { ...outcome, entered: [{ origin: "t3-user-message" }] })
          : late === "failed"
            ? await t.mutation(api.connector.failed, { ...outcome, reason: "aborted", detail: "interrupted" })
            : await t.mutation(api.connector.uncertain, { ...outcome, detail: "can't tell" });
      expect(r.delivery.state, late).toBe("replied");
      expect(await delivery(t, deliveryId), late).toMatchObject({ state: "replied", answerMessageId: reply.message.id });
      expect((await answersTo(t, sent.message.id)).map((m) => m.text), late).toEqual(["4"]);
      expect((await awaitWait(t, "a", sent.message.id)).wait.results[0]!.state, late).toBe("answered");
    }
  });

  it("the other order: the turn's answer is collected first; a later reply is an ordinary follow-up", async () => {
    const t = await setup();
    const { sent, deliveryId, outcome } = await inTurn(t);
    const collected = await t.mutation(api.connector.collect, { ...outcome, answer: "4" });
    const reply = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "and to add: 4.0" });
    expect(reply.completed).toBeUndefined();
    expect(await delivery(t, deliveryId)).toMatchObject({ state: "replied", answerMessageId: collected.answerMessageId });
    const { wait } = await awaitWait(t, "a", sent.message.id);
    expect(wait.results[0]).toMatchObject({ state: "answered", answer: { id: collected.answerMessageId } });
  });

  it("a reminder fire answered by comms reply is recorded and reported once, with the reply", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "b", text: "status?", everyMs: 10 * MIN, name: "st", reportTo: "lee" });
    at(10 * MIN);
    await t.mutation(internal.reminders.tick, {});
    const fire = (await t.query(api.connector.work, { machine: m1 })).deliveries.find((d) => d.recipient === "b")!;
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: fire.id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: fire.id, claimId: claim.claimId, turnId: "t1" });
    const full = (await delivery(t, fire.id)) as { messageId: string };
    await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: full.messageId, text: "all green" });
    await t.mutation(api.connector.collect, { machine: m1, deliveryId: fire.id, claimId: claim.claimId, turnId: "t1", answer: "Replied to the reminder." });
    const shown = await t.query(api.reminders.get, { adminToken: ADMIN, id: reminder.id });
    expect(shown.fires[0]!.answer?.text).toBe("all green");
    const inbox = (await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee" })).items.map((i) => i.message.text);
    expect(inbox).toEqual([`Reminder st (${reminder.id}): @b answered:\n> all green`]);
  });

  it("only the recipient's own reply completes it; a reply to a request not yet delivered completes nothing", async () => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q" } as never);
    const g = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "early" });
    expect(g.completed).toBeUndefined();
    expect((await delivery(t, sent.deliveries[0]!.id))!).toMatchObject({ state: "pending" });
  });
});
