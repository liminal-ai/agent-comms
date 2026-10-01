import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const m2 = { id: "m2", secret: "m2-secret-0123456789" };

type T = ReturnType<typeof convexTest>;

async function setup(): Promise<T> {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m2", secret: m2.secret });
  const agent = (name: string, machine = "m1", harness: "t3" | "claude-code" = "t3") =>
    t.mutation(api.directory.promote, { adminToken: ADMIN, name, kind: "agent", home: { machine, harness, locator: `loc-${name}` } });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  await agent("a");
  await agent("b", "m1", "claude-code");
  await agent("c", "m2");
  await agent("old");
  await agent("napper");
  await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "old", state: "retired" });
  await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "napper", state: "paused" });
  return t;
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    return `plain: ${(error as Error).message}`;
  }
  return "no error";
}

async function group(t: T, members = ["lee", "a", "b", "c", "old", "napper"]) {
  const r = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "build", members });
  return r.conversation.id;
}

const work = async (t: T, machine = m1) => (await t.query(api.connector.work, { machine })).deliveries;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("auth", () => {
  it("rejects a wrong machine secret and a wrong admin token", async () => {
    const t = await setup();
    expect(await errorCode(t.query(api.connector.work, { machine: { id: "m1", secret: "wrong" } }))).toBe(
      "plain: machine credential rejected",
    );
    expect(await errorCode(t.query(api.directory.list, { adminToken: "nope" }))).toBe("plain: admin token rejected");
  });

  it("accepts --as only for participants homed on the calling machine", async () => {
    const t = await setup();
    expect(await errorCode(t.mutation(api.connector.send, { machine: m1, as: "c", to: ["a"], text: "x" }))).toBe("not_homed_here");
    expect(await errorCode(t.mutation(api.connector.send, { machine: m1, as: "lee", to: ["a"], text: "x" }))).toBe("not_homed_here");
    expect(await errorCode(t.mutation(api.connector.send, { machine: m1, as: "ghost", to: ["a"], text: "x" }))).toBe(
      "unknown_participant",
    );
  });
});

describe("send", () => {
  it("opens one DM per pair and creates a pending delivery", async () => {
    const t = await setup();
    const r1 = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["c"], text: "hi" });
    const r2 = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["c"], text: "again" });
    expect(r1.message.conversationId).toBe(r2.message.conversationId);
    expect([r1.message.seq, r2.message.seq]).toEqual([1, 2]);
    expect(r1.message.kind).toBe("request");
    expect(r1.message.origin).toEqual({ via: "cli" });
    expect(r1.deliveries).toEqual([{ id: expect.any(String), recipient: "c", state: "pending" }]);
    expect((await work(t, m2)).map((d) => d.state)).toEqual(["pending", "pending"]);
    expect(await work(t, m1)).toEqual([]);
  });

  it("wakes only addressed agents: humans read in the web view, retired are skipped, paused wait", async () => {
    const t = await setup();
    const g = await group(t);
    const r = await t.mutation(api.connector.send, {
      machine: m1, as: "a", conversationId: g, to: ["lee", "b", "old", "napper"], text: "status?",
    });
    expect(r.deliveries.map((d) => [d.recipient, d.state])).toEqual([["b", "pending"], ["napper", "pending"]]);
    expect(r.skipped).toEqual([{ name: "old", reason: "retired" }]);
    expect((await work(t)).map((d) => d.recipient)).toEqual(["b"]);
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "napper", state: "active" });
    expect((await work(t)).map((d) => d.recipient)).toEqual(["b", "napper"]);
    const none = await t.mutation(api.connector.send, { machine: m1, as: "a", conversationId: g, to: [], text: "fyi" });
    expect(none.deliveries).toEqual([]);
  });

  it("validates addressing", async () => {
    const t = await setup();
    const g = await group(t, ["lee", "a", "b"]);
    const send = (args: object) => errorCode(t.mutation(api.connector.send, { machine: m1, as: "a", text: "x", to: [], ...args }));
    expect(await send({ to: [] })).toBe("bad_request");
    expect(await send({ to: ["b", "c"] })).toBe("bad_request");
    expect(await send({ to: ["a"] })).toBe("bad_request");
    expect(await send({ conversationId: g, to: ["c"] })).toBe("not_member");
    expect(await send({ conversationId: g, to: ["b", "b"] })).toBe("bad_request");
    expect(await send({ conversationId: "nonsense", to: ["b"] })).toBe("unknown_conversation");
  });

  it("rolls back entirely when a check fails", async () => {
    const t = await setup();
    const g = await group(t, ["lee", "a", "b"]);
    await errorCode(t.mutation(api.connector.send, { machine: m1, as: "a", conversationId: g, to: ["b", "c"], text: "x" }));
    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: g });
    expect(view.messages).toEqual([]);
    expect(view.conversation.lastSeq).toBe(0);
  });
});

