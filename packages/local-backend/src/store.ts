// The SQLite store: documents as JSON, one row per index entry keyed by an
// order-preserving byte key, a meta table naming the store's mode and format.
// One process owns the file (exclusive locking); a second opener fails.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { checkSupported, concat, encodeKeyPart, fieldAt, fromStored, KEY_END, mismatch, toStored, type ValidatorJson } from "./values.ts";

export const STORE_FORMAT = "1";
export const STORE_MODE = "local";

export interface IndexInfo {
  name: string;
  fields: string[];
}

export interface TableInfo {
  name: string;
  validator: ValidatorJson;
  indexes: IndexInfo[];
}

export type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

export class StoreError extends Error {
  override name = "StoreError";
}

/** The tables of a Convex `defineSchema` result (convex 1.46). */
export function tablesOf(schema: unknown): TableInfo[] {
  const s = schema as { tables?: Record<string, { validator?: { json: ValidatorJson }; indexes?: { indexDescriptor: string; fields: string[] }[]; searchIndexes?: unknown[]; vectorIndexes?: unknown[]; stagedDbIndexes?: unknown[] }>; schemaValidation?: boolean };
  if (!s.tables) throw new StoreError("not a Convex schema");
  return Object.entries(s.tables).map(([name, t]) => {
    if (t.searchIndexes?.length || t.vectorIndexes?.length || t.stagedDbIndexes?.length) throw new StoreError(`table ${name}: local mode supports only database indexes`);
    const validator = t.validator?.json ?? ({ type: "any" } as const);
    checkSupported(validator, name);
    const indexes = (t.indexes ?? []).map((i) => ({ name: i.indexDescriptor, fields: i.fields }));
    return { name, validator, indexes };
  });
}

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const encode32 = (bytes: Uint8Array, n: number) => Array.from(bytes.subarray(0, n), (b) => BASE32[b & 31]).join("");

export class Store {
  readonly db: DatabaseSync;
  readonly storeId: string;
  readonly tables: Map<string, TableInfo & { tag: string; allIndexes: IndexInfo[] }>;
  private readonly tagToTable = new Map<string, string>();
  private readonly st: Record<string, StatementSync>;
  private readonly scans = new Map<string, StatementSync>();
  private lastCreation = 0;
  /** Writes since the counter was last taken (change notification). */
  writes = 0;

