// A web backend that forwards the web view's calls to a Convex deployment, adding the admin
// token from a file on this host. The browser never sees the token; it sends none.
// Only the web modules' public functions are reachable (the same set the local service allows).

import { readFile } from "node:fs/promises";
import { anyApi, type FunctionReference } from "convex/server";
import { ConvexClient } from "convex/browser";
import type { FunctionInfo, WebBackend } from "./web.ts";

type Kind = "query" | "mutation";

/** Exactly the functions the page calls (`apps/web/src`), checked by `web-proxy.test.ts`. Nothing else is reachable through the proxy: not `connector:*`, not `directory:registerMachine` or `directory:upgrade`. */
export const WEB_FUNCTIONS: Record<string, Kind> = {
  "alerts:config": "query", "alerts:list": "query", "alerts:setConfig": "mutation",
  "conversations:addMember": "mutation", "conversations:createGroup": "mutation", "conversations:list": "query",
  "conversations:postAs": "mutation", "conversations:removeMember": "mutation", "conversations:view": "query",
  "directory:list": "query", "directory:promote": "mutation", "directory:setState": "mutation",
  "inbox:list": "query", "inbox:markRead": "mutation",
  "registry:list": "query", "registry:setProfile": "mutation",
  "reminders:create": "mutation", "reminders:get": "query", "reminders:list": "query", "reminders:update": "mutation",
};

export interface ConvexLike {
  query(ref: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
  mutation(ref: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
  onUpdate(ref: FunctionReference<"query">, args: Record<string, unknown>, onValue: (value: unknown) => void, onError?: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface ConvexBackendOptions {
  convexUrl: string;
  /** Read at each call, so the token can be rotated without a restart. */
  adminTokenFile: string;
  client?: ConvexLike;
  log?: (line: string) => void;
}

/** The Convex client's own logging prints server errors, which can echo a call's arguments, the admin token among them. Only the error code gets through. */
function quietLogger(log: (line: string) => void) {
  const quiet = (level: string) => (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    const code = /"code":"([a-z_]+)"/.exec(text)?.[1];
    log(`convex ${level}: ${code ? `refused (${code})` : "details withheld"}`);
  };
  return { log: () => {}, logVerbose: () => {}, warn: quiet("warn"), error: quiet("error") };
}

/**
 * What a caller may learn from a failed call. A ConvexError's `data` is our own server code's
 * `{code, message}` and is passed through. Any other error (argument validation echoes the whole
 * call, injected token included) is reduced to its kind.
 */
export function scrubbed(error: unknown): Error & { data?: unknown } {
  const data = (error as { data?: unknown })?.data;
  if (data !== undefined) return error as Error & { data?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  // Our own requireAdmin text, which never carries arguments; the page and the re-subscribe logic key on it.
  // The Convex client wraps it as "[CONVEX Q(name)] [Request ID: …] Server Error\nUncaught Error: admin token rejected …"; match that line wherever it is.
  if (/^admin token rejected$/.test(message) || /^(?:Uncaught )?Error: admin token rejected\b/m.test(message)) return new Error("admin token rejected");
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "EACCES" || code === "EISDIR" || /admin token file is empty/.test(message)) return new Error("request failed (the admin token is not available on the server)");
  const kind = /ArgumentValidationError|Validator/.test(message) ? "the server refused the call's arguments" : /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|WebSocket)\b/i.exec(message)?.[1] ?? "details withheld";
  return new Error(`request failed (${kind})`);
}

export function convexWebBackend(options: ConvexBackendOptions): WebBackend & { close(): Promise<void> } {
  const log = options.log ?? (() => {});
  const client: ConvexLike = options.client ?? new ConvexClient(options.convexUrl, { unsavedChangesWarning: false, logger: quietLogger(log) });
  const token = async () => {
    const t = (await readFile(options.adminTokenFile, "utf8")).trim();
    if (!t) throw new Error("admin token file is empty");
    return t;
  };
  const ref = (name: string) => {
    const [module, fn] = name.split(":") as [string, string];
    return (anyApi as unknown as Record<string, Record<string, FunctionReference<Kind>>>)[module]![fn]!;
  };
  // The client's own adminToken (the page sends a placeholder) is always replaced.
  const withToken = async (args: unknown) => ({ ...(typeof args === "object" && args ? (args as Record<string, unknown>) : {}), adminToken: await token() });
  return {
    info(name: string): FunctionInfo | undefined {
      const kind = WEB_FUNCTIONS[name];
      return kind ? ({ name, kind, visibility: "public" } as FunctionInfo) : undefined;
    },
    async call(kind: Kind, name: string, args: unknown): Promise<unknown> {
      if (WEB_FUNCTIONS[name] !== kind) throw new Error(`Could not find public function for '${name}'`);
      try {
        // Token loading is inside the guard too: a filesystem error names the token file's path.
        const full = await withToken(args);
        return await (kind === "query" ? client.query(ref(name) as FunctionReference<"query">, full) : client.mutation(ref(name) as FunctionReference<"mutation">, full));
      } catch (error) {
        throw scrubbed(error);
      }
    },
    subscribe(name: string, args: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void): () => void {
      if (WEB_FUNCTIONS[name] !== "query") throw new Error(`Could not find public function for '${name}'`);
      let stop: (() => void) | undefined;
      let stopped = false;
      // A subscription carries the token it started with. If the token is rotated while a page is
      // open, the query is refused once; re-subscribe with the file's current token, then give up.
      // Each rotation gets one retry: the flag clears once the refreshed query delivers a value.
      let retried = false;
      const open = () =>
        withToken(args).then((full) => {
          if (stopped) return;
          stop = client.onUpdate(
            ref(name) as FunctionReference<"query">,
            full,
            (value) => {
              retried = false;
              onValue(value);
            },
            (error) => {
              if (!retried && /admin token rejected/.test(error.message)) {
                retried = true;
                stop?.();
                stop = undefined;
                void open();
                return;
              }
              onError(scrubbed(error));
            },
          );
        }).catch((error: unknown) => onError(scrubbed(error))); // token loading and a synchronous onUpdate throw alike
      void open();
      return () => {
        stopped = true;
        stop?.();
      };
    },
    close: () => client.close(),
  };
}
