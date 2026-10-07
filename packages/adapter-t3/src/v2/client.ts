// The real V2Client, against T3's orchestration protocol 2 (vendored in wire.ts):
//
//   GET  /api/orchestration/threads/<id>       full thread snapshot (bearer, protocol header)
//   POST /api/auth/websocket-ticket            a ticket for the WebSocket (bearer)
//   WS   /ws?wsTicket=…&orchestrationProtocol=2
//        orchestration.dispatchCommand         message.dispatch (Effect RPC, JSON)
//        orchestration.subscribeThread         the thread's events
//
// Uses this repo's own effect (the same 4.0.0-rc.115 T3 pins); nothing from a T3
// checkout. The bearer is read from a file and never printed; the ticketed URL is
// never logged.

import { readCredential } from "../../../windows-pipe/src/secret.mjs";
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
import { type RunStatus, V2Rejected, type V2Attempt, type V2Client, type V2Event, type V2StreamItem, type V2Thread } from "./model.ts";
import {
  AdapterRpcs,
  DISPATCH_COMMAND,
  PROTOCOL_HEADER,
  PROTOCOL_QUERY_PARAM,
  PROTOCOL_VERSION,
  SUBSCRIBE_THREAD,
  type WireEvent,
  type WireProjection,
  type WireRun,
  type WireStreamItem,
  type WireTurnItem,
} from "./wire.ts";

