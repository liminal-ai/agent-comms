// Multiplexed JSONL for a native host. Receipt, acknowledgement, and answering
// remain separate operations chosen by the actual parent.
import { Readable } from "node:stream";
import { OaidotClient, OaidotError, type Operation } from "./client.ts";

export const MAX_STDIO_LINE_BYTES = 256 * 1024;
export const MAX_STDIO_IN_FLIGHT = 32;
export const MAX_STDIO_LISTENERS = 4;

type Id = string | number;
interface Request { id: Id; method: string; input: Record<string, unknown> }
interface Active { controller: AbortController; task: Promise<void>; listener: boolean }

export interface StdioOptions {
  input: AsyncIterable<Uint8Array | string>;
  /** One complete JSON line. Await backpressure here if the output supports it. */
  write: (line: string) => void | Promise<void>;
  /** Close the transport on EOF, cancellation, or an output error. */
  close?: () => Promise<void>;
  signal?: AbortSignal;
  maxLineBytes?: number;
  maxInFlight?: number;
  maxListeners?: number;
}

const validId = (value: unknown): value is Id => typeof value === "string" && value.length > 0 && value.length <= 128
  || typeof value === "number" && Number.isSafeInteger(value);
const idKey = (id: Id) => `${typeof id}:${id}`;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function only(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new OaidotError("bad_request", "unexpected input field");
}

/**
 * Request: {id,method,input?}; response: {id,result} or {id,error:{code,message}}.
 * listen returns one offer, never an ACK. cancel takes {id} of an active request.
 * IDs correlate responses only; send/reply still require stable operation keys.
 */
export async function serveStdio(client: OaidotClient, options: StdioOptions): Promise<void> {
  const maxLine = options.maxLineBytes ?? MAX_STDIO_LINE_BYTES;
  const maxInFlight = options.maxInFlight ?? MAX_STDIO_IN_FLIGHT;
  const maxListeners = options.maxListeners ?? MAX_STDIO_LISTENERS;
  if (![maxLine, maxInFlight, maxListeners].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new OaidotError("bad_request", "stdio limits must be positive integers");
  }
  const active = new Map<string, Active>();
  let listeners = 0;
  let stopped = false;
  let stopRead: () => void = () => {};
  const stopping = new Promise<undefined>((resolve) => { stopRead = () => resolve(undefined); });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const { controller } of active.values()) controller.abort();
    stopRead();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  // There are at most maxInFlight asynchronous response producers. Validation
  // errors are awaited by the input reader, so malformed input cannot build an
  // unbounded write queue while the consumer is slow.
  let writes: Promise<void> = Promise.resolve();
  const write = (value: unknown) => {
    const line = JSON.stringify(value) + "\n";
    const next = writes.then(async () => {
      if (stopped) return;
      // A consumer may stop reading forever. Closing this host must release
      // request promises even when its output callback never settles.
      await Promise.race([Promise.resolve().then(() => options.write(line)), stopping]);
    });
    writes = next.catch(() => { stop(); });
    return next;
  };
  const failure = (id: Id | null, code: string, message: string) => write({ id, error: { code, message } });
  const execute = async (request: Request, signal: AbortSignal): Promise<unknown> => {
    const { method, input } = request;
    if (method === "listen") {
      only(input, ["leaseMs"]);
      return client.listen({ leaseMs: input.leaseMs as number | undefined, signal });
    }
    if (method === "recover") {
      only(input, ["limit", "cursor"]);
      return client.recover(input, signal);
    }
    const op = method === "ack" ? "receive-ack" : method;
    if (!["send", "reply", "read", "list", "agents", "message-status", "receive-ack"].includes(op)
      || method === "receive-ack") throw new OaidotError("unsupported", "unknown stdio method");
    return client.call(op as Operation, input as never, signal);
  };
  const dispatch = async (line: Buffer) => {
    let id: Id | null = null;
    let request: Request;
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      if (record(value) && validId(value.id)) id = value.id;
      if (!record(value) || id === null || typeof value.method !== "string"
        || value.input !== undefined && !record(value.input)) {
        throw new OaidotError("bad_request", "expected {id,method,input?}");
      }
      request = { id, method: value.method, input: value.input as Record<string, unknown> ?? {} };
    } catch {
      await failure(id, "bad_request", "request must be valid bounded JSON with an id, method, and object input");
      return;
    }
    if (active.has(idKey(request.id))) {
      await failure(request.id, "conflict", "request id is already in flight");
      return;
    }
    if (request.method === "cancel") {
      if (!validId(request.input.id) || Object.keys(request.input).some((key) => key !== "id")) {
        await failure(request.id, "bad_request", "cancel requires the id of an active request");
        return;
      }
      const target = active.get(idKey(request.input.id));
      target?.controller.abort();
      await write({ id: request.id, result: { cancelled: !!target } });
      return;
    }
    const listener = request.method === "listen";
    if (active.size >= maxInFlight || listener && listeners >= maxListeners) {
      await failure(request.id, "busy", "too many requests are in flight");
      return;
    }
    const controller = new AbortController();
    if (listener) listeners++;
    // Start in a microtask so cleanup cannot precede its active map entry.
    const task = Promise.resolve().then(async () => {
      try {
        const result = await execute(request, controller.signal);
        if (!stopped) await write({ id: request.id, result });
      } catch (error) {
        if (!stopped) {
          if (controller.signal.aborted) await failure(request.id, "cancelled", "request cancelled; a mutation may already have completed");
          else if (error instanceof OaidotError) await failure(request.id, error.code, error.message);
          else await failure(request.id, "unavailable", "request failed; outcome may be unknown. Retry send/reply with the same key.");
        }
      } finally {
        active.delete(idKey(request.id));
        if (listener) listeners--;
      }
    }).catch(() => { stop(); });
    active.set(idKey(request.id), { controller, task, listener });
  };

  let pending = Buffer.alloc(0);
  let oversized = false;
  const iterator = options.input[Symbol.asyncIterator]();
  try {
    while (!stopped) {
      const next = await Promise.race([iterator.next(), stopping]);
      if (!next || next.done) break;
      const chunk = typeof next.value === "string" ? Buffer.from(next.value) : Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      let start = 0;
      while (start < chunk.length && !stopped) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        if (!oversized && pending.length + part.length > maxLine) { oversized = true; pending = Buffer.alloc(0); }
        if (!oversized) pending = pending.length ? Buffer.concat([pending, part]) : Buffer.from(part);
        if (newline === -1) break;
        if (oversized) await failure(null, "bad_request", "request line exceeds the byte limit");
        else if (pending.length) await dispatch(pending);
        pending = Buffer.alloc(0);
        oversized = false;
        start = newline + 1;
      }
    }
    // JSONL requires its newline terminator. Do not run a partial mutation on
    // EOF, and do not hold the process open waiting for a blocked listener.
    if (!stopped && (pending.length || oversized)) await failure(null, "bad_request", "unterminated or oversized request line");
  } finally {
    stop();
    options.signal?.removeEventListener("abort", stop);
    // An outstanding next() on a Node pipe otherwise keeps stdin open even
    // after cancellation; return() alone can queue behind that blocked read.
    if (options.input instanceof Readable) options.input.destroy();
    // Node Readable's return() tears down its input. Do not await a generic
    // iterator's return while it may itself be waiting on an external producer.
    void iterator.return?.().catch(() => {});
    try { await options.close?.(); } finally {
      await Promise.allSettled([...active.values()].map(({ task }) => task));
      await writes;
    }
  }
}
