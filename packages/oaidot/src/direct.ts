// A socket-free native host. The same connector receipt machine consumes the
// same server work subscription; this file does not own another delivery queue.
import {
  loadConfig, LoopbackError, makeServerApi, NativeReceives,
  type ApiError, type ConvexTransport, type ServerApiShape,
} from "@agent-comms/connector";
import { errorBody, type Op, type Requests, type ResponseBody } from "@agent-comms/protocol";
import { ConvexClient } from "convex/browser";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { OaidotClient, type Transport } from "./client.ts";

export interface NativeTransport {
  transport: Transport;
  close: () => Promise<void>;
}

/** Starts exactly one scoped work subscription, and no dispatcher or socket. */
export async function makeNativeTransport(
  api: ServerApiShape,
  options: { heartbeatMs?: number; log?: (line: string) => void } = {},
): Promise<NativeTransport> {
  const scope = Effect.runSync(Scope.make());
  const closed = new AbortController();
  const log = options.log ?? (() => {});
  let closing: Promise<void> | undefined;
  const run = <A>(effect: Effect.Effect<A, ApiError>, signal = closed.signal): Promise<A> => Effect.runPromise(
    effect.pipe(Effect.mapError((error) => error._tag === "ProtocolFailure"
      ? new LoopbackError(error.code, error.message)
      : new LoopbackError("unavailable", "server unavailable; outcome may be unknown"))),
    { signal },
  );
  const receives = new NativeReceives(api, run);
  const close = () => closing ??= (async () => {
    closed.abort();
    receives.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  })();
  try {
    await Effect.runPromise(Scope.provide(scope)(Effect.gen(function* () {
      yield* api.work.pipe(
        Stream.runForEach((items) => Effect.sync(() => receives.update(items))),
        Effect.catch(() => Effect.sync(() => {
          log("work subscription stopped; native transport is closing");
          closed.abort();
          receives.close();
        })),
        Effect.forkScoped({ startImmediately: true }),
      );
      if (options.heartbeatMs !== undefined) {
        if (!Number.isFinite(options.heartbeatMs) || options.heartbeatMs < 1_000) {
          throw new Error("heartbeatMs must be at least 1000");
        }
        // This asserts only that the machine transport is alive. A native host
        // must never advertise the actual parent's presence on its behalf.
        yield* api.heartbeat.pipe(
          Effect.catch(() => Effect.sync(() => log("machine heartbeat unavailable"))),
          Effect.repeat(Schedule.spaced(options.heartbeatMs)),
          Effect.forkScoped,
        );
      }
    })));
  } catch (error) {
    await close();
    throw error;
  }

  const transport: Transport = async <K extends Op>(op: K, body: Requests[K], signal?: AbortSignal): Promise<ResponseBody<K>> => {
    const aborted = signal ? AbortSignal.any([closed.signal, signal]) : closed.signal;
    if (aborted.aborted) return errorBody("unavailable", "native transport is closed or request was cancelled");
    try {
      let value: unknown;
      // Casts only narrow the discriminated operation's already-decoded body.
      switch (op) {
        case "receive": value = await receives.receive(body as Requests["receive"], aborted); break;
        case "receive-ack": value = await run(api.receiveAck(body as Requests["receive-ack"]), aborted); break;
        case "send": value = await run(api.send(body as Requests["send"]), aborted); break;
        case "reply": value = await run(api.reply(body as Requests["reply"]), aborted); break;
        case "read": value = await run(api.read(body as Requests["read"]), aborted); break;
        case "list": value = await run(api.list(body as Requests["list"]), aborted); break;
        case "agents": value = await run(api.agents(body as Requests["agents"]), aborted); break;
        case "message-status": value = await run(api.messageStatus(body as Requests["message-status"]), aborted); break;
        default: return errorBody("unsupported", "operation is not exposed by the native transport");
      }
      return { ok: true, ...value as object } as ResponseBody<K>;
    } catch (error) {
      return error instanceof LoopbackError ? errorBody(error.code, error.message)
        : errorBody("unavailable", "native transport call failed; outcome may be unknown. Retry send/reply with the same key.");
    }
  };
  return { transport, close };
}

/** Uses the connector's existing machine config and Convex client/API contract. */
export async function createDirectClient(options: {
  participant: string;
  locator: string;
  configPath: string;
  log?: (line: string) => void;
}): Promise<{ client: OaidotClient; close: () => Promise<void> }> {
  const config = loadConfig(options.configPath);
  const log = options.log ?? (() => {});
  // Neither Convex's argument-bearing diagnostics nor config/secret paths go
  // to stdout or stderr. Report only static, safe context.
  if (config.warnings.length) log("machine secret file permissions should be restricted to its owner");
  const client = new ConvexClient(config.convexUrl, {
    unsavedChangesWarning: false,
    logger: {
      log: () => {}, logVerbose: () => {},
      warn: () => log("Convex warning (details withheld)"),
      error: () => log("Convex connection error (details withheld)"),
    },
  });
  const transport: ConvexTransport = {
    query: (ref, args) => client.query(ref, args),
    mutation: (ref, args) => client.mutation(ref, args),
    watch: (ref, args, onValue, onError) => {
      const unsubscribe = client.onUpdate(ref, args, onValue, onError);
      return () => unsubscribe();
    },
  };
  let native: NativeTransport | undefined;
  try {
    native = await makeNativeTransport(makeServerApi(transport, {
      machine: { id: config.machine, secret: config.secret },
    }), { heartbeatMs: 30_000, log });
    const host = native;
    const oaidot = new OaidotClient({
      participant: options.participant, locator: options.locator,
      socketPath: config.socket, transport: native.transport,
    });
    let closing: Promise<void> | undefined;
    return {
      client: oaidot,
      close: () => closing ??= (async () => {
        try { await host.close(); } finally { await client.close(); }
      })(),
    };
  } catch (error) {
    try { await native?.close(); } finally { await client.close(); }
    throw error;
  }
}
