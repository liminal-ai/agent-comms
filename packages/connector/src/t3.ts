// The T3 adapter (packages/adapter-t3, promise-based) as a HarnessAdapter.

import type { T3Adapter } from "@agent-comms/adapter-t3";
import * as Effect from "effect/Effect";
import type { HarnessAdapter } from "./adapter.ts";

export function t3HarnessAdapter(adapter: T3Adapter): HarnessAdapter {
  return {
    harness: "t3",
    ready: (target) => Effect.promise(() => adapter.ready(target)),
    handOff: (target, delivery) => Effect.promise(() => adapter.handOff(target, delivery)),
    awaitOutcome: (target, delivery, turnId) => Effect.promise(() => adapter.awaitOutcome(target, delivery, turnId)),
    check: (target, delivery, turnId) => Effect.promise(() => adapter.check(target, delivery, turnId)),
    notifyUnmatched: (target, delivery) => Effect.promise(() => adapter.notifyUnmatched(target, delivery)),
    presence: (target) => Effect.promise(() => adapter.presence(target)),
  };
}
