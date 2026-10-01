// The comms server as the connector sees it: the Convex functions in
// convex/connector.ts, with errors sorted into protocol failures (the server
// said no, with a loopback error code) and unavailability (couldn't ask).

import type {
  Claim,
  Delivery,
  DeliveryState,
  EnteredInput,
  ErrorCode,
  Harness,
  Requests,
  Responses,
} from "@agent-comms/protocol";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api.js";

export class ProtocolFailure extends Data.TaggedError("ProtocolFailure")<{ code: ErrorCode; message: string }> {}
export class Unavailable extends Data.TaggedError("Unavailable")<{ message: string }> {}
export type ApiError = ProtocolFailure | Unavailable;

export interface WorkItem {
  id: string;
  recipient: string;
  harness: Harness;
  locator: string;
  state: DeliveryState;
  collect: boolean;
  claim?: Claim;
  turnId?: string;
  cursor?: string;
  createdAt: number;
}

export interface ClaimResult {
  claim: Claim;
  takeover: boolean;
  delivery: Delivery;
}

type StateResult = { delivery: Responses["delivered"]["delivery"] };

export interface ServerApiShape {
  /** The deliveries on this machine that need action. Emits on every change. */
  readonly work: Stream.Stream<WorkItem[], Unavailable>;
  readonly claim: (deliveryId: string, leaseMs: number) => Effect.Effect<ClaimResult, ApiError>;
  readonly renew: (deliveryId: string, claimId: string, leaseMs: number) => Effect.Effect<{ claim: Claim }, ApiError>;
  readonly prepare: (deliveryId: string, claimId: string, cursor?: string) => Effect.Effect<unknown, ApiError>;
  readonly delivered: (deliveryId: string, claimId: string, turnId: string, cursor?: string) => Effect.Effect<StateResult, ApiError>;
  readonly collect: (deliveryId: string, claimId: string, turnId: string, answer: string) => Effect.Effect<Responses["outcome"], ApiError>;
  readonly ambiguous: (deliveryId: string, claimId: string, turnId: string, entered: EnteredInput[]) => Effect.Effect<StateResult, ApiError>;
  readonly failed: (
    deliveryId: string,
    claimId: string,
    turnId: string | undefined,
    reason: "aborted" | "refusal" | "error" | "rejected",
    detail?: string,
  ) => Effect.Effect<StateResult, ApiError>;
  readonly uncertain: (deliveryId: string, claimId: string, detail: string) => Effect.Effect<StateResult, ApiError>;
  readonly presence: (participant: string, status: "idle" | "busy" | "offline") => Effect.Effect<void, ApiError>;
  readonly heartbeat: Effect.Effect<void, ApiError>;
  readonly homed: Effect.Effect<Pick<Responses["status"], "participants">, ApiError>;
  readonly send: (req: Requests["send"]) => Effect.Effect<Responses["send"], ApiError>;
  readonly reply: (req: Requests["reply"]) => Effect.Effect<Responses["reply"], ApiError>;
  readonly read: (req: Requests["read"]) => Effect.Effect<Responses["read"], ApiError>;
  readonly list: (req: Requests["list"]) => Effect.Effect<Responses["list"], ApiError>;
  readonly agents: (req: Requests["agents"]) => Effect.Effect<Responses["agents"], ApiError>;
  /** `await`'s write: records that the CLI is still waiting, expires the wait if due, returns it. */
  readonly awaitWait: (req: Pick<Requests["await"], "as" | "messageId">) => Effect.Effect<Responses["await"], ApiError>;
  /** Watches a wait; returns a function that stops watching. */
  readonly watchWait: (req: Pick<Requests["await"], "as" | "messageId">, onValue: (value: Responses["await"]) => void) => () => void;
  readonly ack: (req: Requests["ack"]) => Effect.Effect<Responses["ack"], ApiError>;
  readonly messageStatus: (req: Requests["message-status"]) => Effect.Effect<Responses["message-status"], ApiError>;
  readonly agentsSet: (req: Requests["agents-set"]) => Effect.Effect<Responses["agents-set"], ApiError>;
}

