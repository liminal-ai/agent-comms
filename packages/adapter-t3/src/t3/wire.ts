// The slice of T3's wire contract the adapter uses, vendored so the repo builds
// and runs with no T3 checkout. Taken from T3 v0.0.44 (tag v0.0.44, commit
// 451afcb22d93f06cb24f9bc16703404564952553), packages/contracts/src:
//
//   rpc.ts            WsOrchestrationSubscribeThreadRpc (stream), WsRpcGroup
//   orchestration.ts  ORCHESTRATION_WS_METHODS.subscribeThread, OrchestrationSubscribeThreadInput,
//                     OrchestrationThreadStreamItem, OrchestrationThread (fields below only),
//                     ThreadTurnStartCommand / ClientThreadTurnStartCommand,
//                     ThreadMessageSentPayload, thread.session-set, thread.activity-appended
//   auth.ts           AuthWebSocketTicketResult
//   environmentHttp.ts  POST /api/orchestration/dispatch, GET /api/orchestration/threads/:id,
//                       POST /api/auth/websocket-ticket
//
// Only the fields read here are declared; anything else T3 sends is ignored.
// When T3 is upgraded, re-check these against its contracts.

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const T3_CONTRACT_VERSION = "v0.0.44 (451afcb22d)";

export const SUBSCRIBE_THREAD = "orchestration.subscribeThread";

/**
 * The one RPC the adapter calls over the WebSocket. Success and error are
 * decoded loosely (Schema.Unknown) and narrowed by hand below, so extra or
 * newer fields never break the stream.
 */
export const SubscribeThreadRpc = Rpc.make(SUBSCRIBE_THREAD, {
  payload: Schema.Struct({
    threadId: Schema.String,
    afterSequence: Schema.optionalKey(Schema.Number),
    /** Ask for a `synchronized` item once the snapshot or catch-up replay has been sent. */
    requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Unknown,
  error: Schema.Unknown,
  stream: true,
});

export const AdapterRpcs = RpcGroup.make(SubscribeThreadRpc);

export interface WireMessage {
  id: string;
  role: string;
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
}

export interface WireSession {
  status: string;
  activeTurnId: string | null;
  lastError: string | null;
}

export interface WireThread {
  id: string;
  runtimeMode: string;
  interactionMode: string;
  session: WireSession | null;
  latestTurn: {
    turnId: string;
    state: "running" | "interrupted" | "completed" | "error";
    requestedAt: string;
    completedAt: string | null;
    assistantMessageId: string | null;
  } | null;
  messages: WireMessage[];
  activities: { kind: string; payload: unknown }[];
}

export interface WireEvent {
  sequence: number;
  type: string;
  payload: unknown;
}

export type WireStreamItem =
  | { kind: "synchronized" }
  | { kind: "snapshot"; snapshot: { snapshotSequence: number; thread: WireThread } }
  | { kind: "event"; event: WireEvent };

/** `thread.turn.start` as the client sends it (ClientThreadTurnStartCommand). */
export interface WireTurnStart {
  type: "thread.turn.start";
  commandId: string;
  threadId: string;
  message: { messageId: string; role: "user"; text: string; attachments: [] };
  runtimeMode: string;
  interactionMode: string;
  createdAt: string;
}