describe("fix pass 2.4-2.6", () => {
  it("2.4 an in-flight request's answer is collected even if the agent was retired meanwhile", async () => {
    const t = await setup();
    const { sent, id, claimId } = await claimed(t);
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t1" });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "b", state: "retired" });
    const r = await t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId, turnId: "t1", answer: "4" });
    expect(r.delivery.state).toBe("replied");
    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: sent.message.conversationId });
    expect(view.messages.at(-1)!.message).toMatchObject({ kind: "answer", text: "4" });
  });

  it("2.4 an in-flight request's answer ends the delivery even if the agent left the group", async () => {
    const t = await setup();
    const g = await group(t, ["lee", "a", "b"]);
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", conversationId: g, to: ["b"], text: "q" });
    const id = sent.deliveries[0]!.id;
    const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId: claim.claimId, turnId: "t1" });
    await t.mutation(api.conversations.removeMember, { adminToken: ADMIN, conversationId: g, name: "b" });
    const r = await t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId: claim.claimId, turnId: "t1", answer: "done" });
    expect(["replied", "failed"]).toContain(r.delivery.state);
    expect((await work(t)).map((w) => w.id)).not.toContain(id);
  });

  it("2.5 a delivery handed to a home stays with that home through a rebind", async () => {
    const t = await setup();
    const { id, claimId } = await claimed(t);
    // Record where it's going before the handoff.
    await t.mutation(api.connector.prepare, { machine: m1, deliveryId: id, claimId, cursor: "17" });
    await t.mutation(api.directory.rebind, { adminToken: ADMIN, name: "b", home: { machine: "m2", harness: "t3", locator: "new-thread" } });
    const mine = await work(t, m1);
    expect(mine.map((w) => [w.id, w.locator, w.harness])).toEqual([[id, "loc-b", "claude-code"]]);
    expect((mine[0] as { cursor?: string }).cursor).toBe("17");
    expect(await work(t, m2)).toEqual([]);
  });

  it("2.6 finished answer deliveries aren't re-read by the work query", async () => {
    process.env.COMMS_ADMIN_TOKEN = ADMIN;
    const t = convexTest({ schema, modules, transactionLimits: { documentsRead: 200 } });
    await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "a", kind: "agent", home: { machine: "m1", harness: "t3", locator: "x" } });
    await t.run(async (ctx) => {
      const a = (await ctx.db.query("participants").collect())[0]!;
      const c = await ctx.db.insert("conversations", { kind: "group", title: "x", lastSeq: 0, lastAt: 0, createdAt: 0 });
      const m = await ctx.db.insert("messages", {
        conversationId: c, seq: 1, senderId: a._id, recipientIds: [a._id], kind: "answer", text: "x", attachments: [], origin: { via: "cli" }, createdAt: 0,
      });
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert("deliveries", { messageId: m, conversationId: c, recipientId: a._id, collect: false, state: "delivered", at: 0, createdAt: 0 });
      }
    });
    expect(await work(t, m1)).toEqual([]);
  });
});

describe("fix pass 3.1", () => {
  it("3.1 a send or reply repeated with the same key returns the first result and posts once", async () => {
    const t = await setup();
    const one = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", key: "key-00000001" });
    const two = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", key: "key-00000001" });
    expect(two.message.id).toBe(one.message.id);
    expect(two.deliveries).toEqual(one.deliveries);
    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: one.message.conversationId });
    expect(view.messages).toHaveLength(1);
    const r1 = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: one.message.id, text: "a", key: "key-00000002" });
    const r2 = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: one.message.id, text: "a", key: "key-00000002" });
    expect(r2.message.id).toBe(r1.message.id);
  });
});

