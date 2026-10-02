// The capabilities pass, R3: reminders. A minute cron (`reminders.tick`) fires
// due reminders as ordinary requests from @reminders; a fire is skipped while the
// previous one isn't final, while the watched participant isn't idle long
// enough, or while its presence is stale; answers are recorded on the fire and
// reported; reminders stop at --max, at expiry, and on done or cancel.

import { renderDelivery } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
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
const tick = (t: T) => t.mutation(internal.reminders.tick, {});
const heartbeat = (t: T) => t.mutation(api.connector.heartbeat, { machine: m1 });
const get = async (t: T, id: string) => t.query(api.reminders.get, { adminToken: ADMIN, id });
const pendingFor = async (t: T, name: string) => {
  const items = (await t.query(api.connector.work, { machine: m1 })).deliveries;
  return items.filter((d) => d.recipient === name && d.state === "pending");
};
const inboxTexts = async (t: T) => (await t.query(api.inbox.list, { adminToken: ADMIN, human: "lee" })).items.map((i) => i.message.text);

async function answerFire(t: T, deliveryId: string, text: string) {
  const { claim } = await t.mutation(api.connector.claim, { machine: m1, deliveryId });
  await t.mutation(api.connector.delivered, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `t-${deliveryId}` });
  return t.mutation(api.connector.collect, { machine: m1, deliveryId, claimId: claim.claimId, turnId: `t-${deliveryId}`, answer: text });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());

describe("adversarial API review", () => {
 it("unrelated remote agent can read reminder details but not its DM", async () => {
  const t = await setup();
  const m2 = {id:"m2",secret:"m2-secret-0123456789"};
  await t.mutation(api.directory.registerMachine,{adminToken:ADMIN,machineId:m2.id,secret:m2.secret});
  await t.mutation(api.directory.promote,{adminToken:ADMIN,name:"outsider",kind:"agent",owner:"lee",home:{machine:"m2",harness:"t3",locator:"remote"}});
  const {reminder} = await t.mutation(api.reminders.create,{adminToken:ADMIN,as:"lee",target:"a",text:"private reminder instructions",everyMs:MIN});
  at(MIN); await tick(t);
  const [fire] = await pendingFor(t,"a");
  await answerFire(t,fire!.id,"private reminder answer");
  expect((await t.query(api.connector.reminders,{machine:m2,as:"outsider"})).reminders).toHaveLength(0);
  const detail = await t.query(api.connector.reminder,{machine:m2,as:"outsider",id:reminder.id});
  expect(detail.reminder.text).toBe("private reminder instructions");
  expect(detail.fires[0]!.answer!.text).toBe("private reminder answer");
  const {delivery} = await t.run(async ctx => ({delivery:await ctx.db.get(fire!.id as any)}));
  expect(await errorCode(t.mutation(api.connector.read,{machine:m2,as:"outsider",conversationId:delivery!.conversationId}))).not.toBe("no error");
 });
});

it("Inbox newest100 + mark visible leaves unreachable old unread", async () => {
 const t = await setup();
 for(let i=0;i<101;i++) {
  at(i);
  await t.mutation(api.connector.send,{machine:m1,as:"a",to:["lee"],text:"inbox "+i,key:"inbox-"+i});
 }
 const first = await t.query(api.inbox.list,{adminToken:ADMIN,human:"lee",limit:100});
 expect(first.unread).toBe(101);
 await t.mutation(api.inbox.markRead,{adminToken:ADMIN,human:"lee",messageIds:first.items.filter(x=>x.readAt===null).map(x=>x.message.id)});
 const second = await t.query(api.inbox.list,{adminToken:ADMIN,human:"lee",limit:100});
 expect(second.unread).toBe(1);
 expect(second.items.filter(x=>x.readAt===null)).toHaveLength(0);
});
