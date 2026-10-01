// Test harness: the real Convex functions (convex-test), the real connector
// and loopback socket, and a scripted mod session speaking the protocol.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@agent-comms/comms-cli/client";
import type { Delivery, DeliveryCheck, Op, PollItem, Requests, ResponseBody } from "@agent-comms/protocol";
import { convexTest } from "convex-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { api } from "../../../convex/_generated/api.js";
import schema from "../../../convex/schema";
import type { HarnessAdapter } from "../src/adapter.ts";
import type { ClaudeCodeSessions } from "../src/claude-code.ts";
import { runConnector } from "../src/connector.ts";
import { type ConvexTransport, makeServerApi, type ServerApiShape } from "../src/server-api.ts";

const modules = import.meta.glob("../../../convex/**/*.ts");

export const ADMIN = "test-admin-token";
export const machine = { id: "box", secret: "box-secret-0123456789" };

export type Convex = ReturnType<typeof convexTest>;

/** convex-test behind the transport interface; subscriptions are polled. A `down` switch simulates an outage. */
export function transport(t: Convex): ConvexTransport & { down: boolean } {
  type Call = (ref: unknown, args: unknown) => Promise<unknown>;
  const query = t.query as unknown as Call;
  const mutation = t.mutation as unknown as Call;
  const self = {
    down: false,
    query: (ref: unknown, args: unknown) => (self.down ? Promise.reject(new Error("connection refused")) : query(ref, args)),
    mutation: (ref: unknown, args: unknown) => (self.down ? Promise.reject(new Error("connection refused")) : mutation(ref, args)),
    watch: (ref: unknown, args: unknown, onValue: (v: unknown) => void, onError: (e: Error) => void) => {
      let stopped = false;
      let last = "";
      void (async () => {
        while (!stopped) {
          if (!self.down) {
            try {
              const value = await query(ref, args);
              const key = JSON.stringify(value);
              if (key !== last && !stopped) {
                last = key;
                onValue(value);
              }
            } catch (error) {
              onError(error as Error);
            }
          }
          await sleep(15);
        }
      })();
      return () => {
        stopped = true;
      };
    },
  };
  return self as unknown as ConvexTransport & { down: boolean };
}

export async function world() {
  process.env.COMMS_ADMIN_TOKEN = ADMIN;
  const t = convexTest(schema, modules);
  await t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: machine.id, secret: machine.secret });
  await t.mutation(api.directory.promote, { adminToken: ADMIN, name: "lee", kind: "human" });
  for (const name of ["a", "b"]) {
    await t.mutation(api.directory.promote, {
      adminToken: ADMIN,
      name,
      kind: "agent",
      owner: "lee",
      home: { machine: machine.id, harness: "claude-code", locator: name },
    });
  }
  await t.mutation(api.directory.promote, {
    adminToken: ADMIN,
    name: "tee",
    kind: "agent",
    owner: "lee",
    home: { machine: machine.id, harness: "t3", locator: "thread-1" },
  });
  const tr = transport(t);
  const serverApi = makeServerApi(tr, { machine, callTimeout: "2 seconds" });
  const dir = await mkdtemp(join(tmpdir(), "connector-test-"));
  const socket = join(dir, "agent-comms", "connector.sock");
  return { t, tr, api: serverApi, socket, dir };
}

export interface Running {
  stop(): Promise<void>;
  logs: string[];
  sessions?: ClaudeCodeSessions;
}

export async function startConnector(api: ServerApiShape, socket: string, leaseMs = 1_500, adapters: HarnessAdapter[] = []): Promise<Running> {
  const scope = await Effect.runPromise(Scope.make());
  const logs: string[] = [];
  const { sessions } = await Effect.runPromise(
    Scope.provide(scope)(
      runConnector({ machine: machine.id, socketPath: socket, api, leaseMs, pollWaitMs: 2_000, tickMs: 50, adapters, log: (l) => logs.push(l) }),
    ),
  );
  return { stop: () => Effect.runPromise(Scope.close(scope, Exit.void)), logs, sessions };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, f: () => Promise<T | undefined | null | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await f();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A scripted mod: registers, polls, and reports, like packages/claude-code-mod will. */
export class Mod {
  readonly socket: string;
  readonly participant: string;
  readonly sessionId: string;
  constructor(socket: string, participant: string, sessionId = `s-${participant}`) {
    this.socket = socket;
    this.participant = participant;
    this.sessionId = sessionId;
  }
  async op<K extends Op>(op: K, body: Omit<Requests[K], "sessionId">): Promise<ResponseBody<K>> {
    return call(this.socket, op, { sessionId: this.sessionId, ...body } as Requests[K]);
  }
  async ok<K extends Op>(op: K, body: Omit<Requests[K], "sessionId">) {
    const r = await this.op(op, body);
    if (!r.ok) throw new Error(`${op}: ${r.error.code}: ${r.error.message}`);
    return r;
  }
  register() {
    return this.ok("register", { participant: this.participant, harness: "claude-code", cwd: "/work", status: "idle" } as never);
  }
  async poll(waitMs = 300): Promise<PollItem[]> {
    return (await this.ok("poll", { waitMs } as never)).items;
  }
  async nextDelivery(timeoutMs = 10_000): Promise<Delivery> {
    return until("a delivery", async () => {
      const items = await this.poll();
      const d = items.find((i) => i.type === "deliver");
      if (items.some((i) => i.type === "check")) throw new Error(`unexpected check: ${JSON.stringify(items)}`);
      return d?.type === "deliver" ? d.delivery : undefined;
    }, timeoutMs);
  }
  async nextCheck(timeoutMs = 10_000): Promise<DeliveryCheck> {
    return until("a check", async () => {
      const items = await this.poll();
      if (items.some((i) => i.type === "deliver")) throw new Error(`unexpected delivery: ${JSON.stringify(items)}`);
      const c = items.find((i) => i.type === "check");
      return c?.type === "check" ? c.check : undefined;
    }, timeoutMs);
  }
}
