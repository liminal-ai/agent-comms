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

describe("Alder adversarial ack checks", () => {
  it("must not acknowledge old CLI output when a different T3 turn is busy", async () => {
    const t = await setup();
    await busy(t, "a"); // T3 turn A at the last presence sample
    const s = await sendWaiting(t, "a", ["b"]);
    // Turn A ends and turn B starts between 20-second samples. Adapter reports
    // only status, so the next sampled presence remains busy.
    at(10_000);
    await busy(t, "a");
    await answer(t, s.deliveries[0]!.id, "answer to old background CLI");
    const result = await t.mutation(api.connector.ack, {machine:m1, as:"a", messageId:s.message.id});
    expect(result.wait.results[0]!.state).toBe("answered");
  });
});
