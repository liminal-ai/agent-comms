// Self-authored, network-free process fixture. It runs the production direct
// transport, NativeReceives, OaidotClient, and stdio server against a fake API.
// Example: node test/fixtures/stdio-host.ts --delay-ms 1000 --text wake-proof
import { parseArgs } from "node:util";
import { ProtocolFailure, type ServerApiShape, type WorkItem } from "@agent-comms/connector";
import type { Delivery, Requests, Responses } from "@agent-comms/protocol";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { delivery, message } from "../../../protocol/test/fixtures.ts";
import { OaidotClient } from "../../src/client.ts";
import { makeNativeTransport } from "../../src/direct.ts";
import { writeOutput } from "../../src/output.ts";
import { serveStdio } from "../../src/stdio.ts";

const { values } = parseArgs({ options: {
  "delay-ms": { type: "string", default: "0" }, text: { type: "string", default: "Self-authored native courier wake fixture." },
  participant: { type: "string", default: "cedar" }, locator: { type: "string", default: "fixture-parent" },
  once: { type: "boolean", default: false },
} });
const participant = values.participant!;
const locator = values.locator!;
const delayMs = Number(values["delay-ms"]);
if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error("invalid fixture delay");
const recipient = { id: "p_fixture", name: participant, kind: "agent" as const };
let item: Delivery | undefined;
let emit = (_items: WorkItem[]) => {};
let timer: ReturnType<typeof setTimeout> | undefined;
let claim = 0;
let acknowledgedClaim: string | undefined;
const counters = { subscriptions: 0, unsubscribes: 0, receives: 0, ackCalls: 0, acknowledgements: 0, replyCalls: 0, replies: 0, sends: 0, heartbeats: 0, presence: 0 };
const snapshot = (): WorkItem[] => !item || ["delivered", "replied"].includes(item.status.state) ? [] : [{
  id: item.id, recipient: participant, harness: "oaidot", locator,
  state: item.status.state, collect: true, claim: item.status.claim, createdAt: item.message.createdAt,
}];
const publish = () => emit(snapshot());
const refuse = (text: string) => Effect.fail(new ProtocolFailure({ code: "conflict", message: text }));
const sentByKey = new Map<string, { request: string; result: Responses["send"] }>();
const replyByKey = new Map<string, { request: string; result: Responses["reply"] }>();

