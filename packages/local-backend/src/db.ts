// `ctx.db` over the store: the subset of Convex's DatabaseReader/Writer this
// repository's functions use. Anything else throws Unsupported.

import { createHash } from "node:crypto";
import { type Doc, type Store } from "./store.ts";
import { compareValues, concat, copyValue, encodeKeyPart, fieldAt, isObject, KEY_END, Unsupported } from "./values.ts";

export interface Limits {
  documentsRead?: number;
}

/** Per transaction: documents read, for the optional limit. */
export class Budget {
  read = 0;
  readonly limits: Limits;
  constructor(limits: Limits = {}) {
    this.limits = limits;
  }
  count(n = 1): void {
    this.read += n;
    if (this.limits.documentsRead !== undefined && this.read > this.limits.documentsRead) {
      throw new Error(`Too many documents read in a single function execution (limit: ${this.limits.documentsRead}).`);
    }
  }
}

type Bound = { op: "gt" | "gte" | "lt" | "lte"; value: unknown };

class IndexRange {
  readonly eqs: unknown[] = [];
  lower?: Bound;
  upper?: Bound;
  private readonly fields: string[];
  constructor(fields: string[]) {
    this.fields = fields;
  }
  private next(field: string, what: string): void {
    const at = this.eqs.length;
    if (this.lower || this.upper) {
      if (what === "eq" || field !== this.fields[at]) throw new Unsupported(`index range: ${what} on ${field} after a range bound`);
      return;
    }
    if (this.fields[at] !== field) throw new Error(`index range: expected field ${this.fields[at] ?? "(none)"}, got ${field}`);
  }
  eq(field: string, value: unknown) {
    this.next(field, "eq");
    this.eqs.push(value);
    return this;
  }
  private bound(kind: Bound["op"], field: string, value: unknown) {
    this.next(field, kind);
    if (kind === "gt" || kind === "gte") {
      if (this.lower) throw new Error("index range: two lower bounds");
      this.lower = { op: kind, value };
    } else {
      if (this.upper) throw new Error("index range: two upper bounds");
      this.upper = { op: kind, value };
    }
    return this;
  }
  gt(f: string, v: unknown) { return this.bound("gt", f, v); }
  gte(f: string, v: unknown) { return this.bound("gte", f, v); }
  lt(f: string, v: unknown) { return this.bound("lt", f, v); }
  lte(f: string, v: unknown) { return this.bound("lte", f, v); }

  keys(): { lower: Buffer; upper: Buffer } {
    const prefix = concat(this.eqs.map((v, i) => encodeKeyPart(v, this.fields[i]!)));
    const field = this.fields[this.eqs.length] ?? "_creationTime";
    const end = Uint8Array.of(KEY_END);
    let lower: Uint8Array = prefix;
    let upper: Uint8Array = concat([prefix, end]);
    if (this.lower) {
      const k = concat([prefix, encodeKeyPart(this.lower.value, field)]);
      lower = this.lower.op === "gte" ? k : concat([k, end]);
    }
    if (this.upper) {
      const k = concat([prefix, encodeKeyPart(this.upper.value, field)]);
      upper = this.upper.op === "lt" ? k : concat([k, end]);
    }
    return { lower: Buffer.from(lower), upper: Buffer.from(upper) };
  }
}

// Filter expressions: a value-returning tree, evaluated per document.
type Expr = (doc: Doc) => unknown;
const lit = (v: unknown): Expr => (typeof v === "function" && (v as { __expr?: true }).__expr ? (v as Expr) : () => v);
const expr = (f: Expr): Expr => Object.assign(f, { __expr: true as const });

const filterBuilder = {
  field: (path: string) => expr((d) => fieldAt(d, path)),
  eq: (a: unknown, b: unknown) => expr((d) => compareValues(lit(a)(d), lit(b)(d)) === 0),
  neq: (a: unknown, b: unknown) => expr((d) => compareValues(lit(a)(d), lit(b)(d)) !== 0),
  lt: (a: unknown, b: unknown) => expr((d) => compareValues(lit(a)(d), lit(b)(d)) < 0),
  lte: (a: unknown, b: unknown) => expr((d) => compareValues(lit(a)(d), lit(b)(d)) <= 0),
  gt: (a: unknown, b: unknown) => expr((d) => compareValues(lit(a)(d), lit(b)(d)) > 0),
  gte: (a: unknown, b: unknown) => expr((d) => compareValues(lit(a)(d), lit(b)(d)) >= 0),
  and: (...xs: unknown[]) => expr((d) => xs.every((x) => lit(x)(d) === true)),
  or: (...xs: unknown[]) => expr((d) => xs.some((x) => lit(x)(d) === true)),
  not: (x: unknown) => expr((d) => lit(x)(d) !== true),
};
const unsupportedFilter = new Proxy(filterBuilder, {
  get(target, prop) {
    if (prop in target) return target[prop as keyof typeof target];
    throw new Unsupported(`the filter operator ${String(prop)}`);
  },
});

