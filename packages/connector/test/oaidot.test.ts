import { request } from "node:http";
import { call } from "@agent-comms/comms-cli/client";
import { opPath, type Requests, type Responses } from "@agent-comms/protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api.js";
import { createWindowsAgent } from "../../windows-pipe/src/agent.mjs";
import { NativeReceives } from "../src/connector.ts";
import type { ServerApiShape, WorkItem } from "../src/server-api.ts";
import { ADMIN, machine, type Running, sleep, startConnector, until, world } from "./harness.ts";

let running: Running[] = [];
let holders: NativeReceives[] = [];
afterEach(async () => {
  for (const holder of holders) holder.close();
  holders = [];
  for (const r of running) await r.stop().catch(() => {});
  running = [];
});

describe("oaidot receive hold state machine", () => {
  function hold(api: ServerApiShape) {
    const holder = new NativeReceives(api, (effect) => Effect.runPromise(effect));
    holders.push(holder);
    return holder;
  }
  async function snapshot(w: Awaited<ReturnType<typeof nativeWorld>>) {
    return (await w.t.query(api.connector.work, { machine })).deliveries as WorkItem[];
  }
  const req = (waitMs = 500): Requests["receive"] => ({ as: "dot-agent", locator: "dot-agent", waitMs });

  it("waits for the initial snapshot, offers once, and does not ACK on receipt", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    const holder = hold(observed.api);
    const listening = holder.receive(req(), new AbortController().signal);
    await sleep(25);
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "New work" }));
    expect(observed.receives).toHaveLength(0);
    holder.update(await snapshot(w));
    const result = await listening;
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.status.state).toBe("claimed");
    expect(result.deliveries[0]?.status.turnId).toBeUndefined();
    expect(observed.receives).toHaveLength(1);
    expect((await holder.receive(req(30), new AbortController().signal)).deliveries).toEqual([]);
    expect(observed.receives).toHaveLength(1);
  });

  it("uses a one-shot expiry timer with no new work event", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Expired offer" }));
    const first = (await Effect.runPromise(w.api.receive({ as: "dot-agent", locator: "dot-agent", leaseMs: 1_000 }))).deliveries[0]!;
    const observed = counted(w.api);
    const holder = hold(observed.api);
    holder.update(await snapshot(w));
    const listening = holder.receive(req(2_000), new AbortController().signal);
    await sleep(50);
    expect(observed.receives).toHaveLength(0);
    const result = await listening;
    expect(result.deliveries[0]?.id).toBe(first.id);
    expect(result.deliveries[0]?.status.claim?.claimId).not.toBe(first.status.claim!.claimId);
    expect(observed.receives).toHaveLength(1);
  });

  it("never mutates an idle inbox and cleans up both aborts and close", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    const holder = hold(observed.api);
    holder.update([]);
    expect(await holder.receive(req(20), new AbortController().signal)).toEqual({ deliveries: [], hasMore: false });
    const abort = new AbortController();
    const aborted = holder.receive(req(25_000), abort.signal);
    await sleep(20);
    abort.abort();
    expect((await aborted).deliveries).toEqual([]);
    const closing = holder.receive(req(25_000), new AbortController().signal);
    const rejected = expect(closing).rejects.toMatchObject({ code: "unavailable" });
    await sleep(20);
    const closingAt = Date.now();
    holder.close();
    await rejected;
    expect(Date.now() - closingAt).toBeLessThan(1_000);
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "No longer listening" }));
    holder.update(await snapshot(w));
    expect(observed.receives).toHaveLength(0);
  });

  it("serializes concurrent listeners and does not claim one offer twice", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "One offer" }));
    const observed = counted(w.api);
    const holder = hold(observed.api);
    holder.update(await snapshot(w));
    const results = await Promise.all([
      holder.receive(req(100), new AbortController().signal),
      holder.receive(req(100), new AbortController().signal),
    ]);
    expect(results.map((r) => r.deliveries.length).sort()).toEqual([0, 1]);
    expect(observed.receives).toHaveLength(1);
  });

  it("supports an immediate receive and retains an offer whose mutation crossed the hold bound", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Immediate offer" }));
    const holder = hold({ ...w.api, receive: (req) => Effect.sleep("40 millis").pipe(Effect.flatMap(() => w.api.receive(req))) });
    holder.update(await snapshot(w));
    const result = await holder.receive(req(0), new AbortController().signal);
    expect(result.deliveries[0]?.message.text).toBe("Immediate offer");
    expect(result.deliveries[0]?.status.state).toBe("claimed");
  });

  it("does not claim an offer when aborted during identity validation", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Abort before validated" }));
    const observed = counted({ ...w.api, homed: w.api.homed.pipe(Effect.delay("40 millis")) });
    const holder = hold(observed.api);
    holder.update(await snapshot(w));
    const abort = new AbortController();
    const listening = holder.receive(req(), abort.signal);
    abort.abort();
    expect((await listening).deliveries).toEqual([]);
    expect(observed.receives).toHaveLength(0);
  });

  it("suppresses a stale eligible snapshot across unrelated work changes", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Offer no longer eligible" }));
    let calls = 0;
    const holder = hold({ ...w.api, receive: () => { calls++; return Effect.succeed({ deliveries: [], hasMore: false }); } });
    holder.update(await snapshot(w));
    const listening = holder.receive(req(100), new AbortController().signal);
    await sleep(20);
    await Effect.runPromise(w.api.send({ as: "a", to: ["other-dot"], text: "Unrelated" }));
    holder.update(await snapshot(w));
    expect((await listening).deliveries).toEqual([]);
    expect(calls).toBe(1);
  });

  it("reconsiders a previously ineligible offer if it disappears and reappears", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Unpaused again" }));
    let calls = 0;
    const holder = hold({ ...w.api, receive: (request) => ++calls === 1
      ? Effect.succeed({ deliveries: [], hasMore: false })
      : w.api.receive(request) });
    const items = await snapshot(w);
    holder.update(items);
    const listening = holder.receive(req(), new AbortController().signal);
    await until("the first receive attempt", async () => calls === 1);
    holder.update([]);
    holder.update(items);
    expect((await listening).deliveries[0]?.message.text).toBe("Unpaused again");
    expect(calls).toBe(2);
  });

  it("validates identities before holding or offering work", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    const holder = hold(observed.api);
    for (const as of ["missing", "lee"]) {
      await expect(holder.receive({ as, locator: as }, new AbortController().signal)).rejects.toMatchObject({ code: "not_homed_here" });
    }
    await expect(holder.receive({ as: "a", locator: "a" }, new AbortController().signal)).rejects.toMatchObject({ code: "bad_request" });
    await expect(holder.receive({ as: "dot-agent", locator: "wrong-thread" }, new AbortController().signal)).rejects.toMatchObject({ code: "conflict" });
    expect(observed.receives).toHaveLength(0);
  });

  it("rejects a held listener after a same-machine locator rebind without claiming the new work", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    const holder = hold(observed.api);
    holder.update([]);
    const listening = holder.receive(req(), new AbortController().signal);
    const rejected = expect(listening).rejects.toMatchObject({ code: "conflict" });
    await sleep(25);
    await w.t.mutation(api.directory.rebind, {
      adminToken: ADMIN, name: "dot-agent", home: { machine: machine.id, harness: "oaidot", locator: "new-native-thread" },
    });
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "For the new thread only" }));
    holder.update(await snapshot(w));
    await rejected;
    expect(observed.receives).toHaveLength(0);
    expect((await snapshot(w))[0]?.state).toBe("pending");
    const newListener = await holder.receive({ ...req(), locator: "new-native-thread" }, new AbortController().signal);
    expect(newListener.deliveries[0]?.message.text).toBe("For the new thread only");
  });

  it("allows retired participants to recall acknowledged work but not listen for new offers", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Finish after retirement" }));
    const first = (await Effect.runPromise(w.api.receive({ as: "dot-agent", locator: "dot-agent" }))).deliveries[0]!;
    await Effect.runPromise(w.api.receiveAck({ as: "dot-agent", locator: "dot-agent", deliveryId: first.id, claimId: first.status.claim!.claimId }));
    await w.t.mutation(api.directory.setState, { adminToken: ADMIN, name: "dot-agent", state: "retired" });
    const holder = hold(w.api);
    const recovered = await holder.receive({ ...req(), includeDelivered: true }, new AbortController().signal);
    expect(recovered.deliveries.map((d) => d.id)).toEqual([first.id]);
    await expect(holder.receive(req(), new AbortController().signal)).rejects.toMatchObject({ code: "not_homed_here" });
  });

  it("recovers acknowledged requests without needing or consuming work snapshots", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Already acknowledged" }));
    const first = (await Effect.runPromise(w.api.receive({ as: "dot-agent", locator: "dot-agent" }))).deliveries[0]!;
    await Effect.runPromise(w.api.receiveAck({ as: "dot-agent", locator: "dot-agent", deliveryId: first.id, claimId: first.status.claim!.claimId }));
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Must stay pending" }));
    const observed = counted(w.api);
    const holder = hold(observed.api);
    const recalled = await holder.receive({ as: "dot-agent", locator: "dot-agent", includeDelivered: true, waitMs: 0 }, new AbortController().signal);
    expect(recalled.deliveries.map((d) => d.id)).toEqual([first.id]);
    expect(recalled.deliveries[0]?.status.state).toBe("delivered");
    expect((await snapshot(w)).map((item) => item.state)).toEqual(["pending"]);
    expect(observed.receives).toHaveLength(1);
  });

  it("forwards recovery cursors so later acknowledged requests remain reachable", async () => {
    const w = await nativeWorld();
    for (const text of ["First acknowledged", "Second acknowledged"]) {
      await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text }));
      const offered = (await Effect.runPromise(w.api.receive({ as: "dot-agent", locator: "dot-agent" }))).deliveries[0]!;
      await Effect.runPromise(w.api.receiveAck({ as: "dot-agent", locator: "dot-agent", deliveryId: offered.id, claimId: offered.status.claim!.claimId }));
    }
    const holder = hold(w.api);
    const first = await holder.receive({ ...req(), includeDelivered: true, limit: 1 }, new AbortController().signal);
    expect(first.deliveries[0]?.message.text).toBe("First acknowledged");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await holder.receive({ ...req(), includeDelivered: true, limit: 1, cursor: first.nextCursor }, new AbortController().signal);
    expect(second.deliveries[0]?.message.text).toBe("Second acknowledged");
    expect(second.hasMore).toBe(false);
  });
});
const start = async (...args: Parameters<typeof startConnector>) => {
  const r = await startConnector(...args);
  running.push(r);
  return r;
};

