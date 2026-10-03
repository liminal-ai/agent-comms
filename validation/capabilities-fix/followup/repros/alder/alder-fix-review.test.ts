// Fix pass 1.3: no fixed-size reads over growing history. 600 finished rows (expired
// reminders, answer deliveries, old uncertain deliveries) under a 400-document read
// limit must not hide a new expiry, reclaim or uncertain delivery, nor make a scan fail.
// Includes Alder's repros (historical expired reminders; 500 old expiries).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "test-admin-token";
const m1 = { id: "m1", secret: "m1-secret-0123456789" };
const NOW = new Date("2026-10-02T12:00:00Z").getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HISTORY = 600;

async function setup() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest({ schema, modules, transactionLimits: { documentsRead: 100000 } });
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
const beat = (t: T) => t.mutation(api.connector.heartbeat, { machine: m1 });
const alerts = async (t: T) => (await t.query(api.alerts.list, { adminToken: ADMIN, limit: 200 })).alerts;

/** One conversation and message, and `n` deliveries to @b of it in the given state, last changed `ago` ms before NOW. */
async function seedDeliveries(t: T, n: number, fields: { state: "delivered" | "uncertain" | "replied"; collect: boolean; ago: number; claimCount?: number }) {
  return t.run(async (ctx) => {
    const b = (await ctx.db.query("participants").withIndex("by_name", (q) => q.eq("name", "b")).unique())!;
    const conversationId = await ctx.db.insert("conversations", { kind: "group", title: "history", lastSeq: 1, lastAt: NOW, createdAt: NOW });
    const messageId = await ctx.db.insert("messages", {
      conversationId, seq: 1, senderId: b._id, recipientIds: [b._id], kind: "answer", text: "x", attachments: [], origin: { via: "cli" }, createdAt: NOW - fields.ago,
    });
    const ids: Id<"deliveries">[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(await ctx.db.insert("deliveries", {
        messageId, conversationId, recipientId: b._id, collect: fields.collect, state: fields.state, at: NOW - fields.ago - i,
        ...(fields.claimCount !== undefined ? { claimCount: fields.claimCount } : {}), createdAt: NOW - fields.ago - i,
      }));
    }
    return ids;
  });
}

/** `n` reminders already expired long ago. */
async function seedExpiredReminders(t: T, n: number) {
  const { reminder } = await t.mutation(api.reminders.create, { adminToken: ADMIN, as: "lee", target: "a", text: "template", everyMs: MIN });
  await t.run(async (ctx) => {
    const row = (await ctx.db.get(reminder.id as Id<"reminders">))!;
    const { _id, _creationTime, ...base } = row;
    await ctx.db.delete(_id);
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("reminders", { ...base, state: "expired", stateAt: NOW - 30 * DAY - i, expiresAt: NOW - 30 * DAY - i, nextFireAt: undefined });
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => vi.useRealTimers());


it("review: an uncertain delivery is still alerted after scheduler downtime", async () => {
 const t=await setup();
 const [id]=await seedDeliveries(t,1,{state:"uncertain",collect:true,ago:2*60*MIN});
 await t.mutation(internal.alerts.scan,{});
 expect((await alerts(t)).some(a=>a.subject.id===id)).toBe(true);
});
it("review: unresolved reclaimed rows do not starve a later incident", async () => {
 const t=await setup();
 await seedDeliveries(t,500,{state:"delivered",collect:true,ago:MIN,claimCount:1});
 const [id]=await seedDeliveries(t,1,{state:"delivered",collect:true,ago:0,claimCount:9});
 await t.mutation(internal.alerts.scan,{});
 await t.mutation(internal.alerts.scan,{});
 expect((await alerts(t)).some(a=>a.subject.id===id)).toBe(true);
});
it("review: inbox cursor does not drop items sharing a timestamp", async () => {
 const t=await setup();
 for(let i=0;i<3;i++) await t.mutation(api.connector.send,{machine:m1,as:"a",to:["lee"],text:`item ${i}`,key:`review-item-${i}`});
 const p1=await t.query(api.inbox.list,{adminToken:ADMIN,human:"lee",limit:2});
 const p2=await t.query(api.inbox.list,{adminToken:ADMIN,human:"lee",limit:2,before:p1.nextBefore});
 expect(p1.items.length+p2.items.length).toBe(3);
});

it("review: resolving incidents makes progress past 500 still-open incidents",async()=>{
 const t=await setup();
 const ids=await seedDeliveries(t,501,{state:"uncertain",collect:true,ago:2*60*MIN});
 const lastAlert=await t.run(async ctx=>{
   const lee=(await ctx.db.query("participants").withIndex("by_name",q=>q.eq("name","lee")).unique())!;
   let last;
   for(const id of ids){const d=(await ctx.db.get(id))!;last=await ctx.db.insert("alerts",{cause:"uncertain-delivery",subjectKind:"delivery",subjectId:id,ownerId:lee._id,messageId:d.messageId,conversationId:d.conversationId,openedAt:NOW-60*MIN,summary:"incident"});}
   await ctx.db.patch(ids.at(-1)!,{state:"replied"});return last!;
 });
 await t.mutation(internal.alerts.scan,{});
 await t.mutation(internal.alerts.scan,{});
 expect((await t.run(ctx=>ctx.db.get(lastAlert)))!.resolvedAt).toBe(NOW);
});