describe("fix pass 1.10", () => {
  it("1.10 send, reply, web post and group titles over the caps are rejected with a clear error", async () => {
    const t = await setup();
    const P = await import("@agent-comms/protocol");
    const long = "x".repeat(P.MAX_TEXT_CHARS + 1);
    const g = await group(t, ["lee", "a", "b"]);
    const errorOf = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return e instanceof ConvexError ? (e.data as { code: string; message: string }) : { code: "plain", message: String(e) };
      }
      return { code: "none", message: "" };
    };
    const send = await errorOf(t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: long }));
    expect(send.code).toBe("bad_request");
    expect(send.message).toMatch(new RegExp(String(P.MAX_TEXT_CHARS)));
    const post = await errorOf(t.mutation(api.conversations.postAs, { adminToken: ADMIN, as: "lee", conversationId: g, to: [], text: long }));
    expect(post.code).toBe("bad_request");
    const title = await errorOf(t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "t".repeat(1000), members: ["lee", "a"] }));
    expect(title.code).toBe("bad_request");
  });
});

describe("claims", () => {
  it("claims with a lease and returns the full delivery with bounded history", async () => {
    const t = await setup();
    const g = await group(t, ["lee", "a", "b"]);
    for (let i = 0; i < 25; i++) await t.mutation(api.conversations.postAs, { adminToken: ADMIN, as: "lee", conversationId: g, to: [], text: `note ${i}` });
    await t.mutation(api.connector.send, { machine: m1, as: "a", conversationId: g, to: ["b"], text: "please look" });
    const [item] = await work(t);
    const r = await t.mutation(api.connector.claim, { machine: m1, deliveryId: item!.id });
    expect(r.takeover).toBe(false);
    expect(r.claim.machine).toBe("m1");
    expect(r.claim.leaseExpiresAt).toBe(Date.now() + 60_000);
    expect(r.delivery.message.text).toBe("please look");
    expect(r.delivery.recipient.name).toBe("b");
    expect(r.delivery.history.messages).toHaveLength(20);
    expect(r.delivery.history.messages.at(-1)!.text).toBe("note 24");
    expect(r.delivery.history.omitted).toBe(5);
    expect(r.delivery.status.state).toBe("claimed");
  });

  it("refuses a second claim while the lease holds, and takes over after it expires", async () => {
    const t = await setup();
    await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "x" });
    const [item] = await work(t);
    const first = await t.mutation(api.connector.claim, { machine: m1, deliveryId: item!.id, leaseMs: 5_000 });
    expect(await errorCode(t.mutation(api.connector.claim, { machine: m1, deliveryId: item!.id }))).toBe("conflict");

    vi.setSystemTime(Date.now() + 6_000);
    const second = await t.mutation(api.connector.claim, { machine: m1, deliveryId: item!.id });
    expect(second.takeover).toBe(true);
    expect(second.claim.claimId).not.toBe(first.claim.claimId);
    // The old holder's compare-and-set fails; it must not hand the message over.
    expect(await errorCode(t.mutation(api.connector.renew, { machine: m1, deliveryId: item!.id, claimId: first.claim.claimId }))).toBe("conflict");
    expect(
      await errorCode(t.mutation(api.connector.delivered, { machine: m1, deliveryId: item!.id, claimId: first.claim.claimId, turnId: "t1" })),
    ).toBe("conflict");
    const renewed = await t.mutation(api.connector.renew, { machine: m1, deliveryId: item!.id, claimId: second.claim.claimId });
    expect(renewed.claim.leaseExpiresAt).toBe(Date.now() + 60_000);
  });

  it("only the recipient's machine can claim, and a paused recipient's delivery can't be", async () => {
    const t = await setup();
    await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["c"], text: "x" });
    const [item] = await work(t, m2);
    expect(await errorCode(t.mutation(api.connector.claim, { machine: m1, deliveryId: item!.id }))).toBe("not_homed_here");
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "c", state: "paused" });
    expect(await work(t, m2)).toEqual([]);
    expect(await errorCode(t.mutation(api.connector.claim, { machine: m2, deliveryId: item!.id }))).toBe("conflict");
  });
});

async function claimed(t: T, text = "what's 2+2?") {
  const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text });
  const id = sent.deliveries[0]!.id;
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
  return { sent, id, claimId: claim.claimId };
}

