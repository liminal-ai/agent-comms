// Adversarial review repros (scratch only).

import { ACK_WINDOW_MS } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
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
const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const busy = (t: T, name: string) => t.mutation(api.connector.presence, { machine: m1, participant: name, status: "busy" });
async function answer(t: T, deliveryId: string, text: string) {
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId });
  await t.mutation(api.connector.delivered, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `turn-${deliveryId}` });
  return t.mutation(api.connector.collect, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `turn-${deliveryId}`, answer: text });
}
const deliveriesOf = (t: T, messageId: string) =>
  t.run(async (ctx) => ctx.db.query("deliveries").withIndex("by_message", (q) => q.eq("messageId", messageId as never)).collect());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("review: ack counted for a later turn when presence never saw the idle gap (T3 polled every 20 s)", () => {
  it("turn A ran the CLI, ended; turn B started within one poll; the CLI's ack (refresh says busy) counts, so the answer never reaches the thread", async () => {
    const t = await setup();
    await busy(t, "a"); // turn A, refreshed at send
    at(1_000);
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", wait: true, waitMs: 100_000 });
    // turn A ends at 5 s, turn B starts at 8 s; no presence write in between (poll at 0 s and 20 s both see busy).
    at(20_000);
    await busy(t, "a"); // the 20 s poll (or the ack's refresh) — status unchanged, busySince kept
    at(30_000);
    const collected = await answer(t, sent.deliveries[0]!.id, "the answer");
    at(31_000);
    await busy(t, "a"); // refreshPresence before ack: still busy (turn B)
    const r = await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: sent.message.id });
    expect(r.wait.results[0]!.state).toBe("acknowledged"); // counted, though the turn that ran the CLI ended
    at(31_000 + ACK_WINDOW_MS + 60_000);
    await t.mutation(internal.waits.sweep, {});
    const ds = await deliveriesOf(t, collected.answerMessageId!);
    // The only delivery of the answer to @a is the "returned to the waiting send" one: nothing reaches the thread.
    expect(ds.map((d) => [d.state, d.detail, d.fallback ?? false])).toEqual([["delivered", "returned to the waiting send", false]]);
  });
});

describe("review: group wait with --json acks only at the end", () => {
  it("the first answer falls back into the thread while the CLI is still waiting on the second", async () => {
    const t = await setup();
    await busy(t, "a");
    const g = await t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["a", "b", "c"] });
    at(1_000);
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b", "c"], conversationId: g.conversation.id, text: "q", wait: true, waitMs: 9 * 60_000 });
    const fromB = await answer(t, sent.deliveries[0]!.id, "b first");
    // the CLI keeps awaiting (every 25 s) for c; with --json it doesn't ack b yet
    for (let s = 25_000; s <= 4 * 60_000; s += 25_000) {
      at(1_000 + s);
      await t.mutation(api.connector.awaitWait, { machine: m1, as: "a", messageId: sent.message.id });
      await t.mutation(internal.waits.sweep, {});
      await t.mutation(api.connector.heartbeat, { machine: m1 });
    }
    await answer(t, sent.deliveries[1]!.id, "c later");
    const r = await t.mutation(api.connector.ack, { machine: m1, as: "a", messageId: sent.message.id }); // ackPrinted
    expect(r.wait.results.map((x) => [x.recipient.name, x.state])).toEqual([["b", "fell-back"], ["c", "acknowledged"]]);
    const ds = await deliveriesOf(t, fromB.answerMessageId!);
    expect(ds.filter((d) => d.fallback).length).toBe(1); // b's answer also arrives as a turn after the call printed it
  });
});

describe("review: comms await after exit 4 can't wait again", () => {
  it("after until, await expires every open result; a later answer goes to the thread", async () => {
    const t = await setup();
    const sent = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", wait: true, waitMs: 10_000 });
    at(40_001); // CLI exited 4 at until+30 s
    const w = await t.mutation(api.connector.awaitWait, { machine: m1, as: "a", messageId: sent.message.id });
    expect(w.wait.results[0]!.state).toBe("expired");
  });
});

describe("review: replayed waiting send that was busy-waiting loses its noWait", () => {
  it("the retry after unavailable returns neither wait nor noWait", async () => {
    const t = await setup();
    await t.mutation(api.connector.send, { machine: m1, as: "b", to: ["c"], text: "b waits", wait: true });
    const first = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", wait: true, key: "k-000000001" });
    expect(first.noWait?.reason).toBe("busy-waiting");
    const replay = await t.mutation(api.connector.send, { machine: m1, as: "a", to: ["b"], text: "q", wait: true, key: "k-000000001" });
    expect([replay.wait, replay.noWait]).toEqual([undefined, undefined]);
  });
});
