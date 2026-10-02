// Adversarial review repro (scratch only): the T3 ack rule can't see a turn change.
import { run as comms } from "@agent-comms/comms-cli";
import { call } from "@agent-comms/comms-cli/client";
import * as Effect from "effect/Effect";
import { afterEach, expect, it } from "vitest";
import type { HarnessAdapter } from "../src/adapter.ts";
import { Mod, type Running, startConnector, world } from "./harness.ts";

let running: Running[] = [];
afterEach(async () => {
  for (const r of running) await r.stop().catch(() => {});
  running = [];
});

it("a T3 waiter whose turn ended and a new one began before the answer: the CLI's ack counts, so no fallback ever reaches the thread", async () => {
  const w = await world();
  // T3 thread for @tee: turn A (ran the CLI) ends and turn B starts between two presence reads.
  // Every read the connector makes (startup poll, refresh at send, refresh at ack) sees "busy".
  const reads: string[] = [];
  const t3: HarnessAdapter = {
    harness: "t3",
    ready: () => Effect.succeed(false),
    handOff: () => Effect.die("unused"),
    awaitOutcome: () => Effect.die("unused"),
    check: () => Effect.die("unused"),
    presence: () => Effect.sync(() => (reads.push("busy"), "busy" as const)),
  };
  running.push(await startConnector(w.api, w.socket, 1_500, [t3]));
  const b = new Mod(w.socket, "b");
  await b.register();
  let stdout = "";
  const cli = comms(["--socket", w.socket, "send", "--as", "tee", "@b", "q"], { env: {}, stdout: (s) => (stdout += s), stderr: () => {}, readStdin: async () => "" });
  const d = await b.nextDelivery();
  // ... turn A ends here, turn B begins (T3 adapter's waitIdle → startTurn writes no presence) ...
  await b.ok("delivered", { deliveryId: d.id, turnId: "t1" } as never);
  await b.ok("outcome", { deliveryId: d.id, turnId: "t1", outcome: "replied", answer: "nobody reads this" } as never);
  expect(await cli).toBe(0);
  const id = /^sent (\S+)/m.exec(stdout)![1]!;
  const s = await call(w.socket, "message-status", { as: "tee", messageId: id });
  expect(s.ok && s.wait?.results[0]!.state).toBe("acknowledged"); // never falls back
  expect(reads.length).toBeGreaterThanOrEqual(2);
});
