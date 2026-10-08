// The web view's data access. Convex mode is convex/react as before; local mode
// talks to the local comms service: calls over POST /api/call and every live
// query over one authenticated streaming POST /api/watch (fetch, so the token
// travels in a header, never a URL). The page picks the mode once at startup.

import * as convexReact from "convex/react";
import { getFunctionName } from "convex/server";
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from "react";

export type Mode = "convex" | "local" | "proxy";
let mode: Mode = "convex";
let local: LocalClient | undefined;

const TOKEN_KEY = "agent-comms.adminToken";

/** Local mode: a `#token=` link is taken once into this tab's session, then removed from the address bar. */
export function startLocal(): void {
  mode = "local";
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    history.replaceState(null, "", location.pathname + location.search);
  }
  local = new LocalClient(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
}

/** Proxy mode: the served page's own server holds the admin token and adds it to every call; the page has none. */
export function startProxy(): void {
  mode = "proxy";
  local = new LocalClient(() => "");
}

const PROXY_PLACEHOLDER = "(held by the server)";

/** After an error boundary reset: drop every failed live query so the remount subscribes afresh instead of re-reading a cached error. */
export function resetFailed(): void {
  local?.resetFailed();
}
export const tokens = {
  get: () => (mode === "proxy" ? PROXY_PLACEHOLDER : (mode === "local" ? sessionStorage : localStorage).getItem(TOKEN_KEY) ?? ""),
  set: (t: string) => mode !== "proxy" && (mode === "local" ? sessionStorage : localStorage).setItem(TOKEN_KEY, t),
  forget: () => mode !== "proxy" && (mode === "local" ? sessionStorage : localStorage).removeItem(TOKEN_KEY),
};

export function BackendProvider({ convexUrl, children }: { convexUrl?: string; children: ReactNode }) {
  const client = useMemo(() => (mode === "convex" && convexUrl ? new convexReact.ConvexReactClient(convexUrl) : undefined), [convexUrl]);
  if (mode !== "convex") return <>{children}</>;
  if (!client) throw new Error("This deployment has no Convex URL");
  return <convexReact.ConvexProvider client={client}>{children}</convexReact.ConvexProvider>;
}

// The mode never changes after startup, so each component always calls the same hooks.
export const useQuery = ((ref: unknown, ...rest: unknown[]) =>
  mode !== "convex" ? useLocalQuery(ref, rest[0]) : (convexReact.useQuery as (r: unknown, ...a: unknown[]) => unknown)(ref, ...rest)) as typeof convexReact.useQuery;

export const useMutation = ((ref: unknown) =>
  mode !== "convex" ? useLocalMutation(ref) : (convexReact.useMutation as (r: unknown) => unknown)(ref)) as typeof convexReact.useMutation;

function useLocalQuery(ref: unknown, args: unknown): unknown {
  const name = getFunctionName(ref as never);
  const skip = args === "skip";
  const key = skip ? "" : `${name}\u0000${JSON.stringify(args ?? {})}`;
  const entry = useMemo(() => (skip ? undefined : local!.entry(key, name, args ?? {})), [key]);
  const subscribe = useCallback((onChange: () => void) => (entry ? entry.listen(onChange) : () => {}), [entry]);
  const snapshot = useSyncExternalStore(subscribe, () => entry?.state);
  if (snapshot?.error) throw snapshot.error;
  return snapshot?.value;
}

function useLocalMutation(ref: unknown) {
  const name = getFunctionName(ref as never);
  return useCallback((args: unknown) => local!.call("mutation", name, args ?? {}), [name]);
}

class RemoteError extends Error {
  readonly data: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.data = data;
  }
}

interface Entry {
  name: string;
  args: unknown;
  state: { value?: unknown; error?: Error } | undefined;
  listeners: Set<() => void>;
  listen(onChange: () => void): () => void;
}

class LocalClient {
  private readonly entries = new Map<string, Entry>();
  private stream?: AbortController;
  private reopenTimer?: ReturnType<typeof setTimeout>;
  private backoff = 250;

  private readonly token: () => string;
  constructor(token: () => string) {
    this.token = token;
  }

  private headers(): Record<string, string> {
    const token = this.token();
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  async call(kind: "query" | "mutation", name: string, args: unknown): Promise<unknown> {
    const response = await fetch("/api/call", { method: "POST", headers: this.headers(), body: JSON.stringify({ kind, name, args }) });
    const body = (await response.json().catch(() => ({}))) as { value?: unknown; error?: { message: string; data?: unknown } };
    if (!response.ok || body.error) throw new RemoteError(body.error?.message ?? `request failed (${response.status})`, body.error?.data);
    return body.value;
  }

  entry(key: string, name: string, args: unknown): Entry {
    let e = this.entries.get(key);
    if (e) return e;
    const listeners = new Set<() => void>();
    e = {
      name,
      args,
      state: undefined,
      listeners,
      listen: (onChange) => {
        listeners.add(onChange);
        if (listeners.size === 1) this.reopen();
        return () => {
          listeners.delete(onChange);
          // Kept briefly, so a re-render that resubscribes doesn't churn the stream.
          setTimeout(() => {
            if (listeners.size === 0 && this.entries.get(key) === e) {
              this.entries.delete(key);
              this.reopen();
            }
          }, 1_000);
        };
      },
    };
    this.entries.set(key, e);
    return e;
  }

  resetFailed(): void {
    let changed = false;
    for (const [key, e] of this.entries) {
      if (e.state?.error) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.reopen();
  }

  /** The watched set changed: one new stream carries all of it. */
  private reopen(): void {
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => void this.open(), 10);
  }

  private async open(): Promise<void> {
    this.stream?.abort();
    const live = [...this.entries].filter(([, e]) => e.listeners.size > 0);
    if (live.length === 0) return;
    const controller = new AbortController();
    this.stream = controller;
    const queries = live.map(([id, e]) => ({ id, name: e.name, args: e.args }));
    try {
      const response = await fetch("/api/watch", { method: "POST", headers: this.headers(), body: JSON.stringify({ queries }), signal: controller.signal });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { error?: { message: string } };
        throw new RemoteError(body.error?.message ?? `watch failed (${response.status})`);
      }
      this.backoff = 250;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line) this.deliver(JSON.parse(line) as { id?: string; value?: unknown; error?: { message: string; data?: unknown } });
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      // A refused token is shown to the page (it asks for the token again); anything else retries.
      if (error instanceof RemoteError && /admin token/.test(error.message)) {
        for (const [, e] of live) this.set(e, { error });
        return;
      }
    }
    if (this.stream === controller && !controller.signal.aborted) {
      this.backoff = Math.min(this.backoff * 2, 10_000);
      this.reopenTimer = setTimeout(() => void this.open(), this.backoff);
    }
  }

  private deliver(msg: { id?: string; value?: unknown; error?: { message: string; data?: unknown } }): void {
    if (!msg.id) return; // heartbeat
    const e = this.entries.get(msg.id);
    if (!e) return;
    this.set(e, msg.error ? { error: new RemoteError(msg.error.message, msg.error.data) } : { value: msg.value });
  }

  private set(e: Entry, state: Entry["state"]): void {
    e.state = state;
    for (const l of e.listeners) l();
  }
}
