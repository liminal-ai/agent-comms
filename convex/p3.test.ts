// Fix pass, Reed's P3 list (agreed bugs, Convex side): one-time reminders tell their
// creator; --at at the expiry is refused; a retired creator's reminders stop; names
// refuse C1 controls.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-02T12:00:00Z").getTime();
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
const at = (ms: number) => vi.setSystemTime(new Date(NOW + ms));
const tick = (t: Awaited<ReturnType<typeof setup>>) => t.mutation(internal.reminders.tick, {});
const inboxTexts = async (t: Awaited<ReturnType<typeof setup>>) => (await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee" })).items.map((i) => i.message.text);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("P3 reminders", () => {
  it("bug 1: a one-time --at reminder tells its creator when it ends", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", at: NOW + 10 * MIN, name: "once" });
    at(10 * MIN);
    await tick(t);
    expect((await inboxTexts(t)).some((x) => x.startsWith(`Reminder once (${reminder.id}) was marked done: fired once`))).toBe(true);
  });

  it("bug 2: --at at or after the expiry is refused at creation (it could never fire)", async () => {
    const t = await setup();
    const create = (atMs: number) => t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", at: atMs, expiresMs: 10 * MIN });
    expect(await errorCode(create(NOW + 10 * MIN))).toBe("bad_request");
    expect(await errorCode(create(NOW + 10 * MIN - 1))).toBe("bad_request"); // follow-up (b): a tick to spare
    expect(await errorCode(create(NOW + 9 * MIN))).toBe("no error");
  });

  it("bug 4: a retired creator's reminders are cancelled at the next tick", async () => {
    const t = await setup();
    const { reminder } = await t.mutation(api.connector.remind, { machine: m1, as: "b", target: "a", text: "x", everyMs: MIN });
    await t.mutation(api.directory.setState, { adminToken: ADMIN, name: "b", state: "retired" });
    at(MIN);
    await tick(t);
    const x = (await t.query(api.reminders.get, { adminToken: ADMIN, id: reminder.id })).reminder;
    expect([x.state, x.stateReason, x.fires]).toEqual(["cancelled", "@b (creator) was retired", 0]);
  });

  it("C1 control characters (NEL and the rest of U+0080-U+009F) are refused in names", async () => {
    const t = await setup();
    for (const name of ["a\u0085b", "a\u0080b", "a\u009fb"]) {
      expect(await errorCode(t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "x", everyMs: MIN, name })), JSON.stringify(name)).toBe("bad_request");
    }
  });
});