describe("delivery lifecycle", () => {
  it("delivered is idempotent for the same turn, a conflict for another", async () => {
    const t = await setup();
    const { id, claimId } = await claimed(t);
    const d = await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t1" });
    expect(d.delivery.state).toBe("delivered");
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t1" });
    expect(await errorCode(t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t2" }))).toBe("conflict");
    // A delivered request stays in the connector's work until its answer is collected.
    expect((await work(t)).map((w) => [w.state, w.turnId])).toEqual([["delivered", "t1"]]);
  });

  it("collects one answer, delivers it to the requester, and never collects from that", async () => {
    const t = await setup();
    const { sent, id, claimId } = await claimed(t);
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t1" });
    const r = await t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId, turnId: "t1", answer: "4" });
    expect(r.duplicate).toBe(false);
    expect(r.delivery.state).toBe("replied");
    const again = await t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId, turnId: "t1", answer: "four" });
    expect(again).toEqual({ ...r, duplicate: true });

    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: sent.message.conversationId });
    const answer = view.messages.at(-1)!;
    expect(answer.message).toMatchObject({ kind: "answer", inReplyTo: sent.message.id, collectedFrom: id, text: "4", origin: { via: "claude-code" } });
    expect(answer.message.sender.name).toBe("b");
    expect(answer.message.recipients.map((p) => p.name)).toEqual(["a"]);
    expect(answer.deliveries).toHaveLength(1);

    // The requester gets the answer; delivering it finishes it, and it can't be collected.
    const [ans] = await work(t);
    expect(ans).toMatchObject({ recipient: "a", collect: false });
    const c = await t.mutation(api.connector.claim, { machine: m1, deliveryId: ans!.id });
    expect(c.delivery.message.kind).toBe("answer");
    expect(c.delivery.inReplyTo?.text).toBe("what's 2+2?");
    expect(
      await errorCode(t.mutation(api.connector.collect, { machine: m1, deliveryId: ans!.id, claimId: c.claim.claimId, turnId: "ta", answer: "thanks" })),
    ).toBe("conflict");
    expect(
      await errorCode(t.mutation(api.connector.ambiguous, { machine: m1, deliveryId: ans!.id, claimId: c.claim.claimId, turnId: "ta", entered: [] })),
    ).toBe("conflict");
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: ans!.id, claimId: c.claim.claimId, turnId: "ta" });
    expect(await work(t)).toEqual([]);
  });

  it("moves the read position on delivery, so the next delivery's history starts after it", async () => {
    const t = await setup();
    const first = await claimed(t, "one");
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: first.id, claimId: first.claimId, turnId: "t1" });
    await t.mutation(api.connector.collect, { machine: m1, deliveryId: first.id, claimId: first.claimId, turnId: "t1", answer: "done one" });
    const second = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "two" });
    const c = await t.mutation(api.connector.claim, { machine: m1, deliveryId: second.deliveries[0]!.id });
    // b read #1 when it was delivered and wrote #2 itself; nothing unread before #3.
    expect(c.delivery.message.seq).toBe(3);
    expect(c.delivery.history).toEqual({ messages: [], omitted: 0 });
  });

  it("marks ambiguous with only the input kinds, and comms reply completes it; follow-ups stay allowed", async () => {
    const t = await setup();
    const { sent, id, claimId } = await claimed(t);
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t1" });
    const amb = await t.mutation(api.connector.ambiguous, {
      machine: m1, deliveryId: id, claimId, turnId: "t1", entered: [{ origin: "composer" }],
    });
    expect(amb.delivery.state).toBe("ambiguous");
    expect(await errorCode(t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId, turnId: "t1", answer: "x" }))).toBe(
      "conflict",
    );
    const r1 = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "4" });
    expect(r1.completed).toBe(id);
    expect(r1.message).toMatchObject({ kind: "answer", inReplyTo: sent.message.id });
    expect(r1.message.collectedFrom).toBeUndefined();
    const r2 = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "also 2*2" });
    expect(r2.completed).toBeUndefined();
    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: sent.message.conversationId });
    const original = view.messages.find((m) => m.message.id === sent.message.id)!;
    expect(original.deliveries[0]).toMatchObject({ state: "replied", detail: `completed by comms reply ${r1.message.id}` });
  });

  it("accepts comms reply as a follow-up after the answer was collected, without changing the delivery", async () => {
    const t = await setup();
    const { sent, id, claimId } = await claimed(t);
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t1" });
    const collected = await t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId, turnId: "t1", answer: "4" });
    const followUp = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "tests pass too" });
    expect(followUp.completed).toBeUndefined();
    expect(followUp.message).toMatchObject({ kind: "answer", inReplyTo: sent.message.id });
    expect(followUp.message.id).not.toBe(collected.answerMessageId);
    expect(followUp.deliveries.map((d) => d.recipient)).toEqual(["a"]);
    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: sent.message.conversationId });
    const original = view.messages.find((m) => m.message.id === sent.message.id)!;
    expect(original.deliveries[0]).toMatchObject({ state: "replied" });
    expect(view.messages.filter((m) => m.message.inReplyTo === sent.message.id)).toHaveLength(2);
  });

  it("leaves a still-running delivery alone on comms reply: its own answer is still collected", async () => {
    const t = await setup();
    const { sent, id, claimId } = await claimed(t);
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t1" });
    const early = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: sent.message.id, text: "working on it" });
    expect(early.completed).toBeUndefined();
    const r = await t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId, turnId: "t1", answer: "4" });
    expect(r.duplicate).toBe(false);
  });

  it("fails and marks uncertain from claimed or delivered, idempotently, and only with the claim", async () => {
    const t = await setup();
    const one = await claimed(t, "one");
    const f = await t.mutation(api.connector.failed, { machine: m1, deliveryId: one.id, claimId: one.claimId, reason: "rejected", detail: "thread missing" });
    expect(f.delivery.state).toBe("failed");
    expect(await errorCode(t.mutation(api.connector.delivered, { machine: m1, deliveryId: one.id, claimId: one.claimId, turnId: "t" }))).toBe(
      "conflict",
    );

    const two = await claimed(t, "two");
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: two.id, claimId: two.claimId, turnId: "t2" });
    expect(await errorCode(t.mutation(api.connector.uncertain, { machine: m1, deliveryId: two.id, claimId: "stolen", detail: "?" }))).toBe(
      "conflict",
    );
    const u = await t.mutation(api.connector.uncertain, { machine: m1, deliveryId: two.id, claimId: two.claimId, detail: "turn not found after restart" });
    expect(u.delivery.state).toBe("uncertain");
    const again = await t.mutation(api.connector.uncertain, { machine: m1, deliveryId: two.id, claimId: two.claimId, detail: "same" });
    expect(again.delivery.state).toBe("uncertain");
    expect(await work(t)).toEqual([]);
    // An explicit answer settles an uncertain one: it evidently ran.
    const r = await t.mutation(api.connector.reply, { machine: m1, as: "b", messageId: two.sent.message.id, text: "it did run" });
    expect(r.completed).toBe(two.id);
  });

  it("a takeover of a delivered request can still collect its answer", async () => {
    const t = await setup();
    const { id, claimId } = await claimed(t);
    await t.mutation(api.connector.delivered, { machine: m1, deliveryId: id, claimId, turnId: "t1" });
    vi.setSystemTime(Date.now() + 61_000);
    const taken = await t.mutation(api.connector.claim, { machine: m1, deliveryId: id });
    expect(taken.takeover).toBe(true);
    expect(taken.delivery.status).toMatchObject({ state: "delivered", turnId: "t1" });
    expect(await errorCode(t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId, turnId: "t1", answer: "4" }))).toBe("conflict");
    expect(
      await errorCode(t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId: taken.claim.claimId, turnId: "t9", answer: "4" })),
    ).toBe("conflict");
    const r = await t.mutation(api.connector.collect, { machine: m1, deliveryId: id, claimId: taken.claim.claimId, turnId: "t1", answer: "4" });
    expect(r.delivery.state).toBe("replied");
  });
});

