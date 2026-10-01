// The real T3Client, against T3 v0.0.44's wire contract (vendored in wire.ts):
//
//   GET  /api/orchestration/threads/<id>[?turnLimit=N]   thread snapshot (bearer)
//   POST /api/orchestration/dispatch                      thread.turn.start (bearer)
//   POST /api/auth/websocket-ticket                       a ticket for the WebSocket (bearer)
//   WS   /ws?wsTicket=…  orchestration.subscribeThread    the thread's events (Effect RPC, JSON)
//
// Uses this repo's own effect (the same 4.0.0-rc.115 T3 pins); nothing from a
// T3 checkout. The bearer is read from a file and never printed.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { T3Rejected, type T3Client, type T3Event, type T3StreamItem, type T3Thread } from "../model.ts";
import { AdapterRpcs, SUBSCRIBE_THREAD, type WireEvent, type WireStreamItem, type WireThread, type WireTurnStart } from "./wire.ts";

export interface T3ClientOptions {
  /** e.g. http://127.0.0.1:3780 */
  baseUrl: string;
  /** File holding the bearer (mode 0600). */
  authFile: string;
  log: (line: string) => void;
}

type AdapterClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof AdapterRpcs>>;

interface Session {
  client: AdapterClient;
  scope: Scope.Closeable;
  disconnected: boolean;
}

