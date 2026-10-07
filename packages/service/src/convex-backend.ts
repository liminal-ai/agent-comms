// A web backend that forwards the web view's calls to a Convex deployment, adding the admin
// token from a file on this host. The browser never sees the token; it sends none.
// Only the web modules' public functions are reachable (the same set the local service allows).

import { readFile } from "node:fs/promises";
import { anyApi, type FunctionReference } from "convex/server";
import { ConvexClient } from "convex/browser";
import type { FunctionInfo, WebBackend } from "./web.ts";

type Kind = "query" | "mutation";

/** Every public function of the web modules, with its kind. `web-functions.test.ts` checks it against `convex/*.ts`. */
export const WEB_FUNCTIONS: Record<string, Kind> = {
  "alerts:list": "query", "alerts:config": "query", "alerts:setConfig": "mutation",
  "conversations:createGroup": "mutation", "conversations:openDm": "mutation", "conversations:addMember": "mutation",
  "conversations:removeMember": "mutation", "conversations:postAs": "mutation", "conversations:list": "query", "conversations:view": "query",
  "directory:registerMachine": "mutation", "directory:promote": "mutation", "directory:rebind": "mutation", "directory:setState": "mutation",
  "directory:list": "query", "directory:upgrade": "mutation", "directory:markAlertHistory": "mutation",
  "inbox:list": "query", "inbox:unreadCount": "query", "inbox:markRead": "mutation",
  "registry:list": "query", "registry:setProfile": "mutation",
  "reminders:list": "query", "reminders:get": "query", "reminders:create": "mutation", "reminders:update": "mutation",
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
      const full = await withToken(args);
      return kind === "query" ? client.query(ref(name) as FunctionReference<"query">, full) : client.mutation(ref(name) as FunctionReference<"mutation">, full);
    },
    subscribe(name: string, args: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void): () => void {
      if (WEB_FUNCTIONS[name] !== "query") throw new Error(`Could not find public function for '${name}'`);
      let stop: (() => void) | undefined;
      let stopped = false;
      // A subscription carries the token it started with. If the token is rotated while a page is
      // open, the query is refused once; re-subscribe with the file's current token, then give up.
      const open = (retried: boolean) =>
        withToken(args).then((full) => {
          if (stopped) return;
          stop = client.onUpdate(ref(name) as FunctionReference<"query">, full, onValue, (error) => {
            if (!retried && /admin token rejected/.test(error.message)) {
              stop?.();
              stop = undefined;
              void open(true);
              return;
            }
            onError(error);
          });
        }, onError);
      void open(false);
      return () => {
        stopped = true;
        stop?.();
      };
    },
    close: () => client.close(),
  };
}