describe("directory", () => {
  it("retiring fails pending deliveries and stops new ones", async () => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "x" });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "b", state: "retired" });
    expect(await work(t)).toEqual([]);
    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: sent.message.conversationId });
    expect(view.messages[0]!.deliveries[0]).toMatchObject({ state: "failed", detail: "recipient retired" });
    const later = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "y" });
    expect(later.skipped).toEqual([{ name: "b", reason: "retired" }]);
    expect(await errorCode(t.mutation(api.directory.setState, { adminToken: ADMIN, name: "b", state: "active" }))).toBe("conflict");
  });

  it("rebinding moves pending deliveries to the new machine", async () => {
    const t = await setup();
    await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["c"], text: "x" });
    expect(await work(t, m2)).toHaveLength(1);
    await t.mutation(api.directory.rebind, { adminToken: ADMIN, name: "c", home: { machine: "m1", harness: "claude-code", locator: "c" } });
    expect(await work(t, m2)).toEqual([]);
    expect((await work(t, m1)).map((w) => [w.recipient, w.harness])).toEqual([["c", "claude-code"]]);
  });

  it("validates promotion", async () => {
    const t = await setup();
    const promote = (args: object) =>
      errorCode(t.mutation(api.directory.promote, { adminToken: ADMIN, name: "x", kind: "agent", ...args } as never));
    expect(await promote({ name: "Bad Name", home: { machine: "m1", harness: "t3", locator: "l" } })).toBe("bad_request");
    expect(await promote({})).toBe("bad_request");
    expect(await promote({ name: "a", home: { machine: "m1", harness: "t3", locator: "l" } })).toBe("conflict");
  });

  it("lists homed participants and records presence", async () => {
    const t = await setup();
    await t.mutation(api.connector.presence, { machine: m1, participant: "b", status: "busy" });
    const homed = await t.query(api.connector.homed, { machine: m1 });
    expect(homed.participants.map((p) => p.participant.name).sort()).toEqual(["a", "b", "napper", "old"]);
    const dir = await t.query(api.directory.list, { adminToken: ADMIN });
    expect(dir.participants.find((p) => p.name === "b")!.presence.status).toBe("busy");
    await t.mutation(api.connector.heartbeat, { machine: m1 });
    expect(dir.machines.length).toBe(2);
  });
});