const BATCH = 128;

class Query {
  private indexName = "by_creation_time";
  private range: IndexRange;
  private desc = false;
  private filters: Expr[] = [];
  private stage: "table" | "indexed" | "ordered" = "table";

  private readonly store: Store;
  private readonly table: string;
  private readonly budget: Budget;
  constructor(store: Store, table: string, budget: Budget) {
    this.store = store;
    this.table = table;
    this.budget = budget;
    this.range = new IndexRange(["_creationTime"]);
  }

  withIndex(name: string, build?: (q: IndexRange) => IndexRange) {
    if (this.stage !== "table") throw new Error("withIndex must come first");
    const idx = this.store.tableInfo(this.table).allIndexes.find((i) => i.name === name);
    if (!idx) throw new Error(`table ${this.table} has no index ${name}`);
    this.indexName = name;
    this.range = new IndexRange(idx.fields);
    if (build) build(this.range);
    this.stage = "indexed";
    return this;
  }
  withSearchIndex(): never {
    throw new Unsupported("search indexes");
  }
  order(order: "asc" | "desc") {
    if (this.stage === "ordered") throw new Error("order was already set");
    this.desc = order === "desc";
    this.stage = "ordered";
    return this;
  }
  filter(build: (q: typeof filterBuilder) => unknown) {
    this.filters.push(lit(build(unsupportedFilter)));
    return this;
  }

