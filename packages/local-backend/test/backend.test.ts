// The SQLite backend directly: ordering, writes, transactions, the store's
// guards, subscriptions and what fails closed. The repository's behavior suites
// run on it separately (the convex-sqlite and connector-sqlite projects).

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, internalMutationGeneric as internalMutation, mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../src/runtime.ts";
import { Store, StoreError, tablesOf } from "../src/store.ts";
import { compareValues, encodeKeyPart, fromStored, toStored } from "../src/values.ts";
import { modules as realModules } from "../src/modules.ts";

const schema = defineSchema({
  items: defineTable({ group: v.string(), rank: v.optional(v.number()), note: v.optional(v.string()) })
    .index("by_group_rank", ["group", "rank"]),
  logs: defineTable({ text: v.string() }),
});

const mod = {
  add: mutation({ args: { group: v.string(), rank: v.optional(v.number()) }, handler: (ctx, a) => ctx.db.insert("items", a) }),
  range: query({
    args: { group: v.string(), gt: v.optional(v.number()), lte: v.optional(v.number()), desc: v.optional(v.boolean()) },
    handler: async (ctx, a) => {
      const q = ctx.db.query("items").withIndex("by_group_rank", (q) => {
        const g = q.eq("group", a.group) as any;
        if (a.gt !== undefined && a.lte !== undefined) return g.gt("rank", a.gt).lte("rank", a.lte);
        if (a.gt !== undefined) return g.gt("rank", a.gt);
        if (a.lte !== undefined) return g.lte("rank", a.lte);
        return g;
      });
      return (await q.order(a.desc ? "desc" : "asc").collect()).map((d) => d.rank ?? null);
    },
  }),
  page: query({
    args: { group: v.string(), desc: v.boolean(), cursor: v.union(v.string(), v.null()) },
    handler: async (ctx, a) => {
      const r = await ctx.db.query("items").withIndex("by_group_rank", (q) => q.eq("group", a.group)).order(a.desc ? "desc" : "asc").paginate({ numItems: 1, cursor: a.cursor });
      return { ranks: r.page.map((d) => d.rank ?? null), isDone: r.isDone, cursor: r.continueCursor };
    },
  }),
  patchNote: mutation({ args: { id: v.id("items"), note: v.optional(v.string()) }, handler: (ctx, a) => ctx.db.patch(a.id, { note: a.note }) }),
  get: query({ args: { id: v.id("items") }, handler: (ctx, a) => ctx.db.get(a.id) }),
  count: query({ args: {}, handler: async (ctx) => (await ctx.db.query("logs").collect()).length }),
  log: internalMutation({ args: { text: v.string(), fail: v.optional(v.boolean()) }, handler: async (ctx, a) => {
    await ctx.db.insert("logs", { text: a.text });
    if (a.fail) throw new Error("sub failed");
  } }),
  outer: mutation({ args: {}, handler: async (ctx) => {
    await ctx.db.insert("logs", { text: "outer" });
    try {
      await ctx.runMutation("m:log" as never, { text: "inner-bad", fail: true } as never);
    } catch {}
    await ctx.runMutation("m:log" as never, { text: "inner-good" } as never);
  } }),
  failAfterWrite: mutation({ args: {}, handler: async (ctx) => {
    await ctx.db.insert("logs", { text: "lost" });
    throw new Error("boom");
  } }),
  usesScheduler: mutation({ args: {}, handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, "m:log" as never, {} as never);
  } }),
  usesSearch: query({ args: {}, handler: async (ctx) => (ctx.db.query("items") as unknown as { withSearchIndex(): void }).withSearchIndex() }),
  usesArith: query({ args: {}, handler: async (ctx) => ctx.db.query("items").filter((q) => (q as unknown as { add(a: number, b: number): boolean }).add(1, 2)).collect() }),
  secret: mutation({ args: { token: v.string() }, handler: async () => null }),
};

function fresh(path = ":memory:") {
  return new LocalBackend(new Store(path, tablesOf(schema), { create: () => ({}) }), { m: mod });
}
const call = (b: LocalBackend, kind: "query" | "mutation", name: string, args: unknown = {}) => b.call(kind, `m:${name}`, args);

