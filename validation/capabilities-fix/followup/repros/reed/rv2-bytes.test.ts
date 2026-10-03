// rv2: the tick under Convex's real limits (16 MiB read/written) with long reminders.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-02T12:00:00Z").getTime();
const MIN = 60_000;
const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); at(0); });
afterEach(() => vi.useRealTimers());

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest({ schema, modules, transactionLimits: true as never });
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (let i = 0; i < 50; i++) {
    await t.mutation(api.directory.promote, { adminToken: ADMIN, name: `a${i}`, kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: `loc-${i}` } });
  }
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}

for (const [label, expiring, due, ch] of [["20 due CJK", 0, 20, "界"], ["30 due CJK", 0, 30, "界"], ["40 expiring CJK", 40, 0, "界"], ["60 expiring CJK", 60, 0, "界"], ["50 due ASCII", 0, 50, "x"], ["100 expiring + 50 due ASCII", 100, 50, "x"]] as const) {
  it(`the tick survives ${label} long (32,000-character CJK) reminders, within the caps`, async () => {
    const t = await setup();
    const text = ch.repeat(32_000); // within MAX_TEXT_CHARS (UTF-16 length), ~96 KB in UTF-8
    for (let i = 0; i < expiring; i++) await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: `a${i % 50}`, text, everyMs: 60 * MIN, expiresMs: 2 * MIN });
    for (let i = 0; i < due; i++) await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: `a${i}`, text, everyMs: 2 * MIN });
    at(2 * MIN);
    let err = "";
    try { await t.mutation(internal.reminders.tick, {}); } catch (e) { err = (e as Error).message; }
    expect(err).toBe("");
    // and the next minute: still failing?

  });
}
