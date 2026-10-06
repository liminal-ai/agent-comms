// convex-test's interface (`t.query`, `t.mutation`, `t.run`) over the SQLite
// backend, so the repository's existing Convex and connector suites run
// unchanged against local mode (vitest aliases `convex-test` to this file in
// the *-sqlite projects).

import { getFunctionName } from "convex/server";
import { LocalBackend, type ModuleMap } from "../src/runtime.ts";
import { Store, tablesOf } from "../src/store.ts";

type Loaders = Record<string, () => Promise<unknown>>;

/** Convex module names (`connector`, `lib/core`) for an `import.meta.glob` of the convex directory. */
export async function loadModules(loaders: Loaders): Promise<ModuleMap> {
  const schemaKey = Object.keys(loaders).find((k) => /(^|\/)schema\.ts$/.test(k));
  if (!schemaKey) throw new Error("convex-test shim: the modules glob has no schema.ts");
  const prefix = schemaKey.slice(0, -"schema.ts".length);
  const out: ModuleMap = {};
  for (const [key, load] of Object.entries(loaders)) {
    if (!key.startsWith(prefix) || !key.endsWith(".ts") || key.endsWith(".d.ts") || key.endsWith(".test.ts")) continue;
    const name = key.slice(prefix.length, -".ts".length);
    if (name.startsWith("_generated/")) continue;
    out[name] = (await load()) as Record<string, unknown>;
  }
  return out;
}

export function convexTest(
  schemaOrOptions: unknown,
  maybeModules?: Loaders,
): {
  query: (ref: unknown, args?: unknown) => Promise<any>;
  mutation: (ref: unknown, args?: unknown) => Promise<any>;
  run: <T>(fn: (ctx: any) => Promise<T>) => Promise<T>;
  backend: () => Promise<LocalBackend>;
} {
  const opts = (maybeModules
    ? { schema: schemaOrOptions, modules: maybeModules }
    : schemaOrOptions) as { schema: unknown; modules: Loaders; transactionLimits?: { documentsRead?: number } };
  let backend: Promise<LocalBackend> | undefined;
  const get = () =>
    (backend ??= loadModules(opts.modules).then(
      (modules) =>
        new LocalBackend(new Store(":memory:", tablesOf(opts.schema), { create: () => ({}) }), modules, {
          ...(opts.transactionLimits ? { limits: opts.transactionLimits } : {}),
        }),
    ));
  return {
    query: async (ref, args) => (await get()).call("query", getFunctionName(ref as never), args ?? {}, { allowInternal: true }),
    mutation: async (ref, args) => (await get()).call("mutation", getFunctionName(ref as never), args ?? {}, { allowInternal: true }),
    run: async (fn) => (await get()).run(fn),
    backend: get,
  };
}
