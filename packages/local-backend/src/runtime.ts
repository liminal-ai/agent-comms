// Runs this repository's Convex functions against the SQLite store, one at a
// time, each in its own transaction. This relies on convex 1.46's registered-
// function fields (`_handler`, `exportArgs`, `isQuery`/`isMutation`,
// `isPublic`/`isInternal`), the same ones convex-test uses. It is pinned to
// that version and is not a general Convex runtime: actions, the scheduler,
// storage, auth, search and system tables fail closed.

import { getFunctionName } from "convex/server";
import { Budget, clone, type Limits, makeDb } from "./db.ts";
import type { Store } from "./store.ts";
import { checkSupported, mismatch, Unsupported, type ValidatorJson } from "./values.ts";

export const PINNED_CONVEX = "1.46.0";

interface Registered {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isPublic?: boolean;
  isInternal?: boolean;
  _handler: (ctx: unknown, args: unknown) => unknown;
  exportArgs: () => string;
}

export type Kind = "query" | "mutation";

export interface FunctionInfo {
  name: string;
  kind: Kind;
  visibility: "public" | "internal";
  fn: Registered;
  args: ValidatorJson;
}

/** `{ "connector": moduleExports, "lib/x": ... }`, keyed as Convex names modules (no extension). */
export type ModuleMap = Record<string, Record<string, unknown>>;

export class ArgumentValidationError extends Error {
  override name = "ArgumentValidationError";
}

export interface Logger {
  (line: string): void;
}

interface Subscription {
  name: string;
  args: unknown;
  onValue: (value: unknown) => void;
  onError: (error: Error) => void;
  last?: string;
  stopped: boolean;
}

export class LocalBackend {
  private readonly functions = new Map<string, FunctionInfo>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly subs = new Set<Subscription>();
  private rerunScheduled = false;
  private depth = 0;
  private closed = false;

  readonly store: Store;
  private readonly options: { limits?: Limits; log?: Logger };
  constructor(store: Store, modules: ModuleMap, options: { limits?: Limits; log?: Logger } = {}) {
    this.store = store;
    this.options = options;
    for (const [module, exports] of Object.entries(modules)) {
      for (const [exportName, value] of Object.entries(exports)) {
        const fn = value as Partial<Registered> | undefined;
        if (!fn || typeof fn !== "function" && typeof fn !== "object") continue;
        if (!fn.isQuery && !fn.isMutation && !fn.isAction) continue;
        const name = `${module}:${exportName}`;
        if (fn.isAction) continue; // registered nowhere: calling one fails as unknown
        if (typeof fn._handler !== "function" || typeof fn.exportArgs !== "function") {
          throw new Unsupported(`${name}: this convex version's function registration (expected ${PINNED_CONVEX})`);
        }
        const args = JSON.parse(fn.exportArgs()) as ValidatorJson;
        checkSupported(args, `${name} args`);
        this.functions.set(name, {
          name,
          kind: fn.isQuery ? "query" : "mutation",
          visibility: fn.isInternal ? "internal" : "public",
          fn: fn as Registered,
          args,
        });
      }
    }
  }

  info(name: string): FunctionInfo | undefined {
    return this.functions.get(name);
  }

  list(): FunctionInfo[] {
    return [...this.functions.values()];
  }

  /** One function, as its own transaction. `allowInternal` is for crons, setup and tests. */
  async call(kind: Kind, name: string, args: unknown, options: { allowInternal?: boolean } = {}): Promise<unknown> {
    if (this.closed) throw new Error("the local backend is closed");
    const f = this.resolve(kind, name, options.allowInternal ?? false);
    return this.exclusive(() => this.transaction(kind === "mutation", (ctx) => this.invoke(f, ctx, args)));
  }

  /** `t.run`: arbitrary code with a writable `ctx`, in one transaction. */
  run<T>(fn: (ctx: unknown) => Promise<T>): Promise<T> {
    return this.exclusive(() => this.transaction(true, fn));
  }

  private resolve(kind: Kind, name: string, allowInternal: boolean): FunctionInfo {
    const f = this.functions.get(name);
    if (!f) throw new Error(`Could not find public function for '${name}'`);
    if (f.visibility === "internal" && !allowInternal) throw new Error(`Could not find public function for '${name}'`);
    if (f.kind !== kind) throw new Error(`${name} is a ${f.kind}, not a ${kind}`);
    return f;
  }