describe("ordering", () => {
  it("index keys sort exactly as Convex values compare", () => {
    const values: unknown[] = [undefined, null, -Infinity, -1e300, -1, -0, 0, 1e-300, 1, 2.5, 1e300, Infinity, false, true, "", "\u0000", "a", "a\u0000", "ab", "b", "é", "😀", "￿"];
    // Wrapped: Array.prototype.sort puts bare undefined last without asking the comparator.
    const boxed = values.map((value) => ({ value }));
    const byKey = [...boxed].sort((a, b) => Buffer.compare(Buffer.from(encodeKeyPart(a.value, "f")), Buffer.from(encodeKeyPart(b.value, "f")))).map((x) => x.value);
    const byValue = [...boxed].sort((a, b) => compareValues(a.value, b.value)).map((x) => x.value);
    expect(byKey).toEqual(byValue);
    expect(byValue.slice(0, 2)).toEqual([undefined, null]);
  });

  it("serves index ranges in both directions, with missing fields first", async () => {
    const b = fresh();
    for (const rank of [3, 1, 2, undefined, 5, 4]) await call(b, "mutation", "add", { group: "g", ...(rank !== undefined ? { rank } : {}) });
    await call(b, "mutation", "add", { group: "h", rank: 0 });
    expect(await call(b, "query", "range", { group: "g" })).toEqual([null, 1, 2, 3, 4, 5]);
    expect(await call(b, "query", "range", { group: "g", desc: true })).toEqual([5, 4, 3, 2, 1, null]);
    expect(await call(b, "query", "range", { group: "g", gt: 2 })).toEqual([3, 4, 5]);
    expect(await call(b, "query", "range", { group: "g", lte: 2 })).toEqual([null, 1, 2]);
    expect(await call(b, "query", "range", { group: "g", gt: 1, lte: 4, desc: true })).toEqual([4, 3, 2]);
  });

  it("pages stay inside their query's range, both ways, and a cursor can't move to another query", async () => {
    const b = fresh();
    // "a" sorts before "b": a cursor from b's descending pages points below b's range, into a's keys.
    for (const [group, rank] of [["a", 1], ["a", 2], ["b", 1], ["b", 2]] as const) await call(b, "mutation", "add", { group, rank });
    for (const desc of [false, true]) {
      for (const group of ["a", "b"]) {
        const seen: unknown[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 5; i++) {
          const p = (await call(b, "query", "page", { group, desc, cursor })) as { ranks: unknown[]; isDone: boolean; cursor: string };
          seen.push(...p.ranks);
          cursor = p.cursor;
          if (p.isDone) break;
        }
        expect(seen).toEqual(desc ? [2, 1] : [1, 2]);
      }
      const fromB = (await call(b, "query", "page", { group: "b", desc, cursor: null })) as { cursor: string };
      await expect(call(b, "query", "page", { group: "a", desc, cursor: fromB.cursor })).rejects.toThrow(/InvalidCursor/);
      await expect(call(b, "query", "page", { group: "b", desc: !desc, cursor: fromB.cursor })).rejects.toThrow(/InvalidCursor/);
    }
    // Even a forged cursor with the right identity can't leave the range.
    const first = (await call(b, "query", "page", { group: "a", desc: true, cursor: null })) as { cursor: string };
    const forged = first.cursor.replace(/\.[A-Za-z0-9_-]*$/, ".");
    const p = (await call(b, "query", "page", { group: "a", desc: true, cursor: forged })) as { ranks: unknown[] };
    expect(p.ranks).toEqual([]);
  });

  it("keeps NaN, infinities and -0 through storage", () => {
    const doc = { a: Number.NaN, b: Infinity, c: -Infinity, d: -0, e: [1, { f: Number.NaN }] };
    const back = fromStored<typeof doc>(toStored(doc));
    expect(back.a).toBeNaN();
    expect(back.b).toBe(Infinity);
    expect(back.c).toBe(-Infinity);
    expect(Object.is(back.d, -0)).toBe(true);
    expect((back.e[1] as { f: number }).f).toBeNaN();
  });
});

