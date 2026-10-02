// The capabilities pass, R4: alerts. A minute cron (`alerts.scan`) opens an
// incident, and posts one alert from @alerts to the affected agent's owner, when
// a condition starts; the incident resolves when it clears, and a recurrence is
// a new incident with a new alert. Recovery isn't announced.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-01T12:00:00Z").getTime();
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
const scan = (t: T) => t.mutation(internal.alerts.scan, {});
const alerts = async (t: T) => (await t.query(api.alerts.list, { adminToken: ADMIN })).alerts;
const inbox = async (t: T) => (await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee" })).items;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

it("recent expiry is alerted even after 500 old expiries", async () => {
  const t = await setup();
  const {reminder} = await t.mutation(api.reminders.create,{adminToken:ADMIN,as:"lee",target:"a",text:"x",everyMs:MIN});
  await t.run(async ctx=>{
    const seed=await ctx.db.get(reminder.id as never);
    const {_id,_creationTime,...body}=seed! as any;
    await ctx.db.delete(_id);
    for(let i=0;i<500;i++) await ctx.db.insert("reminders",{...body,state:"expired",stateAt:NOW-2*24*60*MIN,nextFireAt:undefined});
    await ctx.db.insert("reminders",{...body,name:"new-expiry",state:"expired",stateAt:NOW,nextFireAt:undefined});
  });
  await scan(t);
  expect((await alerts(t)).some(x=>x.cause==="reminder-expired")).toBe(true);
});