export function makeT3Client(options: T3ClientOptions): T3Client {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const bearer = () => readFileSync(options.authFile, "utf8").trim();
  const authHeaders = () => ({ authorization: `Bearer ${bearer()}` });
  let session: Session | null = null;
  let connecting: Promise<Session> | null = null;

  const socketUrl = async (): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`T3 websocket ticket: HTTP ${response.status}`);
    const { ticket } = (await response.json()) as { ticket: string };
    const url = new URL(`${baseUrl.replace(/^http/, "ws")}/ws`);
    url.searchParams.set("wsTicket", ticket);
    return url.toString();
  };

  const connect = async (): Promise<Session> => {
    if (session && !session.disconnected) return session;
    connecting ??= (async () => {
      try {
        const url = await socketUrl();
        const scope = await Effect.runPromise(Scope.make());
        const created: Session = { client: undefined as never, scope, disconnected: false };
        const hooks = RpcClient.ConnectionHooks.of({
          onConnect: Effect.void,
          onDisconnect: Effect.sync(() => {
            created.disconnected = true;
          }),
        });
        const protocol = Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Socket.layerWebSocket(url, { openTimeout: "15 seconds" }).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
              RpcSerialization.layerJson,
              Layer.succeed(RpcClient.ConnectionHooks, hooks),
            ),
          ),
        );
        // Build the socket into the session's scope: Effect.provide(layer) would close it when make() returns.
        const context = await Effect.runPromise(Layer.build(protocol).pipe(Scope.provide(scope)));
        created.client = await Effect.runPromise(
          RpcClient.make(AdapterRpcs).pipe(Effect.provide(context), Scope.provide(scope)) as unknown as Effect.Effect<AdapterClient, unknown, never>,
        );
        session = created;
        return created;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  return {
    connected: async () => {
      try {
        await connect();
        return true;
      } catch (error) {
        // Never log the ticketed WebSocket URL (3.6).
        const message = (error instanceof Error ? error.message : String(error)).replace(/wsTicket=[^&\s"']+/g, "wsTicket=<redacted>");
        options.log(`T3 at ${baseUrl}: can't connect (${message})`);
        return false;
      }
    },

    getThread: async (threadId, turnLimit) => {
      const query = turnLimit ? `?turnLimit=${turnLimit}` : "";
      const response = await fetch(`${baseUrl}/api/orchestration/threads/${encodeURIComponent(threadId)}${query}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`T3 thread snapshot: HTTP ${response.status}`);
      const body = (await response.json()) as { snapshotSequence: number; thread: WireThread };
      return slice(body.thread, body.snapshotSequence);
    },

    startTurn: async (threadId, turn) => {
      const command: WireTurnStart = {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId,
        message: { messageId: turn.messageId, role: "user", text: turn.text, attachments: [] },
        runtimeMode: turn.runtimeMode,
        interactionMode: turn.interactionMode,
        createdAt: new Date().toISOString(),
      };
      // Only an HTTP 4xx is a refusal (the command was rejected and never ran). A 5xx, a dropped
      // connection or a timeout may follow acceptance: thrown as a plain error, never T3Rejected (2.3).
      const response = await fetch(`${baseUrl}/api/orchestration/dispatch`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status >= 400 && response.status < 500) {
        const reason = await response.text().then((t) => t.slice(0, 300), () => "");
        throw new T3Rejected(`thread.turn.start refused: HTTP ${response.status} ${reason}`);
      }
      if (!response.ok) throw new Error(`thread.turn.start: HTTP ${response.status}; it may or may not have been accepted`);
    },

    subscribe: async (threadId, options, onItem) => {
      const s = await connect();
      const input = {
        threadId,
        requestCompletionMarker: true,
        ...(options.afterSequence !== undefined ? { afterSequence: options.afterSequence } : {}),
      };
      const stream = (s.client as unknown as Record<string, (i: unknown) => Stream.Stream<unknown, unknown, never>>)[SUBSCRIBE_THREAD]!(input);
      const fiber = Effect.runFork(
        Stream.runForEach(stream, (raw) =>
          Effect.sync(() => {
            const item = toItem(raw as WireStreamItem);
            if (item) onItem(item);
          }),
        ).pipe(
          Effect.onExit(() => Effect.sync(() => (onItem as (i: unknown) => void)({ kind: "closed" }))),
          Effect.ignore,
        ) as Effect.Effect<void, never, never>,
      );
      return () => void Effect.runFork(Fiber.interrupt(fiber));
    },

    close: async () => {
      const s = session;
      session = null;
      if (s) await Effect.runPromise(Scope.close(s.scope, Exit.void));
    },
  };
}

export function toItem(item: WireStreamItem): T3StreamItem | undefined {
  if (item.kind === "synchronized") return { kind: "synchronized" };
  if (item.kind === "snapshot" && item.snapshot) return { kind: "snapshot", thread: slice(item.snapshot.thread, item.snapshot.snapshotSequence) };
  if (item.kind === "event" && item.event) return { kind: "event", event: toEvent(item.event) };
  return undefined;
}

/** Only the fields the tracker reads; user message text never leaves here. */
export function toEvent(event: WireEvent): T3Event {
  const sequence = event.sequence;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "thread.message-sent":
      return payload.role === "user"
        ? { type: "user-message", sequence, messageId: String(payload.messageId) }
        : { type: "assistant-message", sequence, messageId: String(payload.messageId), turnId: (payload.turnId as string | null) ?? null };
    case "thread.session-set": {
      const session = payload.session as { status: string; activeTurnId: string | null; lastError: string | null };
      return { type: "session", sequence, session: { status: session.status, activeTurnId: session.activeTurnId, lastError: session.lastError } };
    }
    case "thread.activity-appended": {
      const activity = payload.activity as { kind: string; payload?: { requestId?: unknown } };
      if (activity.kind === "provider.turn.start.failed" && typeof activity.payload?.requestId === "string") {
        return { type: "turn-start-failed", sequence, requestId: activity.payload.requestId };
      }
      return { type: "other", sequence };
    }
    default:
      return { type: "other", sequence };
  }
}

/** Keep only what the adapter reads. User message text is dropped here. */
export function slice(thread: WireThread, snapshotSequence: number): T3Thread {
  return {
    id: thread.id,
    snapshotSequence,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    session: thread.session
      ? { status: thread.session.status, activeTurnId: thread.session.activeTurnId, lastError: thread.session.lastError }
      : null,
    latestTurn: thread.latestTurn
      ? {
          turnId: thread.latestTurn.turnId,
          state: thread.latestTurn.state,
          requestedAt: thread.latestTurn.requestedAt,
          completedAt: thread.latestTurn.completedAt,
          assistantMessageId: thread.latestTurn.assistantMessageId,
        }
      : null,
    messages: thread.messages.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      turnId: m.turnId,
      streaming: m.streaming,
      createdAt: m.createdAt,
      ...(m.role === "assistant" ? { text: m.text } : {}),
    })),
    turnStartFailures: thread.activities.flatMap((a) => {
      const requestId = (a.payload as { requestId?: unknown } | null)?.requestId;
      return a.kind === "provider.turn.start.failed" && typeof requestId === "string" ? [requestId] : [];
    }),
  };
}