describe("writes and transactions", () => {
  it("removes a field patched to undefined, and validates against the schema", async () => {
    const b = fresh();
    const id = (await call(b, "mutation", "add", { group: "g", rank: 1 })) as string;
    await call(b, "mutation", "patchNote", { id, note: "x" });
    expect(await call(b, "query", "get", { id })).toMatchObject({ note: "x" });
    await call(b, "mutation", "patchNote", { id });
    expect(await call(b, "query", "get", { id })).not.toHaveProperty("note");
    await expect(b.run(async (ctx: any) => ctx.db.insert("items", { group: 1 }))).rejects.toThrow(/document\.group must be a string/);
  });

  it("rolls a failed mutation back entirely", async () => {
    const b = fresh();
    await expect(call(b, "mutation", "failAfterWrite")).rejects.toThrow("boom");
    expect(await call(b, "query", "count")).toBe(0);
  });

  it("rolls back only a failed sub-mutation; the caller's other writes stand", async () => {
    const b = fresh();
    await call(b, "mutation", "outer");
    const texts = await b.run(async (ctx: any) => (await ctx.db.query("logs").collect()).map((d: { text: string }) => d.text));
    expect(texts).toEqual(["outer", "inner-good"]);
  });

  it("validates args without echoing their values, and hides internal functions", async () => {
    const b = fresh();
    const error = await call(b, "mutation", "secret", { token: 12345678 }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/args\.token must be a string/);
    expect((error as Error).message).not.toContain("12345678");
    await expect(call(b, "mutation", "secret", { token: "x", extra: "s3cret" })).rejects.toThrow(/unexpected field "extra"/);
    await expect(b.call("mutation", "m:log", { text: "x" })).rejects.toThrow(/Could not find public function/);
    await expect(b.call("mutation", "m:log", { text: "x" }, { allowInternal: true })).resolves.toBeNull();
  });

  it("fails closed on what local mode doesn't implement", async () => {
    const b = fresh();
    await expect(call(b, "mutation", "usesScheduler")).rejects.toThrow(/doesn't support the scheduler/);
    await expect(call(b, "query", "usesSearch")).rejects.toThrow(/doesn't support search indexes/);
    await expect(call(b, "query", "usesArith")).rejects.toThrow(/doesn't support the filter operator add/);
    expect(() => tablesOf(defineSchema({ t: defineTable({ n: v.int64() }) }))).toThrow(/bigint validator/);
  });
});

describe("the store file", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "comms-local-store-"));

  it("persists across reopening and refuses a second writer", async () => {
    const path = join(dir(), "comms.sqlite");
    const a = fresh(path);
    await call(a, "mutation", "add", { group: "g", rank: 7 });
    expect(() => new Store(path, tablesOf(schema), { create: () => ({}) })).toThrow(/in use by another comms service/);
    await a.close();
    const b = new LocalBackend(new Store(path, tablesOf(schema), {}), { m: mod });
    expect(await call(b, "query", "range", { group: "g" })).toEqual([7]);
    await b.close();
  });

  it("never creates or adopts a store implicitly", () => {
    const d = dir();
    expect(() => new Store(join(d, "missing.sqlite"), tablesOf(schema), {})).toThrow(/doesn't exist/);
    // An empty database file (an initialization that never committed) is only created on request.
    const empty = join(d, "empty.sqlite");
    writeFileSync(empty, "");
    expect(() => new Store(empty, tablesOf(schema), {})).toThrow(/holds no store/);
    const created = new Store(empty, tablesOf(schema), { create: () => ({ note: "x" }) });
    expect(created.meta("note")).toBe("x");
    created.close();
    expect(readdirSync(d).filter((f) => f.startsWith("missing"))).toEqual([]);
    const junk = join(d, "junk.sqlite");
    writeFileSync(junk, "not a database at all, just text that is long enough to be a header......");
    expect(() => new Store(junk, tablesOf(schema), { create: () => ({}) })).toThrow();
  });

  it("refuses another mode, another format, and data the new schema rejects, changing nothing", async () => {
    const path = join(dir(), "comms.sqlite");
    const a = fresh(path);
    await call(a, "mutation", "add", { group: "g", rank: 1 });
    a.store.db.prepare("UPDATE meta SET value = 'convex' WHERE key = 'mode'").run();
    await a.close();
    expect(() => new Store(path, tablesOf(schema), {})).toThrow(/mode is "convex"/);

    const p2 = join(dir(), "comms.sqlite");
    const b = fresh(p2);
    await call(b, "mutation", "add", { group: "g", rank: 1 });
    await b.close();
    const stricter = defineSchema({ items: defineTable({ group: v.string(), rank: v.string() }).index("by_group_rank", ["group", "rank"]), logs: defineTable({ text: v.string() }) });
    expect(() => new Store(p2, tablesOf(stricter), {})).toThrow(/don't match this build's schema/);
    const again = new Store(p2, tablesOf(schema), {});
    expect(again.db.prepare("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 1 });
    again.close();
  });

  it("rebuilds index entries when the schema adds an index", async () => {
    const path = join(dir(), "comms.sqlite");
    const a = fresh(path);
    for (const rank of [2, 1]) await call(a, "mutation", "add", { group: "g", rank });
    await a.close();
    const more = defineSchema({
      items: defineTable({ group: v.string(), rank: v.optional(v.number()), note: v.optional(v.string()) }).index("by_group_rank", ["group", "rank"]).index("by_rank", ["rank"]),
      logs: defineTable({ text: v.string() }),
    });
    const b = new LocalBackend(new Store(path, tablesOf(more), {}), {
      q: { byRank: query({ args: {}, handler: async (ctx) => (await ctx.db.query("items").withIndex("by_rank").collect()).map((d) => d.rank) }) },
    });
    expect(await b.call("query", "q:byRank", {})).toEqual([1, 2]);
    await b.close();
  });
});

describe("subscriptions", () => {
  it("emit the first value, then after commits that change the result, not after rollbacks", async () => {
    const b = fresh();
    const seen: unknown[] = [];
    const stop = b.subscribe("m:count", {}, (v) => seen.push(v), () => {});
    await until(() => seen.length === 1);
    await call(b, "mutation", "failAfterWrite").catch(() => {});
    await call(b, "mutation", "add", { group: "g" }); // writes, but not to logs: same result
    await b.call("mutation", "m:log", { text: "x" }, { allowInternal: true });
    await until(() => seen.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([0, 1]);
    stop();
    expect(b.subscriptionCount).toBe(0);
  });
});

describe("the repository's functions", () => {
  it("are all registered from the static module map", () => {
    const names = readdirSync(new URL("../../../convex/", import.meta.url))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && !["schema.ts", "crons.ts", "validators.ts"].includes(f))
      .map((f) => f.slice(0, -3))
      .sort();
    expect(Object.keys(realModules).sort()).toEqual(names);
  });
});

async function until(f: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