  /** Matching documents in order, from the key after `after`. */
  private async *rows(after?: Buffer): AsyncGenerator<{ key: Buffer; doc: Doc }> {
    const range = this.range.keys();
    let cursor = after;
    for (;;) {
      const batch = this.store.scan(this.table, this.indexName, range, this.desc, cursor, BATCH);
      for (const row of batch) {
        this.budget.count();
        cursor = row.key;
        if (this.filters.every((f) => f(row.doc) === true)) yield row;
      }
      if (batch.length < BATCH) return;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Doc> {
    for await (const row of this.rows()) yield row.doc;
  }
  async collect(): Promise<Doc[]> {
    const out: Doc[] = [];
    for await (const row of this.rows()) out.push(row.doc);
    return out;
  }
  async take(n: number): Promise<Doc[]> {
    const out: Doc[] = [];
    if (n <= 0) return out;
    for await (const row of this.rows()) {
      out.push(row.doc);
      if (out.length >= n) break;
    }
    return out;
  }
  async first(): Promise<Doc | null> {
    return (await this.take(1))[0] ?? null;
  }
  async unique(): Promise<Doc | null> {
    const two = await this.take(2);
    if (two.length > 1) throw new Error(`unique() query returned more than one result from table ${this.table}`);
    return two[0] ?? null;
  }
  /**
   * A cursor names the query it came from (table, index, range, order) as well as
   * a position, and is refused by any other query: a cursor can't move a query
   * outside its own range.
   */
  async paginate(opts: { numItems: number; cursor: string | null }): Promise<{ page: Doc[]; isDone: boolean; continueCursor: string }> {
    const identity = this.identity();
    const after = opts.cursor ? decodeCursor(opts.cursor, identity) : undefined;
    const page: Doc[] = [];
    let last = after;
    let isDone = true;
    for await (const row of this.rows(after)) {
      if (page.length >= opts.numItems) {
        isDone = false;
        break;
      }
      page.push(row.doc);
      last = row.key;
    }
    const range = this.range.keys();
    return { page, isDone, continueCursor: encodeCursor(identity, last ?? (this.desc ? range.upper : range.lower)) };
  }

  private identity(): string {
    const { lower, upper } = this.range.keys();
    return createHash("sha256").update(JSON.stringify([this.table, this.indexName, lower.toString("hex"), upper.toString("hex"), this.desc, this.filters.length])).digest("base64url").slice(0, 16);
  }
  // Convex's other terminal and builder methods aren't used here.
  paginateWithSplit(): never {
    throw new Unsupported("split pagination");
  }
}

const encodeCursor = (identity: string, key: Buffer) => `c${identity}.${key.toString("base64url")}`;
function decodeCursor(cursor: string, identity: string): Buffer {
  const m = /^c([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]*)$/.exec(cursor);
  if (!m || m[1] !== identity) throw new Error("InvalidCursor: this cursor belongs to a different query");
  return Buffer.from(m[2]!, "base64url");
}

export interface DbReader {
  get(id: string): Promise<Doc | null>;
  query(table: string): Query;
  normalizeId(table: string, id: string): string | null;
  system: never;
}

export function makeDb(store: Store, budget: Budget, writable: boolean) {
  const resolve = (tableOrId: string, maybeId?: string): { table: string | undefined; id: string } =>
    maybeId === undefined ? { table: store.tableOfId(tableOrId), id: tableOrId } : { table: tableOrId, id: maybeId };

  const getDoc = (tableOrId: string, maybeId?: string): { table: string; doc: Doc } | null => {
    const { table, id } = resolve(tableOrId, maybeId);
    if (typeof id !== "string") throw new Error("db: an id must be a string");
    if (table && !store.isId(table, id)) throw new Error(`db: not an id in table ${table}`);
    const got = store.get(id);
    if (got) budget.count();
    return got && (!table || got.table === table) ? got : null;
  };

  const reader = {
    get: async (tableOrId: string, maybeId?: string) => getDoc(tableOrId, maybeId)?.doc ?? null,
    query: (table: string) => {
      store.tableInfo(table);
      return new Query(store, table, budget);
    },
    normalizeId: (table: string, id: string) => (typeof id === "string" && store.isId(table, id) ? id : null),
  };
  const noSystemTables = <T extends object>(db: T): T =>
    Object.defineProperty(db, "system", {
      get() {
        throw new Unsupported("system tables");
      },
    });
  if (!writable) return noSystemTables(reader);

  const existing = (tableOrId: string, maybeId: string | undefined, what: string) => {
    const got = getDoc(tableOrId, maybeId);
    if (!got) throw new Error(`${what} on nonexistent document ID ${maybeId ?? tableOrId}`);
    return got;
  };
  const noSystemFields = (value: unknown, what: string) => {
    if (!isObject(value)) throw new Error(`${what}: the value must be an object`);
    for (const k of Object.keys(value)) if (k.startsWith("_") && k !== "_id" && k !== "_creationTime") throw new Error(`${what}: field names can't start with "_"`);
    return value;
  };
  return noSystemTables({
    ...reader,
    insert: async (table: string, value: Record<string, unknown>) => {
      const fields = noSystemFields(clone(value), "insert");
      if ("_id" in fields || "_creationTime" in fields) throw new Error("insert: system fields can't be set");
      return store.insert(table, fields)._id;
    },
    patch: async (tableOrId: string, a: unknown, b?: unknown) => {
      const [maybeId, value] = b === undefined ? [undefined, a] : [a as string, b];
      const { table, doc } = existing(tableOrId, maybeId, "patch");
      const patch = noSystemFields(clone(value), "patch");
      if (patch._id !== undefined && patch._id !== doc._id) throw new Error("patch: _id can't change");
      if (patch._creationTime !== undefined && patch._creationTime !== doc._creationTime) throw new Error("patch: _creationTime can't change");
      const { _id, _creationTime, ...rest } = doc;
      const next: Record<string, unknown> = { ...rest };
      // A field patched to undefined is removed (Convex semantics).
      for (const [k, v] of Object.entries(value as object)) {
        if (k === "_id" || k === "_creationTime") continue;
        if (v === undefined) delete next[k];
        else next[k] = (patch as Record<string, unknown>)[k];
      }
      store.update(table, doc, next);
    },
    replace: async (tableOrId: string, a: unknown, b?: unknown) => {
      const [maybeId, value] = b === undefined ? [undefined, a] : [a as string, b];
      const { table, doc } = existing(tableOrId, maybeId, "replace");
      const { _id, _creationTime, ...fields } = noSystemFields(clone(value), "replace");
      if (_id !== undefined && _id !== doc._id) throw new Error("replace: _id can't change");
      store.update(table, doc, fields);
    },
    delete: async (tableOrId: string, maybeId?: string) => {
      const { table, doc } = existing(tableOrId, maybeId, "delete");
      store.delete(table, doc);
    },
  });
}

/** Values cross into and out of functions as copies, as they would over the wire. */
export const clone = <T>(value: T): T => copyValue(value);
