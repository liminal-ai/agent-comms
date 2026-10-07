// The slice of T3's orchestration protocol 2 the V2 adapter uses, vendored so the repo
// builds and runs with no T3 checkout. Taken from T3 v0.0.46-nightly.20261003.2610
// (commit 8ed276c), packages/contracts/src:
//
//   environment.ts      ORCHESTRATION_PROTOCOL_VERSION 2, query param `orchestrationProtocol`,
//                       header `x-t3-orchestration-protocol`
//   orchestrationV2.ts  ORCHESTRATION_V2_WS_METHODS.dispatchCommand / subscribeThread,
//                       OrchestrationV2Command (message.dispatch), OrchestrationV2DispatchCommandResult,
//                       OrchestrationV2DispatchCommandError, OrchestrationV2ThreadStreamItem,
//                       OrchestrationV2ThreadProjection (fields below only), OrchestrationV2DomainEvent
//   environmentHttp.ts  GET /api/orchestration/threads/:id, POST /api/auth/websocket-ticket
//
// Only the fields read here are declared; anything else T3 sends is ignored. Success and
// error are decoded loosely (Schema.Unknown) and narrowed by hand, so extra or newer fields
// and event types never break the stream. When T3 is upgraded, re-check these.

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const T3_V2_CONTRACT_VERSION = "v0.0.46-nightly.20261003.2610 (8ed276c)";
export const PROTOCOL_VERSION = "2";
export const PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const PROTOCOL_HEADER = "x-t3-orchestration-protocol";

export const SUBSCRIBE_THREAD = "orchestration.subscribeThread";
export const DISPATCH_COMMAND = "orchestration.dispatchCommand";

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

/** `message.dispatch` as we send it (OrchestrationV2Command). */
export const DispatchCommandRpc = Rpc.make(DISPATCH_COMMAND, {
  payload: Schema.Struct({
    type: Schema.Literal("message.dispatch"),
    commandId: Schema.String,
    threadId: Schema.String,
    messageId: Schema.String,
    text: Schema.String,
    attachments: Schema.Tuple([]),
    createdBy: Schema.Literal("user"),
    creationSource: Schema.Literal("mcp"),
    dispatchMode: Schema.Union([
      Schema.Struct({ type: Schema.Literal("start_immediately") }),
      Schema.Struct({ type: Schema.Literal("steer_active"), targetRunId: Schema.String }),
    ]),
  }),
  success: Schema.Unknown,
  error: Schema.Unknown,
});

export const AdapterRpcs = RpcGroup.make(SubscribeThreadRpc, DispatchCommandRpc);

export interface WireRun {
  id: string;
  ordinal: number;
  userMessageId: string;
  status: string;
}
export interface WireAttempt {
  runId: string;
  reason: string;
}
export interface WireMessage {
  id: string;
  role: string;
  runId: string | null;
}
export interface WireTurnItem {
  type: string;
  runId: string | null;
  ordinal: number;
  /** assistant_message */
  messageId?: string;
  text?: string;
  streaming?: boolean;
  /** error */
  failure?: { message?: string };
}
export interface WireProjection {
  runs: WireRun[];
  attempts: WireAttempt[];
  messages: WireMessage[];
  turnItems: WireTurnItem[];
}
export interface WireEvent {
  type: string;
  payload: unknown;
}

export type WireStreamItem =
  | { kind: "synchronized" }
  | { kind: "snapshot"; snapshotSequence: number; projection: WireProjection }
  | { kind: "event"; sequence: number; event: WireEvent }
  | { kind: "unknown-event"; sequence: number; eventType: string };
