// A minimal T3 protocol-2 RPC client for the V2 port's live checks (setup, typing as a
// human, reading projections). Stock T3 on 13976 only. The bearer is read from a file
// and never printed. Run with node (type stripping) from the repo root.

import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export const BASE = "http://127.0.0.1:13976";
const TOKEN_FILE = `${process.env.HOME}/.config/agent-comms/t3-13976.token`;
const loose = { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown };
const METHODS = ["projects.mutate", "orchestration.dispatchCommand", "orchestration.getThreadProjection", "server.getConfig"] as const;
const Group = RpcGroup.make(...METHODS.map((m) => Rpc.make(m, loose)));

export async function connectT3() {
  if (!BASE.includes(":13976")) throw new Error("stock 13976 only");
  const auth = { authorization: `Bearer ${readFileSync(TOKEN_FILE, "utf8").trim()}` };
  const r = await fetch(`${BASE}/api/auth/websocket-ticket`, { method: "POST", headers: auth });
  if (!r.ok) throw new Error(`ticket: HTTP ${r.status}`);
  const url = new URL(`${BASE.replace(/^http/, "ws")}/ws`);
  url.searchParams.set("wsTicket", ((await r.json()) as { ticket: string }).ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  const scope = await Effect.runPromise(Scope.make());
  const protocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) })).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url.toString(), { openTimeout: "15 seconds" }).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
      ),
    ),
  );
  const context = await Effect.runPromise(Layer.build(protocol).pipe(Scope.provide(scope)));
  const client = (await Effect.runPromise(
    RpcClient.make(Group).pipe(Effect.provide(context), Scope.provide(scope)) as unknown as Effect.Effect<unknown, unknown, never>,
  )) as Record<string, (p: unknown) => Effect.Effect<unknown, unknown, never>>;
  return {
    async call<T = unknown>(method: (typeof METHODS)[number], payload: unknown): Promise<T> {
      const exit = await Effect.runPromiseExit(client[method]!(payload));
      if (Exit.isSuccess(exit)) return exit.value as T;
      const fail = exit.cause.reasons.find((x) => x._tag === "Fail") as { error?: { message?: string; detail?: string } } | undefined;
      throw new Error(`${method}: ${fail?.error?.detail ?? fail?.error?.message ?? String(exit.cause)}`);
    },
    async snapshot(threadId: string) {
      const res = await fetch(`${BASE}/api/orchestration/threads/${threadId}`, { headers: { ...auth, "x-t3-orchestration-protocol": "2" } });
      if (!res.ok) throw new Error(`snapshot: HTTP ${res.status}`);
      return (await res.json()) as { snapshotSequence: number; projection: Projection };
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

export interface Projection {
  runs: { id: string; ordinal: number; userMessageId: string; status: string; activeAttemptId: string | null }[];
  attempts: { id: string; runId: string; reason: string; status: string }[];
  messages: { id: string; role: string; runId: string | null; text: string; createdBy?: string; creationSource?: string }[];
  turnItems: { type: string; runId: string | null; ordinal: number; messageId?: string; text?: string; streaming?: boolean; inputIntent?: string; failure?: unknown }[];
}