  /** Serializes everything: one connection, so a query must never see a running mutation's writes. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => {});
    return run;
  }

  private async transaction<T>(writable: boolean, body: (ctx: Ctx) => Promise<T>): Promise<T> {
    const store = this.store;
    const before = store.writes;
    const budget = new Budget(this.options.limits);
    store.begin();
    let result: T;
    try {
      result = clone(await body(this.ctx(budget, writable)));
      if (!writable && store.writes !== before) throw new Error("a query wrote to the database");
      store.commit();
    } catch (error) {
      store.rollback();
      store.writes = before;
      throw error;
    }
    if (store.writes !== before) this.changed();
    return result;
  }

  private invoke(f: FunctionInfo, ctx: Ctx, args: unknown): Promise<unknown> {
    const copy = clone(args ?? {});
    const bad = mismatch(f.args, copy, (t, id) => this.store.isId(t, id), "args");
    if (bad) throw new ArgumentValidationError(`${f.name}: ${bad}`);
    // A function that returns nothing returns null, as over the wire.
    return Promise.resolve(f.fn._handler(ctx, copy)).then((out) => (out === undefined ? null : out));
  }

  private ctx(budget: Budget, writable: boolean): Ctx {
    const db = makeDb(this.store, budget, writable);
    const self = this;
    const nested = async (kind: Kind, ref: unknown, args: unknown) => {
      const f = self.resolve(kind, getFunctionName(ref as never), true);
      if (kind === "query") return clone(await self.invoke(f, self.ctx(budget, false), args));
      if (!writable) throw new Error("runMutation from a query");
      // A sub-transaction: its writes are rolled back if it throws, and the caller goes on.
      const sp = `sub${++self.depth}`;
      self.store.savepoint(sp);
      try {
        const out = clone(await self.invoke(f, self.ctx(budget, true), args));
        self.store.release(sp);
        return out;
      } catch (error) {
        self.store.rollbackTo(sp);
        throw error;
      } finally {
        self.depth--;
      }
    };
    const unsupported = (what: string) => () => {
      throw new Unsupported(what);
    };
    return Object.defineProperties({ db } as Ctx, {
      runQuery: { value: (ref: unknown, args: unknown) => nested("query", ref, args) },
      ...(writable ? { runMutation: { value: (ref: unknown, args: unknown) => nested("mutation", ref, args) } } : {}),
      runAction: { get: unsupported("actions") },
      scheduler: { get: unsupported("the scheduler") },
      storage: { get: unsupported("file storage") },
      auth: { get: unsupported("auth (local mode uses the admin token and machine secrets)") },
    });
  }

  // -------------------------------------------------------------------------
  // Subscriptions: re-run every live query after a commit that wrote; emit on change.

  subscribe(name: string, args: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void): () => void {
    const f = this.resolve("query", name, false);
    const sub: Subscription = { name: f.name, args, onValue, onError, stopped: false };
    this.subs.add(sub);
    void this.refresh(sub);
    return () => {
      sub.stopped = true;
      this.subs.delete(sub);
    };
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  private changed(): void {
    if (this.rerunScheduled || this.subs.size === 0) return;
    this.rerunScheduled = true;
    setImmediate(() => {
      this.rerunScheduled = false;
      for (const sub of [...this.subs]) void this.refresh(sub);
    });
  }

  private async refresh(sub: Subscription): Promise<void> {
    try {
      const value = await this.call("query", sub.name, sub.args);
      const key = JSON.stringify(value);
      if (sub.stopped || key === sub.last) return;
      sub.last = key;
      sub.onValue(value);
    } catch (error) {
      if (!sub.stopped && !this.closed) sub.onError(error as Error);
    }
  }

  // -------------------------------------------------------------------------
  // Crons: each runs once at startup (catching up whatever came due while
  // stopped; the sweeps are state scans), then on its interval. A run still in
  // progress isn't overlapped.

  startCrons(crons: unknown): () => void {
    const jobs = Object.entries((crons as { crons?: Record<string, { name: string; args: unknown[]; schedule: Record<string, unknown> }> }).crons ?? {});
    const timers: NodeJS.Timeout[] = [];
    for (const [id, job] of jobs) {
      const s = job.schedule;
      if (s.type !== "interval") throw new Unsupported(`cron ${id}: ${String(s.type)} schedules`);
      const ms = ((s.seconds as number | undefined) ?? 0) * 1_000 + ((s.minutes as number | undefined) ?? 0) * 60_000 + ((s.hours as number | undefined) ?? 0) * 3_600_000;
      if (!(ms > 0)) throw new Error(`cron ${id}: no interval`);
      const f = this.resolve("mutation", job.name, true);
      let running = false;
      const fire = async () => {
        if (running || this.closed) return;
        running = true;
        try {
          await this.call("mutation", f.name, job.args[0] ?? {}, { allowInternal: true });
        } catch (error) {
          this.options.log?.(`cron ${id}: failed: ${(error as Error).name}: ${(error as Error).message}`);
        } finally {
          running = false;
        }
      };
      void fire();
      const timer = setInterval(fire, ms);
      timer.unref?.();
      timers.push(timer);
    }
    return () => {
      for (const t of timers) clearInterval(t);
    };
  }

  /** Waits for in-flight work, then closes the store. */
  async close(): Promise<void> {
    this.closed = true;
    for (const s of this.subs) s.stopped = true;
    this.subs.clear();
    await this.chain.catch(() => {});
    this.store.close();
  }

  // -------------------------------------------------------------------------

  /** The connector's view: the same interface its Convex client provides. */
  transport() {
    return {
      query: (ref: unknown, args: unknown) => this.call("query", getFunctionName(ref as never), args),
      mutation: (ref: unknown, args: unknown) => this.call("mutation", getFunctionName(ref as never), args),
      watch: (ref: unknown, args: unknown, onValue: (v: unknown) => void, onError: (e: Error) => void) =>
        this.subscribe(getFunctionName(ref as never), args, onValue, onError),
    };
  }
}

type Ctx = { db: unknown; runQuery?: unknown; runMutation?: unknown };
