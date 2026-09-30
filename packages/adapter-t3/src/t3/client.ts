// The real T3Client: T3 v0.0.44's own client runtime (linked from a T3
// checkout by ../../link-deps.sh), the same code path its web client uses.
// Auth is a bearer read from a file; this module never prints it.
//
//   GET  /api/orchestration/threads/<id>[?turnLimit=N]   thread snapshot (bearer)
//   WS   orchestration.subscribeThread                    change trigger
//   WS   orchestration.dispatchCommand thread.turn.start  our message

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
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import { makeWsRpcProtocolClient, remoteHttpClientLayer, type WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { ORCHESTRATION_WS_METHODS, type OrchestrationThread } from "@t3tools/contracts";
import { T3Rejected, type T3Client, type T3Thread } from "../model.ts";

export interface T3ClientOptions {
  /** e.g. http://127.0.0.1:3780 */
  baseUrl: string;
  /** File holding the bearer (mode 0600). */
  authFile: string;
  log: (line: string) => void;
}

interface Session {
  client: WsRpcProtocolClient;
  scope: Scope.Closeable;
  disconnected: boolean;
}

export function makeT3Client(options: T3ClientOptions): T3Client {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const bearer = () => readFileSync(options.authFile, "utf8").trim();
  let session: Session | null = null;
  let connecting: Promise<Session> | null = null;

  const connect = async (): Promise<Session> => {
    if (session && !session.disconnected) return session;
    connecting ??= (async () => {
      try {
        const httpLayer = remoteHttpClientLayer(globalThis.fetch.bind(globalThis));
        const socketUrl = await Effect.runPromise(
          resolveRemoteWebSocketConnectionUrl({
            wsBaseUrl: baseUrl.replace(/^http/, "ws"),
            httpBaseUrl: baseUrl,
            bearerToken: bearer(),
            clientMetadata: { surface: "cli", label: "agent-comms", deviceType: "bot", os: process.platform } as never,
          }).pipe(Effect.provide(httpLayer)) as Effect.Effect<string, unknown, never>,
        );
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
              Socket.layerWebSocket(socketUrl, { openTimeout: "15 seconds" }).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
              RpcSerialization.layerJson,
              Layer.succeed(RpcClient.ConnectionHooks, hooks),
            ),
          ),
        );
        const context = await Effect.runPromise(Layer.build(protocol).pipe(Scope.provide(scope)) as Effect.Effect<never, never, never>);
        created.client = (await Effect.runPromise(
          makeWsRpcProtocolClient.pipe(Effect.provide(context), Scope.provide(scope)) as Effect.Effect<WsRpcProtocolClient, never, never>,
        )) as WsRpcProtocolClient;
        session = created;
        return created;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  const rpc = <A>(effect: unknown): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, unknown, never>);

  return {
    connected: async () => {
      try {
        await connect();
        return true;
      } catch (error) {
        options.log(`T3 at ${baseUrl}: can't connect (${error instanceof Error ? error.message : String(error)})`);
        return false;
      }
    },

    getThread: async (threadId, turnLimit) => {
      const query = turnLimit ? `?turnLimit=${turnLimit}` : "";
      const response = await fetch(`${baseUrl}/api/orchestration/threads/${encodeURIComponent(threadId)}${query}`, {
        headers: { authorization: `Bearer ${bearer()}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`T3 thread snapshot: HTTP ${response.status}`);
      return slice(((await response.json()) as { thread: OrchestrationThread }).thread);
    },

    startTurn: async (threadId, turn) => {
      const s = await connect();
      try {
        await rpc(
          (s.client[ORCHESTRATION_WS_METHODS.dispatchCommand] as (c: unknown) => unknown)({
            type: "thread.turn.start",
            commandId: randomUUID(),
            threadId,
            message: { messageId: turn.messageId, role: "user", text: turn.text, attachments: [] },
            runtimeMode: turn.runtimeMode,
            interactionMode: turn.interactionMode,
            createdAt: new Date().toISOString(),
          }),
        );
      } catch (error) {
        throw new T3Rejected(`thread.turn.start refused: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    watch: async (threadId, onChange) => {
      const s = await connect();
      const stream = (s.client[ORCHESTRATION_WS_METHODS.subscribeThread] as (i: unknown) => Stream.Stream<unknown, unknown, never>)({ threadId });
      const fiber = Effect.runFork(
        Stream.runForEach(stream, () => Effect.sync(onChange)).pipe(
          Effect.onExit(() => Effect.sync(onChange)),
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

/** Keep only what the adapter reads. User message text is dropped here. */
function slice(thread: OrchestrationThread): T3Thread {
  return {
    id: thread.id,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    session: thread.session
      ? { status: thread.session.status, activeTurnId: thread.session.activeTurnId, lastError: thread.session.lastError }
      : null,
    latestTurn: thread.latestTurn
      ? { turnId: thread.latestTurn.turnId, state: thread.latestTurn.state, completedAt: thread.latestTurn.completedAt }
      : null,
    messages: thread.messages.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      turnId: m.turnId,
      streaming: m.streaming,
      createdAt: m.createdAt,
      ...(m.role === "assistant" ? { text: m.text } : {}),
    })),
    finishedTurnIds: thread.checkpoints.map((c) => c.turnId),
  };
}