// The extra fixture counters on list are for this test entry only. No such
// diagnostics or event-generation hook exists in the production stdio API.
const api = {
  work: Stream.callback<WorkItem[]>((queue) => Effect.acquireRelease(
    Effect.sync(() => {
      counters.subscriptions++;
      emit = (items) => { Queue.offerUnsafe(queue, items); };
      publish();
      if (delayMs > 0) timer = setTimeout(() => {
        item = delivery({ recipient, message: message({ seq: 3, text: values.text!, recipients: [recipient] }), status: { state: "pending", at: Date.now() } });
        publish();
      }, delayMs);
    }),
    () => Effect.sync(() => { counters.unsubscribes++; clearTimeout(timer); emit = () => {}; }),
  )),
  homed: Effect.succeed({ participants: [{ participant: recipient, home: { machine: "fixture", harness: "oaidot" as const, locator }, state: "active" as const }] }),
  heartbeat: Effect.sync(() => { counters.heartbeats++; }),
  presence: () => Effect.sync(() => { counters.presence++; }),
  receive: (request: Requests["receive"]) => Effect.suspend(() => {
    counters.receives++;
    if (request.as !== participant || request.locator !== locator) return refuse("wrong native binding");
    if (request.includeDelivered) return Effect.succeed({ deliveries: item?.status.state === "delivered" ? [structuredClone(item)] : [], hasMore: false });
    if (!item || item.status.state === "replied" || item.status.state === "delivered"
      || item.status.claim && item.status.claim.leaseExpiresAt > Date.now()) return Effect.succeed({ deliveries: [], hasMore: false });
    item.status = { state: "claimed", at: Date.now(), claim: { machine: "fixture", claimId: `fixture_claim_${++claim}`, leaseExpiresAt: Date.now() + (request.leaseMs ?? 120_000) } };
    publish();
    return Effect.succeed({ deliveries: [structuredClone(item)], hasMore: false });
  }),
  receiveAck: (request: Requests["receive-ack"]) => Effect.suspend(() => {
    counters.ackCalls++;
    if (!item || request.deliveryId !== item.id || request.as !== participant || request.locator !== locator) return refuse("wrong delivery binding");
    if (acknowledgedClaim === request.claimId) return Effect.succeed({ delivery: { id: item.id, recipient: participant, state: item.status.state } });
    if (item.status.state !== "claimed" || request.claimId !== item.status.claim?.claimId || item.status.claim.leaseExpiresAt <= Date.now()) return refuse("stale claim");
    acknowledgedClaim = request.claimId;
    counters.acknowledgements++;
    item.status = { state: "delivered", at: Date.now() };
    publish();
    return Effect.succeed({ delivery: { id: item.id, recipient: participant, state: item.status.state } });
  }),
  reply: (request: Requests["reply"]) => Effect.suspend(() => {
    counters.replyCalls++;
    const previous = replyByKey.get(request.key!);
    const encoded = JSON.stringify(request);
    if (previous) return previous.request === encoded ? Effect.succeed(previous.result) : refuse("idempotency key reused with different input");
    if (!item || request.messageId !== item.message.id || item.status.state !== "delivered") return refuse("explicit receipt required by fixture");
    counters.replies++;
    const result: Responses["reply"] = {
      message: message({ seq: 4, text: request.text, sender: recipient, kind: "answer" }),
      deliveries: [], skipped: [], completed: item.id,
    };
    replyByKey.set(request.key!, { request: encoded, result });
    item.status = { state: "replied", at: Date.now() };
    publish();
    return Effect.succeed(result);
  }),
  send: (request: Requests["send"]) => Effect.suspend(() => {
    const encoded = JSON.stringify(request);
    const previous = sentByKey.get(request.key!);
    if (previous) return previous.request === encoded ? Effect.succeed(previous.result) : refuse("idempotency key reused with different input");
    counters.sends++;
    const result: Responses["send"] = { message: message({ seq: 10 + counters.sends, sender: recipient, text: request.text }), deliveries: [], skipped: [] };
    sentByKey.set(request.key!, { request: encoded, result });
    return Effect.succeed(result);
  }),
  list: () => Effect.sync(() => ({ conversations: [], fixture: { ...counters, state: item?.status.state ?? "empty" } })),
  agents: () => Effect.succeed({ agents: [] }),
  read: (request: Requests["read"]) => request.conversationId === "explode"
    ? Effect.die(new Error("secret=fixture-do-not-leak"))
    : Effect.succeed({ conversation: { id: "c_1", kind: "dm" }, messages: item ? [item.message] : [], hasMore: false }),
  messageStatus: () => Effect.succeed({ message: message({ seq: 3 }), conversation: { id: "c_1", kind: "dm" }, recipients: [] }),
} as unknown as ServerApiShape;

const native = await makeNativeTransport(api);
const client = new OaidotClient({ participant, locator, socketPath: "/unused-no-socket", transport: native.transport });
const signal = new AbortController();
for (const name of ["SIGINT", "SIGTERM"] as const) process.once(name, () => signal.abort());
if (values.once) {
  // The same one-shot call used by the production `listen` command, with no
  // stdin/log polling: its process completes when the subscribed offer arrives.
  try {
    await writeOutput(process.stdout, JSON.stringify(await client.listen({ signal: signal.signal })) + "\n");
  } finally { await native.close(); }
} else {
  await serveStdio(client, {
    input: process.stdin, signal: signal.signal, close: native.close,
    write: (line) => writeOutput(process.stdout, line),
  });
}
process.stderr.write(JSON.stringify({ fixtureClosed: true, ...counters }) + "\n");