async function nativeWorld() {
  const w = await world();
  for (const name of ["dot-agent", "other-dot"]) {
    await w.t.mutation(api.directory.promote, {
      adminToken: ADMIN,
      name,
      kind: "agent",
      owner: "lee",
      home: { machine: machine.id, harness: "oaidot", locator: name },
    });
  }
  return w;
}

function counted(api: ServerApiShape) {
  const receives: Requests["receive"][] = [];
  let subscriptions = 0;
  const wrapped: ServerApiShape = {
    ...api,
    receive: (req) => {
      receives.push(req);
      return api.receive(req);
    },
    work: Stream.suspend(() => {
      subscriptions++;
      return api.work;
    }),
  };
  return { api: wrapped, receives, subscriptions: () => subscriptions };
}

async function send(socket: string, to = "dot-agent", text = "Please inspect this") {
  const sent = await call(socket, "send", { as: "a", to: [to], text });
  if (!sent.ok) throw new Error(sent.error.message);
  return sent;
}

async function receive(socket: string, req: Partial<Requests["receive"]> = {}) {
  const result = await call(socket, "receive", { as: "dot-agent", locator: "dot-agent", waitMs: 2_000, ...req });
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

async function state(w: Awaited<ReturnType<typeof nativeWorld>>, conversationId: string, messageId: string) {
  const view = await w.t.query(api.conversations.view, { adminToken: ADMIN, conversationId });
  return view.messages.find((m) => m.message.id === messageId)?.deliveries.find((d) => d.recipient === "dot-agent");
}

/** A real held HTTP request whose client can disappear before an offer arrives. */
function abortableReceive(socket: string, body: Requests["receive"]) {
  const payload = JSON.stringify(body);
  let cancel = () => {};
  const settled = new Promise<void>((resolve) => {
    const agent = process.platform === "win32" ? createWindowsAgent(socket) : undefined;
    const req = request({
      socketPath: socket,
      ...(agent ? { agent } : {}),
      path: opPath("receive"),
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      res.resume();
      res.on("end", resolve);
      res.on("close", resolve);
    });
    req.on("error", () => resolve());
    cancel = () => req.destroy();
    req.end(payload);
  });
  return { cancel: () => cancel(), settled };
}

describe("oaidot event-driven courier", () => {
  it("wakes a held receive on new work, then separates offer, receipt, and explicit reply", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    await start(observed.api, w.socket);
    let settled = false;
    const held = receive(w.socket).then((r) => { settled = true; return r; });
    await sleep(150);
    expect(settled).toBe(false);
    expect(observed.receives).toHaveLength(0);
    await send(w.socket, "other-dot", "Someone else's message");
    await sleep(100);
    expect(settled).toBe(false);
    expect(observed.receives).toHaveLength(0);

    const sent = await send(w.socket);
    const result = await held;
    expect(result.deliveries).toHaveLength(1);
    const delivery = result.deliveries[0]!;
    expect(delivery.recipient.name).toBe("dot-agent");
    expect(delivery.message.id).toBe(sent.message.id);
    expect(delivery.status.state).toBe("claimed");
    expect(delivery.status.claim?.claimId).toBeTruthy();
    expect(delivery.status.turnId).toBeUndefined();
    expect((await state(w, sent.message.conversationId, sent.message.id))?.state).toBe("claimed");
    expect(observed.receives).toHaveLength(1);
    expect(observed.subscriptions()).toBe(1);

    const receipt = await call(w.socket, "receive-ack", { as: "dot-agent", locator: "dot-agent", deliveryId: delivery.id, claimId: delivery.status.claim!.claimId });
    expect(receipt.ok && receipt.delivery.state).toBe("delivered");
    await sleep(150);
    const recalled = await receive(w.socket, { waitMs: 100 });
    expect(recalled.deliveries).toEqual([]);
    expect(observed.receives).toHaveLength(1);
    const view = await w.t.query(api.conversations.view, { adminToken: ADMIN, conversationId: sent.message.conversationId });
    expect(view.messages).toHaveLength(1); // No automatic collection or fabricated native turn.

    const answered = await call(w.socket, "reply", { as: "dot-agent", messageId: sent.message.id, text: "Inspected; all clear", key: "native-explicit-reply" });
    expect(answered.ok).toBe(true);
    expect((await state(w, sent.message.conversationId, sent.message.id))?.state).toBe("replied");
  });

  it("handles the initial snapshot and bounds each offer to the requested batch", async () => {
    const w = await nativeWorld();
    for (const text of ["first", "second", "third"]) {
      await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text }));
    }
    const observed = counted(w.api);
    await start(observed.api, w.socket);
    const first = await receive(w.socket);
    expect(first.deliveries.map((d) => d.message.text)).toEqual(["first"]);
    expect(first.hasMore).toBe(true);
    const rest = await receive(w.socket, { limit: 2 });
    expect(rest.deliveries.map((d) => d.message.text)).toEqual(["second", "third"]);
    expect(rest.hasMore).toBe(false);
    expect(observed.receives).toHaveLength(2);
  });

  it("returns at the local hold bound without mutating the server when idle", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    await start(observed.api, w.socket);
    for (let i = 0; i < 3; i++) {
      const result = await receive(w.socket, { waitMs: 75 });
      expect(result.deliveries).toEqual([]);
      expect(result.hasMore).toBe(false);
    }
    expect(observed.receives).toHaveLength(0);
    expect(observed.subscriptions()).toBe(1);
  });

  it("wakes at claim expiry without another subscription event or lease renewal", async () => {
    const w = await nativeWorld();
    await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "Recover a lost offer" }));
    const first = await Effect.runPromise(w.api.receive({ as: "dot-agent", locator: "dot-agent", leaseMs: 1_000 }));
    const original = first.deliveries[0]!;
    const observed = counted({ ...w.api, work: w.api.work.pipe(Stream.take(1)) });
    await start(observed.api, w.socket);
    const next = receive(w.socket, { waitMs: 2_000 });
    await sleep(150);
    expect(observed.receives).toHaveLength(0);
    const recovered = (await next).deliveries[0]!;
    expect(recovered.id).toBe(original.id);
    expect(recovered.status.claim?.claimId).not.toBe(original.status.claim!.claimId);
    expect(recovered.status.turnId).toBeUndefined();
    expect(observed.receives).toHaveLength(1);
  });

  it("does not busy-poll a stale eligible snapshot after an empty receive", async () => {
    const w = await nativeWorld();
    let calls = 0;
    const empty: Responses["receive"] = { deliveries: [], hasMore: false };
    await start({ ...w.api, receive: () => { calls++; return Effect.succeed(empty); } }, w.socket);
    await send(w.socket);
    const held = receive(w.socket, { waitMs: 350 });
    await until("the initial receive", async () => calls === 1);
    await send(w.socket, "other-dot", "An unrelated subscription change");
    expect((await held).deliveries).toEqual([]);
    expect(calls).toBe(1);
  });

  it("removes an aborted listener so later work remains pending", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    await start(observed.api, w.socket);
    const held = abortableReceive(w.socket, { as: "dot-agent", locator: "dot-agent", waitMs: 25_000 });
    await sleep(100);
    held.cancel();
    await held.settled;
    await sleep(75);
    const sent = await send(w.socket);
    await sleep(150);
    expect(observed.receives).toHaveLength(0);
    expect((await state(w, sent.message.conversationId, sent.message.id))?.state).toBe("pending");
    expect((await receive(w.socket)).deliveries[0]?.message.id).toBe(sent.message.id);
  });

  it("closes a held listener promptly and unsubscribes from new work", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    const connector = await start(observed.api, w.socket);
    let entered: () => void = () => {};
    const listening = new Promise<void>((resolve) => { entered = resolve; });
    let settled = false;
    let serverResult: Promise<{ error?: unknown; at: number }> | undefined;
    const receive = NativeReceives.prototype.receive;
    // Observe the real holder's settlement without including pipe startup or
    // teardown. The Windows transport has a separate PowerShell bridge process.
    const spy = vi.spyOn(NativeReceives.prototype, "receive").mockImplementation(function (
      this: NativeReceives, req: Requests["receive"], aborted: AbortSignal,
    ) {
      const result = receive.call(this, req, aborted);
      serverResult = result.then(
        () => { settled = true; return { at: Date.now() }; },
        (error: unknown) => { settled = true; return { error, at: Date.now() }; },
      );
      entered();
      return result;
    });
    try {
      const held = call(w.socket, "receive", { as: "dot-agent", locator: "dot-agent", waitMs: 25_000 }).catch(() => undefined);
      await listening; // The request reached the connector, even on slow pipe startup.
      expect(settled).toBe(false);
      const before = Date.now();
      const stopping = connector.stop();
      // Still await both the real client and all transport/process cleanup.
      // The test's overall bound covers those separately from the holder's one-second bound.
      const [result] = await Promise.all([serverResult!, stopping, held]);
      running = running.filter((r) => r !== connector);
      expect(result.error).toMatchObject({ code: "unavailable" });
      expect(result.at - before).toBeLessThan(1_000);
      await Effect.runPromise(w.api.send({ as: "a", to: ["dot-agent"], text: "After connector close" }));
      await sleep(100);
      expect(observed.receives).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  }, process.platform === "win32" ? 15_000 : 5_000);

  it("rejects invalid or foreign identities even with an empty inbox", async () => {
    const w = await nativeWorld();
    await w.t.mutation(api.directory.registerMachine, { adminToken: ADMIN, machineId: "elsewhere", secret: "another-machine-secret" });
    await w.t.mutation(api.directory.promote, {
      adminToken: ADMIN, name: "remote-dot", kind: "agent", owner: "lee",
      home: { machine: "elsewhere", harness: "oaidot", locator: "remote-dot" },
    });
    const observed = counted(w.api);
    await start(observed.api, w.socket);
    for (const as of ["missing", "remote-dot", "lee"]) {
      const result = await call(w.socket, "receive", { as, locator: as, waitMs: 25_000 });
      expect(!result.ok && result.error.code).toBe("not_homed_here");
    }
    const wrongHarness = await call(w.socket, "receive", { as: "a", locator: "a", waitMs: 25_000 });
    expect(!wrongHarness.ok && wrongHarness.error.code).toBe("bad_request");
    expect(observed.receives).toHaveLength(0);
  });

  it("recalls delivered requests explicitly without claiming queued fresh work", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    await start(observed.api, w.socket);
    const sent = await send(w.socket);
    const offered = (await receive(w.socket)).deliveries[0]!;
    const ack = await call(w.socket, "receive-ack", { as: "dot-agent", locator: "dot-agent", deliveryId: offered.id, claimId: offered.status.claim!.claimId });
    expect(ack.ok).toBe(true);
    const fresh = await send(w.socket, "dot-agent", "Fresh work must remain queued");
    const recovered = await receive(w.socket, { includeDelivered: true, waitMs: 0 });
    expect(recovered.deliveries.map((d) => d.id)).toEqual([offered.id]);
    expect(recovered.deliveries[0]?.status.state).toBe("delivered");
    expect(recovered.deliveries[0]?.status.claim).toBeUndefined();
    expect((await state(w, fresh.message.conversationId, fresh.message.id))?.state).toBe("pending");
    expect((await state(w, sent.message.conversationId, sent.message.id))?.state).toBe("delivered");
    expect(observed.receives).toHaveLength(2);
  });

  it("rejects an old held binding after a same-machine native thread rebind", async () => {
    const w = await nativeWorld();
    const observed = counted(w.api);
    await start(observed.api, w.socket);
    const held = call(w.socket, "receive", { as: "dot-agent", locator: "dot-agent", waitMs: 2_000 });
    await sleep(100);
    await w.t.mutation(api.directory.rebind, {
      adminToken: ADMIN, name: "dot-agent", home: { machine: machine.id, harness: "oaidot", locator: "new-native-thread" },
    });
    await send(w.socket, "dot-agent", "For the newly bound thread");
    const result = await held;
    expect(!result.ok && result.error.code).toBe("conflict");
    expect(observed.receives).toHaveLength(0);
    const newListener = await receive(w.socket, { locator: "new-native-thread" });
    expect(newListener.deliveries[0]?.message.text).toBe("For the newly bound thread");
  });
});