export class ServerApi extends Context.Service<ServerApi, ServerApiShape>()("agent-comms/ServerApi") {}

/** What the API needs from a Convex client. ConvexClient fits; tests wrap convex-test. */
export interface ConvexTransport {
  query<Q extends FunctionReference<"query">>(ref: Q, args: FunctionArgs<Q>): Promise<FunctionReturnType<Q>>;
  mutation<M extends FunctionReference<"mutation">>(ref: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>>;
  /** Calls `onValue` with every new result; returns an unsubscribe function. */
  watch<Q extends FunctionReference<"query">>(
    ref: Q,
    args: FunctionArgs<Q>,
    onValue: (value: FunctionReturnType<Q>) => void,
    onError: (error: Error) => void,
  ): () => void;
}

export interface ServerApiOptions {
  machine: { id: string; secret: string };
  /** A call that takes longer than this counts as unavailable (the client may still be reconnecting). */
  callTimeout?: Duration.Input;
}

export function makeServerApi(transport: ConvexTransport, options: ServerApiOptions): ServerApiShape {
  const machine = options.machine;
  const callTimeout = options.callTimeout ?? Duration.seconds(10);

  const call = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, ApiError> =>
    Effect.tryPromise({ try: run, catch: (error) => classify(what, error) }).pipe(
      Effect.timeout(callTimeout),
      Effect.catchTag("TimeoutError", () => Effect.fail(new Unavailable({ message: `${what}: no answer from the server` }))),
    );

  return {
    work: Stream.callback<WorkItem[], Unavailable>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          transport.watch(
            api.connector.work,
            { machine },
            (value) => void Queue.offerUnsafe(queue, value.deliveries as WorkItem[]),
            // A subscription error is reported, not fatal: the client keeps retrying underneath.
            (error) => console.error(`agent-comms connector: work subscription error: ${describeFailure(error)}`),
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
      // Only the latest list matters.
      { bufferSize: 1, strategy: "sliding" },
    ),
    claim: (deliveryId, leaseMs) =>
      call("claim", () => transport.mutation(api.connector.claim, { machine, deliveryId, leaseMs })) as Effect.Effect<ClaimResult, ApiError>,
    renew: (deliveryId, claimId, leaseMs) =>
      call("renew", () => transport.mutation(api.connector.renew, { machine, deliveryId, claimId, leaseMs })),
    prepare: (deliveryId, claimId, cursor) =>
      call("prepare", () =>
        transport.mutation(api.connector.prepare, { machine, deliveryId, claimId, ...(cursor !== undefined ? { cursor } : {}) }),
      ),
    delivered: (deliveryId, claimId, turnId, cursor) =>
      call("delivered", () =>
        transport.mutation(api.connector.delivered, { machine, deliveryId, claimId, turnId, ...(cursor !== undefined ? { cursor } : {}) }),
      ),
    collect: (deliveryId, claimId, turnId, answer) =>
      call("collect", () => transport.mutation(api.connector.collect, { machine, deliveryId, claimId, turnId, answer })),
    ambiguous: (deliveryId, claimId, turnId, entered) =>
      call("ambiguous", () =>
        transport.mutation(api.connector.ambiguous, {
          machine,
          deliveryId,
          claimId,
          turnId,
          entered: entered.map((e) => ({ origin: e.origin, ...(e.at !== undefined ? { at: e.at } : {}) })),
        }),
      ),
    failed: (deliveryId, claimId, turnId, reason, detail) =>
      call("failed", () =>
        transport.mutation(api.connector.failed, {
          machine,
          deliveryId,
          claimId,
          reason,
          ...(turnId !== undefined ? { turnId } : {}),
          ...(detail !== undefined ? { detail } : {}),
        }),
      ),
    uncertain: (deliveryId, claimId, detail) =>
      call("uncertain", () => transport.mutation(api.connector.uncertain, { machine, deliveryId, claimId, detail })),
    presence: (participant, status) =>
      call("presence", () => transport.mutation(api.connector.presence, { machine, participant, status })).pipe(Effect.asVoid),
    heartbeat: call("heartbeat", () => transport.mutation(api.connector.heartbeat, { machine })).pipe(Effect.asVoid),
    homed: call("homed", () => transport.query(api.connector.homed, { machine })),
    send: (req) =>
      call("send", () =>
        transport.mutation(api.connector.send, {
          machine,
          as: req.as,
          to: req.to,
          text: req.text,
          via: "cli",
          ...(req.conversationId !== undefined ? { conversationId: req.conversationId } : {}),
          ...(req.attachments ? { attachments: req.attachments } : {}),
          ...(req.key !== undefined ? { key: req.key } : {}),
          ...(req.wait ? { wait: true } : {}),
          ...(req.waitMs !== undefined ? { waitMs: req.waitMs } : {}),
        }),
      ),
    reply: (req) =>
      call("reply", () =>
        transport.mutation(api.connector.reply, {
          machine,
          as: req.as,
          messageId: req.messageId,
          text: req.text,
          via: "cli",
          ...(req.attachments ? { attachments: req.attachments } : {}),
          ...(req.key !== undefined ? { key: req.key } : {}),
        }),
      ),
    read: (req) =>
      call("read", () =>
        transport.mutation(api.connector.read, {
          machine,
          as: req.as,
          conversationId: req.conversationId,
          ...(req.before !== undefined ? { before: req.before } : {}),
          ...(req.limit !== undefined ? { limit: req.limit } : {}),
        }),
      ),
    list: (req) => call("list", () => transport.query(api.connector.list, { machine, as: req.as })),
    agents: (req) =>
      call("agents", () =>
        transport.query(api.connector.agents, {
          machine,
          as: req.as,
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.long !== undefined ? { long: req.long } : {}),
        }),
      ),
    awaitWait: (req) => call("await", () => transport.mutation(api.connector.awaitWait, { machine, as: req.as, messageId: req.messageId })),
    watchWait: (req, onValue) =>
      transport.watch(
        api.connector.waitView,
        { machine, as: req.as, messageId: req.messageId },
        onValue,
        // The held `await` ends at its bound and reads the wait again; a watch error just stops early news.
        () => {},
      ),
    ack: (req) =>
      call("ack", () =>
        transport.mutation(api.connector.ack, {
          machine,
          as: req.as,
          messageId: req.messageId,
          ...(req.recipients !== undefined ? { recipients: req.recipients } : {}),
        }),
      ),
    messageStatus: (req) => call("message-status", () => transport.query(api.connector.messageStatus, { machine, as: req.as, messageId: req.messageId })),
    agentsSet: (req) =>
      call("agents-set", () =>
        transport.mutation(api.connector.agentsSet, {
          machine,
          as: req.as,
          name: req.name,
          ...(req.description !== undefined ? { description: req.description } : {}),
          ...(req.duties !== undefined ? { duties: req.duties } : {}),
        }),
      ),
  };
}

/**
 * A ConvexError carrying `{code, message}` is the server refusing with a
 * protocol code. Anything else (network, auth, a bug) means we couldn't get
 * an answer.
 */
export function classify(what: string, error: unknown): ApiError {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
    const { code, message } = data as { code: ErrorCode; message?: string };
    return new ProtocolFailure({ code, message: message ?? code });
  }
  return new Unavailable({ message: `${what}: ${describeFailure(error)}` });
}

/**
 * A safe description of a failure we didn't classify. Convex error text can
 * echo the call's arguments (the machine secret among them), so it's never
 * logged or passed on: only the error's class and a known transport cause (3.6).
 */
export function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const known = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|fetch failed|timed out|WebSocket|connection (?:lost|closed))\b/i.exec(message);
  return known ? `${name} (${known[1]})` : `${name} (details withheld; they may echo arguments)`;
}
