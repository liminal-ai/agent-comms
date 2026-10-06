import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Op, Requests } from "@agent-comms/protocol";
import { delivery, message } from "../../protocol/test/fixtures.ts";
import { courierOffer, OaidotClient, MAX_COURIER_TEXT_CHARS, type Transport } from "../src/client.ts";
import { run } from "../src/cli.ts";

const offer = () => delivery({ status: { state: "claimed", at: 1, claim: { machine: "box", claimId: "claim_1", leaseExpiresAt: Date.now() + 120_000 } } });
function fake(fn: (op: Op, body: Requests[Op]) => unknown | Promise<unknown>): Transport {
  return (async (op: Op, body: Requests[Op]) => fn(op, body)) as Transport;
}
const client = (transport: Transport) => new OaidotClient({ participant: "cedar", locator: "parent-cedar", socketPath: "/unused", transport });

describe("oaidot native courier", () => {
  it("waits through empty held responses, emits one offer and never acknowledges", async () => {
    const calls: Op[] = [];
    const c = client(fake((op, body) => {
      calls.push(op);
      assert.equal((body as Requests["receive"]).as, "cedar");
      assert.equal((body as Requests["receive"]).limit, 1);
      assert.equal((body as Requests["receive"]).waitMs, 25_000);
      return { ok: true, deliveries: calls.length === 1 ? [] : [offer()], hasMore: false };
    }));
    const event = await c.listen();
    assert.deepEqual(calls, ["receive", "receive"]);
    assert.equal(event.type, "delivery-offer");
    assert.equal(event.deliveryId, "d_1");
    assert.equal(event.claimId, "claim_1");
    assert.equal(event.locator, "parent-cedar");
    assert.equal(event.requiresAcknowledgement, true);
    assert.match(event.text, /An explicit answer is expected/);
    assert.doesNotMatch(event.text, /your final message in this turn is sent back/);
  });

  it("a lost wake can be offered again with the same delivery ID and a new fenced claim", () => {
    const first = courierOffer("cedar", "parent-cedar", offer());
    const secondDelivery = offer();
    secondDelivery.status.claim!.claimId = "claim_2";
    const second = courierOffer("cedar", "parent-cedar", secondDelivery);
    assert.equal(second.deliveryId, first.deliveryId);
    assert.notEqual(second.claimId, first.claimId);
  });

  it("bounds render text, preserves external-content warning and advertises explicit reply", () => {
    const d = offer();
    d.message = message({ seq: 3, text: "🦕".repeat(30_000) });
    d.history = { messages: [message({ seq: 2, text: "history ".repeat(3000) })], omitted: 2 };
    const event = courierOffer("cedar", "parent-cedar", d);
    assert.ok(event.text.length <= MAX_COURIER_TEXT_CHARS);
    assert.match(event.text, /more characters not shown/);
    assert.match(event.text, /normal permission rules apply/);
    assert.match(event.text, /Nothing you write in your own conversation is sent or collected automatically/);
  });

  it("rejects another participant and an already acknowledged item as a new offer", () => {
    assert.throws(() => courierOffer("someone-else", "other-parent", offer()), /another participant/);
    assert.throws(() => courierOffer("cedar", "parent-cedar", delivery({ status: { state: "delivered", at: 1 } })), /not a claimed offer/);
  });

  it("binds every call to configured identity and refuses identity overrides", async () => {
    let count = 0;
    const c = client(fake((_op, body) => { count++; assert.equal((body as Requests["list"]).as, "cedar"); return { ok: true, conversations: [] }; }));
    await c.call("list", {});
    await assert.rejects(c.call("list", { as: "hazel" } as {}), /without as/);
    await assert.rejects(c.call("receive", { locator: "other-parent" } as {}), /without as/);
    await assert.rejects(c.call("collect" as "list", {}), /not exposed/);
    assert.equal(count, 1);
  });

  it("requires stable keys and forwards retries unchanged without retrying itself", async () => {
    const calls: unknown[] = [];
    const c = client(fake((op, body) => {
      calls.push({ op, body });
      return { ok: false, error: { code: "unavailable", message: "connection lost" } };
    }));
    await assert.rejects(c.call("reply", { messageId: "m_3", text: "answer" }), /stable idempotency key/);
    const reply = { messageId: "m_3", text: "answer", key: "oaidot_reply_1" };
    await assert.rejects(c.call("reply", reply), /connection lost/);
    assert.equal(calls.length, 1);
    await assert.rejects(c.call("reply", reply), /connection lost/);
    assert.deepEqual(calls[0], calls[1]);
  });

  it("validates ack fields before transport and only explicitly acknowledges", async () => {
    const calls: unknown[] = [];
    const c = client(fake((op, body) => { calls.push({ op, body }); return { ok: true, delivery: { id: "d_1", recipient: "cedar", state: "delivered" } }; }));
    await assert.rejects(c.call("receive-ack", { deliveryId: "d_1", claimId: "!bad" }), /expected/);
    await c.call("receive-ack", { deliveryId: "d_1", claimId: "claim_1" });
    assert.deepEqual(calls, [{ op: "receive-ack", body: { as: "cedar", locator: "parent-cedar", deliveryId: "d_1", claimId: "claim_1" } }]);
  });

  it("CLI listen writes exactly one JSON line and does not read stdin", async () => {
    let stdout = "";
    let stderr = "";
    const result = await run(["listen", "--participant", "cedar", "--locator", "parent-cedar", "--socket", "/unused"], {
      stdout: t => { stdout += t; }, stderr: t => { stderr += t; },
      readStdin: async () => { throw new Error("must not read stdin"); },
      transport: fake(() => ({ ok: true, deliveries: [offer()], hasMore: false })),
    });
    assert.equal(result, 0, stderr);
    assert.equal(stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(stdout).type, "delivery-offer");
  });

  it("CLI refuses malformed input and does not leak arbitrary transport errors", async () => {
    let stderr = "";
    const io = { stdout: () => {}, stderr: (t: string) => { stderr += t; }, readStdin: async () => "{" };
    assert.equal(await run(["reply", "--participant", "cedar", "--locator", "parent-cedar", "--socket", "/unused"], io), 1);
    assert.match(stderr, /not valid JSON/);
    stderr = "";
    const transport = fake(() => { throw new Error("secret=do-not-leak"); });
    assert.equal(await run(["list", "--participant", "cedar", "--locator", "parent-cedar", "--socket", "/unused"], { ...io, readStdin: async () => "{}", transport }), 1);
    assert.doesNotMatch(stderr, /do-not-leak/);
  });
});