export interface V2ClientOptions {
  /** e.g. http://127.0.0.1:13976 */
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

const redact = (text: string) => text.replace(/wsTicket=[^&\s"']+/g, "wsTicket=<redacted>");

export function makeT3ClientV2(options: V2ClientOptions): V2Client {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const bearer = () => readCredential(options.authFile).trim();
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
    // Without it T3 answers 426 (orchestration_protocol_incompatible).
    url.searchParams.set(PROTOCOL_QUERY_PARAM, PROTOCOL_VERSION);
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

  const rpc = (s: Session) => s.client as unknown as Record<string, (i: unknown) => unknown>;

  return {
    connected: async () => {
      try {
        await connect();
        return true;
      } catch (error) {
        options.log(`T3 at ${baseUrl}: can't connect (${redact(errorText(error))})`);
        return false;
      }
    },

    getThread: async (threadId) => {
      const response = await fetch(`${baseUrl}/api/orchestration/threads/${encodeURIComponent(threadId)}`, {
        headers: { ...authHeaders(), [PROTOCOL_HEADER]: PROTOCOL_VERSION },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`T3 thread snapshot: HTTP ${response.status}`);
      const body = (await response.json()) as { snapshotSequence: number; projection: WireProjection };
      return slice(threadId, body.projection, body.snapshotSequence);
    },

    dispatch: async (threadId, m) => {
      const s = await connect();
      const command = {
        type: "message.dispatch" as const,
        commandId: m.commandId,
        threadId,
        messageId: m.messageId,
        text: m.text,
        attachments: [] as [],
        createdBy: "user" as const,
        creationSource: "mcp" as const,
        dispatchMode: m.steer ? { type: "steer_active" as const, targetRunId: m.steer } : { type: "start_immediately" as const },
      };
      const exit = await Effect.runPromiseExit(
        (rpc(s)[DISPATCH_COMMAND]!(command) as Effect.Effect<unknown, unknown, never>).pipe(Effect.timeout("30 seconds")),
      );
      if (Exit.isSuccess(exit)) {
        const sequence = (exit.value as { sequence?: unknown } | null)?.sequence;
        return { sequence: typeof sequence === "number" ? sequence : 0 };
      }
      // Every dispatch failure is one error tag on the wire, so only T3's own record of a
      // rejection is certain; anything else (a fresh refusal, a timeout, a dropped socket)
      // may or may not have gone in, and is retried with the same command id.
      const failure = exit.cause.reasons.find((r) => r._tag === "Fail") as { error?: unknown } | undefined;
      const text = redact(errorText(failure?.error ?? exit.cause));
      if (text.includes(`Command ${m.commandId} was previously rejected`)) throw new V2Rejected(text);
      throw new Error(`message.dispatch: ${text}`);
    },

    subscribe: async (threadId, options, onItem) => {
      const s = await connect();
      const input = {
        threadId,
        requestCompletionMarker: true,
        ...(options.afterSequence !== undefined ? { afterSequence: options.afterSequence } : {}),
      };
      const stream = rpc(s)[SUBSCRIBE_THREAD]!(input) as Stream.Stream<unknown, unknown, never>;
      const fiber = Effect.runFork(
        Stream.runForEach(stream, (raw) =>
          Effect.sync(() => {
            const item = toItem(threadId, raw as WireStreamItem);
            if (item) onItem(item);
          }),
        ).pipe(
          Effect.onExit(() => Effect.sync(() => onItem({ kind: "closed" }))),
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

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; detail?: unknown; _tag?: unknown };
    const parts = [e.message, e.detail].filter((p): p is string => typeof p === "string" && p.length > 0);
    if (parts.length) return [...new Set(parts)].join(": ");
    if (typeof e._tag === "string") return e._tag;
  }
  return String(error);
}

export function toItem(threadId: string, item: WireStreamItem): V2StreamItem | undefined {
  if (item.kind === "synchronized") return { kind: "synchronized" };
  if (item.kind === "snapshot" && item.projection) return { kind: "snapshot", thread: slice(threadId, item.projection, item.snapshotSequence) };
  // A newer event type this slice doesn't know is "other": skipped, but the cursor advances.
  if (item.kind === "event" && item.event) return { kind: "event", event: toEvent(item.sequence, item.event) };
  if (item.kind === "unknown-event") return { kind: "event", event: { type: "other", sequence: item.sequence } };
  return undefined;
}

const run = (r: WireRun) => ({ id: r.id, ordinal: r.ordinal, userMessageId: r.userMessageId, status: r.status as RunStatus });
const attempt = (a: { runId: string; reason: string }) => ({ runId: a.runId, reason: a.reason as V2Attempt["reason"] });
const message = (m: { id: string; role: string; runId: string | null }) => ({ id: m.id, role: m.role as "user" | "assistant" | "system", runId: m.runId ?? null });
const answer = (i: WireTurnItem) => ({ runId: i.runId!, messageId: i.messageId!, ordinal: i.ordinal, streaming: i.streaming === true, text: i.text ?? "" });
const error = (i: WireTurnItem) => ({ runId: i.runId!, message: i.failure?.message ?? "the run failed" });

/** Only the fields the adapter reads. User message text never leaves here. */
export function toEvent(sequence: number, event: WireEvent): V2Event {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "run.created":
    case "run.updated":
      return { type: "run", sequence, run: run(payload as unknown as WireRun) };
    case "run-attempt.created":
    case "run-attempt.updated":
      return { type: "attempt", sequence, attempt: attempt(payload as { runId: string; reason: string }) };
    case "message.updated":
      return { type: "message", sequence, message: message(payload as { id: string; role: string; runId: string | null }) };
    case "turn-item.updated": {
      const item = payload as unknown as WireTurnItem;
      if (item.type === "assistant_message" && item.runId) return { type: "answer", sequence, answer: answer(item) };
      if (item.type === "error" && item.runId) return { type: "error", sequence, error: error(item) };
      return { type: "other", sequence };
    }
    default:
      return { type: "other", sequence };
  }
}

/** Keep only what the adapter reads. User message text is dropped here. */
export function slice(threadId: string, p: WireProjection, snapshotSequence: number): V2Thread {
  const items = p.turnItems ?? [];
  return {
    id: threadId,
    snapshotSequence,
    runs: (p.runs ?? []).map(run),
    attempts: (p.attempts ?? []).map(attempt),
    messages: (p.messages ?? []).map(message),
    answers: items.filter((i) => i.type === "assistant_message" && i.runId).map(answer),
    errors: items.filter((i) => i.type === "error" && i.runId).map(error),
  };
}