  /**
   * Opens `path`. A store is created only with `create`, and only where there's
   * no database yet (no file, or a file with no tables: an initialization that
   * never committed). `create` runs under the store's lock before the store is
   * written, and returns extra metadata to record with it. An existing file must
   * already be a local-mode store of this format. Nothing is ever reset or dropped.
   */
  constructor(path: string, tables: TableInfo[], options: { create?: () => Record<string, string> } = {}) {
    const existed = path === ":memory:" || existsSync(path);
    if (!existed && !options.create) throw new StoreError(`${path} doesn't exist; refusing to create a store here`);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 0");
      // Held for the life of the connection: a second service opening the file fails.
      this.db.exec("PRAGMA locking_mode = EXCLUSIVE");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("BEGIN EXCLUSIVE; COMMIT");
    } catch (error) {
      this.db.close();
      if (/locked|busy/i.test((error as Error).message)) throw new StoreError(`${path} is in use by another comms service; refusing to start a second writer`);
      throw error;
    }
    this.tables = new Map();
    for (const t of tables) {
      const tag = encode32(createHash("sha256").update(t.name).digest(), 4);
      const clash = this.tagToTable.get(tag);
      if (clash) throw new StoreError(`tables ${clash} and ${t.name} have the same id tag; rename one`);
      this.tagToTable.set(tag, t.name);
      const allIndexes = [...t.indexes, { name: "by_creation_time", fields: ["_creationTime"] }];
      this.tables.set(t.name, { ...t, tag, allIndexes });
    }
    try {
      this.storeId = this.init(options.create);
    } catch (error) {
      this.db.close();
      // Opening created the file: take it away again rather than leave an empty database behind.
      if (!existed) for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
      throw error;
    }
    this.st = {
      get: this.db.prepare("SELECT tbl, body FROM documents WHERE id = ?"),
      insertDoc: this.db.prepare("INSERT INTO documents (id, tbl, creation, body) VALUES (?, ?, ?, ?)"),
      updateDoc: this.db.prepare("UPDATE documents SET body = ? WHERE id = ?"),
      deleteDoc: this.db.prepare("DELETE FROM documents WHERE id = ?"),
      insertEntry: this.db.prepare("INSERT INTO entries (tbl, idx, key, id) VALUES (?, ?, ?, ?)"),
      deleteEntry: this.db.prepare("DELETE FROM entries WHERE tbl = ? AND idx = ? AND key = ?"),
      maxCreation: this.db.prepare("SELECT max(creation) AS m FROM documents"),
    };
    this.lastCreation = Number((this.st.maxCreation!.get() as { m: number | null }).m ?? 0);
  }

  private init(create: (() => Record<string, string>) | undefined): string {
    const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (!hasMeta) {
      const anyTable = this.db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
      if (anyTable) throw new StoreError("this file isn't a comms local-mode store; refusing to use it");
      if (!create) throw new StoreError("this file holds no store; refusing to create one here");
      const extra = create();
      const storeId = randomUUID();
      // The schema and its metadata commit together: a crash leaves no store or a whole one.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE documents (id TEXT PRIMARY KEY, tbl TEXT NOT NULL, creation REAL NOT NULL, body TEXT NOT NULL) STRICT;
          CREATE TABLE entries (tbl TEXT NOT NULL, idx TEXT NOT NULL, key BLOB NOT NULL, id TEXT NOT NULL, PRIMARY KEY (tbl, idx, key)) STRICT, WITHOUT ROWID;
          CREATE INDEX documents_by_table ON documents (tbl);`);
        const put = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
        for (const [k, v] of Object.entries({ ...extra, mode: STORE_MODE, format: STORE_FORMAT, storeId, createdAt: new Date().toISOString(), schema: this.fingerprint() })) put.run(k, v);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return storeId;
    }
    const meta = Object.fromEntries((this.db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    if (meta.mode !== STORE_MODE) throw new StoreError(`this store's mode is ${JSON.stringify(meta.mode)}, not "${STORE_MODE}"; refusing to use it`);
    if (meta.format !== STORE_FORMAT) throw new StoreError(`this store's format is ${JSON.stringify(meta.format)}; this build reads format ${STORE_FORMAT}. Refusing to use it.`);
    if (!meta.storeId) throw new StoreError("this store has no storeId; refusing to use it");
    if (meta.schema !== this.fingerprint()) this.migrateSchema();
    return meta.storeId;
  }

  private fingerprint(): string {
    return JSON.stringify([...this.tables.values()].map((t) => [t.name, t.validator, t.indexes]));
  }

  /**
   * The code's schema changed since this store last ran: every document must still
   * validate (or startup stops, changing nothing), then index entries are rebuilt.
   */
  private migrateSchema(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const unknown = this.db.prepare("SELECT DISTINCT tbl FROM documents").all() as { tbl: string }[];
      for (const { tbl } of unknown) if (!this.tables.has(tbl)) throw new StoreError(`the store has documents in table ${tbl}, which this build's schema doesn't define; refusing to start`);
      const bad: string[] = [];
      for (const row of this.db.prepare("SELECT tbl, body FROM documents").iterate() as Iterable<{ tbl: string; body: string }>) {
        const doc = fromStored<Doc>(row.body);
        const m = this.validateDoc(row.tbl, doc);
        if (m) bad.push(`${row.tbl} ${doc._id}: ${m}`);
        if (bad.length >= 10) break;
      }
      if (bad.length) throw new StoreError(`stored documents don't match this build's schema; refusing to start:\n  ${bad.join("\n  ")}`);
      this.db.exec("DELETE FROM entries");
      const ins = this.db.prepare("INSERT INTO entries (tbl, idx, key, id) VALUES (?, ?, ?, ?)");
      for (const row of this.db.prepare("SELECT tbl, body FROM documents").iterate() as Iterable<{ tbl: string; body: string }>) {
        const doc = fromStored<Doc>(row.body);
        for (const idx of this.tables.get(row.tbl)!.allIndexes) ins.run(row.tbl, idx.name, this.keyOf(idx, doc), doc._id);
      }
      this.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema'").run(this.fingerprint());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  // -------------------------------------------------------------------------
  // Transactions

  begin(): void {
    this.db.exec("BEGIN IMMEDIATE");
  }
  commit(): void {
    this.db.exec("COMMIT");
  }
  rollback(): void {
    if (this.db.isTransaction) this.db.exec("ROLLBACK");
  }
  savepoint(name: string): void {
    this.db.exec(`SAVEPOINT ${name}`);
  }
  release(name: string): void {
    this.db.exec(`RELEASE ${name}`);
  }
  rollbackTo(name: string): void {
    this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
  }

  // -------------------------------------------------------------------------
  // Ids

  newId(table: string): string {
    return encode32(randomBytes(28), 28) + this.tableInfo(table).tag;
  }

  isId(table: string, id: string): boolean {
    const t = this.tables.get(table);
    return !!t && id.length === 32 && /^[0-9a-z]+$/.test(id) && id.slice(28) === t.tag;
  }

  tableOfId(id: string): string | undefined {
    if (id.length !== 32 || !/^[0-9a-z]+$/.test(id)) return undefined;
    return this.tagToTable.get(id.slice(28));
  }

  tableInfo(table: string) {
    const t = this.tables.get(table);
    if (!t) throw new StoreError(`no table ${table} in the schema`);
    return t;
  }

  // -------------------------------------------------------------------------
  // Documents

  get(id: string): { table: string; doc: Doc } | null {
    const row = this.st.get!.get(id) as { tbl: string; body: string } | undefined;
    return row ? { table: row.tbl, doc: fromStored<Doc>(row.body) } : null;
  }

  validateDoc(table: string, doc: Doc): string | undefined {
    const { _id, _creationTime, ...fields } = doc;
    if (typeof _id !== "string" || !this.isId(table, _id)) return "_id isn't an id in this table";
    if (typeof _creationTime !== "number") return "_creationTime isn't a number";
    return mismatch(this.tableInfo(table).validator, fields, (t, id) => this.isId(t, id), "document");
  }

  insert(table: string, fields: Record<string, unknown>): Doc {
    const now = Date.now();
    // Unique and increasing, as Convex's are; ties are broken by the id after it anyway.
    const creation = now > this.lastCreation ? now : this.lastCreation + 1 / 1024;
    const doc = { ...stripUndefined(fields), _id: this.newId(table), _creationTime: creation } as Doc;
    const bad = this.validateDoc(table, doc);
    if (bad) throw new Error(`insert into ${table}: ${bad}`);
    this.st.insertDoc!.run(doc._id, table, creation, toStored(doc));
    for (const idx of this.tableInfo(table).allIndexes) this.st.insertEntry!.run(table, idx.name, this.keyOf(idx, doc), doc._id);
    this.lastCreation = creation;
    this.writes++;
    return doc;
  }

  /** Replaces a document's fields, keeping its system fields. */
  update(table: string, before: Doc, fields: Record<string, unknown>): Doc {
    const doc = { ...stripUndefined(fields), _id: before._id, _creationTime: before._creationTime } as Doc;
    const bad = this.validateDoc(table, doc);
    if (bad) throw new Error(`write to ${table}: ${bad}`);
    this.st.updateDoc!.run(toStored(doc), doc._id);
    for (const idx of this.tableInfo(table).allIndexes) {
      const oldKey = this.keyOf(idx, before);
      const newKey = this.keyOf(idx, doc);
      if (Buffer.compare(oldKey, newKey) === 0) continue;
      this.st.deleteEntry!.run(table, idx.name, oldKey);
      this.st.insertEntry!.run(table, idx.name, newKey, doc._id);
    }
    this.writes++;
    return doc;
  }

  delete(table: string, before: Doc): void {
    this.st.deleteDoc!.run(before._id);
    for (const idx of this.tableInfo(table).allIndexes) this.st.deleteEntry!.run(table, idx.name, this.keyOf(idx, before));
    this.writes++;
  }

  keyOf(idx: IndexInfo, doc: Doc): Buffer {
    const parts = idx.fields.map((f) => encodeKeyPart(fieldAt(doc, f), f));
    if (idx.fields.at(-1) !== "_creationTime") parts.push(encodeKeyPart(doc._creationTime, "_creationTime"));
    parts.push(encodeKeyPart(doc._id, "_id"));
    return Buffer.from(concat(parts));
  }

  /**
   * Up to `limit` documents of an index in key order, within [lower, upper) and
   * strictly after `after` (exclusive, in the scan's direction).
   */
  scan(table: string, index: string, range: { lower: Buffer; upper: Buffer }, desc: boolean, after: Buffer | undefined, limit: number): { key: Buffer; doc: Doc }[] {
    // The query's own range always applies; a cursor only narrows it.
    const cursor = after ? ` AND e.key ${desc ? "<" : ">"} ?` : "";
    const sql = `SELECT e.key AS key, d.body AS body FROM entries e JOIN documents d ON d.id = e.id
      WHERE e.tbl = ? AND e.idx = ? AND e.key >= ? AND e.key < ?${cursor}
      ORDER BY e.key ${desc ? "DESC" : "ASC"} LIMIT ?`;
    let stmt = this.scans.get(sql);
    if (!stmt) this.scans.set(sql, (stmt = this.db.prepare(sql)));
    const params = after ? [table, index, range.lower, range.upper, after, limit] : [table, index, range.lower, range.upper, limit];
    const rows = stmt.all(...params) as { key: Uint8Array; body: string }[];
    return rows.map((r) => ({ key: Buffer.from(r.key), doc: fromStored<Doc>(r.body) }));
  }
}

export const KEY_MAX = Buffer.of(KEY_END);

function stripUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}