describe("reading", () => {
  it("pages oldest first, and only the newest page moves the read position", async () => {
    const t = await setup();
    let conversationId = "";
    for (let i = 1; i <= 5; i++) conversationId = (await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: `m${i}` })).message.conversationId;
    const older = await t.mutation(api.connector.read, { machine: m1, as: "b", conversationId, before: 4, limit: 2 });
    expect(older.messages.map((m) => m.seq)).toEqual([2, 3]);
    expect(older.hasMore).toBe(true);
    expect(older.conversation.readSeq).toBe(0);
    const newest = await t.mutation(api.connector.read, { machine: m1, as: "b", conversationId, limit: 2 });
    expect(newest.messages.map((m) => m.text)).toEqual(["m4", "m5"]);
    expect(newest.conversation).toMatchObject({ readSeq: 5, unread: 0, lastSeq: 5, kind: "dm" });
    const list = await t.query(api.connector.list, { machine: m1, as: "b" });
    expect(list.conversations.map((c) => c.id)).toEqual([conversationId]);
    expect(await errorCode(t.mutation(api.connector.read, { machine: m1, as: "napper", conversationId }))).toBe("not_member");
  });
});

describe("web", () => {
  it("posts as a person with addressed wakes, and shows delivery states", async () => {
    const t = await setup();
    const g = await group(t);
    const r = await t.mutation(api.conversations.postAs, { adminToken: ADMIN, as: "lee", conversationId: g, to: ["a", "b"], text: "both of you" });
    expect(r.message.origin).toEqual({ via: "web" });
    expect(r.deliveries.map((d) => d.recipient)).toEqual(["a", "b"]);
    expect(await errorCode(t.mutation(api.conversations.postAs, { adminToken: ADMIN, as: "a", conversationId: g, to: [], text: "x" }))).toBe(
      "bad_request",
    );
    const view = await t.query(api.conversations.view, { adminToken: ADMIN, conversationId: g });
    expect(view.messages[0]!.deliveries.map((d) => [d.recipient, d.state])).toEqual([["a", "pending"], ["b", "pending"]]);
    const list = await t.query(api.conversations.list, { adminToken: ADMIN });
    expect(list.conversations[0]).toMatchObject({ id: g, kind: "group", title: "build", lastSeq: 1 });
  });

  it("new group members start caught up; DMs have fixed membership", async () => {
    const t = await setup();
    const g = await group(t, ["lee", "a"]);
    await t.mutation(api.conversations.postAs, { adminToken: ADMIN, as: "lee", conversationId: g, to: [], text: "before b" });
    await t.mutation(api.conversations.addMember, { adminToken: ADMIN, conversationId: g, name: "b" });
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", conversationId: g, to: ["b"], text: "hi b" });
    const c = await t.mutation(api.connector.claim, { machine: m1, deliveryId: sent.deliveries[0]!.id });
    expect(c.delivery.history.messages).toEqual([]);
    const dm = await t.mutation(api.conversations.openDm, { adminToken: ADMIN, a: "a", b: "b" });
    expect(await errorCode(t.mutation(api.conversations.addMember, { adminToken: ADMIN, conversationId: dm.conversation.id, name: "c" }))).toBe(
      "bad_request",
    );
  });
});
