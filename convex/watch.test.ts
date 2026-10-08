// A machine's watch secret: accepted by connector:work and by nothing else (agent-wake-relay holds only that).
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const watcher = { id: "m1", secret: "m1-watch-secret-abcdef" };

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "a", kind: "agent", owner: "lee", home: { machine: "m1", harness: "t3", locator: "loc-a" } });
  await t.mutation(api.directory.upgrade, { adminToken: ADMIN, defaultOwner: "lee" });
  await t.mutation(api.connector.heartbeat, { machine: m1 });
  return t;
}

describe("the watch secret", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-08T12:00:00Z").getTime() }));
  afterEach(() => vi.useRealTimers());

  it("is accepted by connector:work and refused everywhere else", async () => {
    const t = await setup();
    await expect(t.query(api.connector.work, { machine: watcher })).rejects.toThrow(/credential rejected/);
    expect(await t.mutation(api.directory.setWatchSecret, { adminToken: ADMIN, machineId: "m1", secret: watcher.secret })).toEqual({ machineId: "m1", watch: true });
    const seen = await t.query(api.connector.work, { machine: watcher });
    expect(Array.isArray(seen.deliveries)).toBe(true);
    // Everything that acts as the machine still needs the real secret.
    await expect(t.mutation(api.connector.heartbeat, { machine: watcher })).rejects.toThrow(/credential rejected/);
    await expect(t.query(api.connector.homed, { machine: watcher })).rejects.toThrow(/credential rejected/);
    await expect(t.mutation(api.connector.receive, { machine: watcher, as: "a", locator: "loc-a" })).rejects.toThrow(/credential rejected/);
    // The real secret keeps working for work too.
    expect(Array.isArray((await t.query(api.connector.work, { machine: m1 })).deliveries)).toBe(true);
  });

  it("must be set by the admin, differ from the connector secret, and can be cleared", async () => {
    const t = await setup();
    await expect(t.mutation(api.directory.setWatchSecret, { adminToken: "wrong", machineId: "m1", secret: watcher.secret })).rejects.toThrow();
    await expect(t.mutation(api.directory.setWatchSecret, { adminToken: ADMIN, machineId: "m1", secret: "short" })).rejects.toThrow(/at least 16/);
    await expect(t.mutation(api.directory.setWatchSecret, { adminToken: ADMIN, machineId: "m1", secret: m1.secret })).rejects.toThrow(/must differ/);
    await expect(t.mutation(api.directory.setWatchSecret, { adminToken: ADMIN, machineId: "nope", secret: watcher.secret })).rejects.toThrow(/isn't registered/);
    await t.mutation(api.directory.setWatchSecret, { adminToken: ADMIN, machineId: "m1", secret: watcher.secret });
    expect(await t.mutation(api.directory.setWatchSecret, { adminToken: ADMIN, machineId: "m1", secret: "" })).toEqual({ machineId: "m1", watch: false });
    await expect(t.query(api.connector.work, { machine: watcher })).rejects.toThrow(/credential rejected/);
  });
});

describe("the two machine credentials stay distinct", () => {
  it("a connector rotation to the watch secret is refused (Bugbot autofix 7e0dacf), and the watch secret can't copy the connector's", async () => {
    const t = convexTest(schema, modules);
    process.env.COMMS_ADMIN_TOKEN = ADMIN;
    await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
    await t.mutation(api.directory.setWatchSecret, { adminToken: ADMIN, machineId: "m1", secret: watcher.secret });
    await expect(t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: watcher.secret })).rejects.toThrow(/must differ from the watch secret/);
    await expect(t.mutation(api.directory.setWatchSecret, { adminToken: ADMIN, machineId: "m1", secret: m1.secret })).rejects.toThrow(/must differ/);
    // Rotating to a third value is fine, and the watch secret still only reads work.
    await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: "m1-secret-rotated-9876543210" });
    await expect(t.mutation(api.connector.receive, { machine: watcher, as: "a", locator: "loc-a" })).rejects.toThrow(/credential rejected/);
  });

  it("a rejected credential is a protocol error with a code, so production clients see more than 'Server Error'", async () => {
    const t = convexTest(schema, modules);
    process.env.COMMS_ADMIN_TOKEN = ADMIN;
    await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "m1", secret: m1.secret });
    for (const call of [
      () => t.query(api.connector.work, { machine: { id: "m1", secret: "wrong-secret-0123456789" } }),
      () => t.query(api.connector.work, { machine: { id: "nope", secret: m1.secret } }),
      () => t.mutation(api.connector.receive, { machine: { id: "m1", secret: "wrong-secret-0123456789" }, as: "a", locator: "loc-a" }),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<{ code: string; message: string }>).data).toEqual({ code: "forbidden", message: "machine credential rejected" });
    }
  });
});
