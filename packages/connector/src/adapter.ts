// What the dispatcher needs from a harness adapter. One adapter per harness
// (T3, Claude Code); each serves every participant homed in that harness here.

import type { Delivery, EnteredInput, Harness } from "@agent-comms/protocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface Target {
  /** The participant's name. */
  participant: string;
  /** The harness-specific locator from its home: a T3 thread id, a Claude Code participant name. */
  locator: string;
}

/** Handing a rendered delivery to the harness. */
export type HandOff =
  /** The harness recorded our message; this is the turn it went into. `cursor`: where to resume watching after a restart. */
  | { _tag: "accepted"; turnId: string; cursor?: string }
  /** The harness refused it outright; it never ran. */
  | { _tag: "rejected"; detail: string }
  /** We lost sight of it (session gone mid-handoff): it may or may not have entered. Recovered by a later check. */
  | { _tag: "lost"; detail: string };

/** How our turn ended. */
export type Outcome =
  | { _tag: "replied"; answer: string }
  | { _tag: "ambiguous"; entered: EnteredInput[] }
  | { _tag: "failed"; reason: "aborted" | "refusal" | "error"; detail?: string }
  /** We lost sight of the turn; recovered by a later check. */
  | { _tag: "lost"; detail: string };

/** The restart question: does the harness have this delivery, and what happened to its turn? */
export type Check =
  | { _tag: "absent" }
  | { _tag: "running"; turnId: string }
  /** `outcome` absent: the turn finished but its outcome isn't known (fine for an answer's delivery; a request's becomes uncertain). */
  | { _tag: "completed"; turnId: string; outcome?: Exclude<Outcome, { _tag: "lost" }> }
  | { _tag: "unknown"; detail: string }
  /** Can't ask right now (no session to ask); try again later without changing anything. */
  | { _tag: "later"; detail: string };

export interface HarnessAdapter {
  readonly harness: Harness;
  /** Whether deliveries can be handed to this participant now. The dispatcher claims nothing it can't hand over. */
  readonly ready: (target: Target) => Effect.Effect<boolean>;
  /** Hand the delivery over. Waits until the harness accepts it or refuses. */
  readonly handOff: (target: Target, delivery: Delivery) => Effect.Effect<HandOff>;
  /** Wait for our turn to end. Only called for deliveries of a request. */
  readonly awaitOutcome: (target: Target, delivery: Delivery, turnId: string) => Effect.Effect<Outcome>;
  /** Answer the restart question for a claimed (`turnId` unknown) or delivered delivery. */
  readonly check: (target: Target, delivery: Delivery, turnId: string | undefined) => Effect.Effect<Check>;
  /**
   * Tell the agent its reply to this delivery couldn't be matched and it should
   * `comms reply` (renderUnmatchedNotice). Optional: the mod does this itself.
   */
  readonly notifyUnmatched?: (target: Target, delivery: Delivery) => Effect.Effect<void>;
  /** The participant's presence, for adapters that can read it from the harness (T3). The mod reports its own. */
  readonly presence?: (target: Target) => Effect.Effect<"idle" | "busy" | "offline">;
}

export class Adapters extends Context.Service<Adapters, ReadonlyMap<Harness, HarnessAdapter>>()("agent-comms/Adapters") {}

export interface PokeShape {
  readonly poke: () => void;
  readonly subscribe: (f: () => void) => () => void;
}

/** Adapters call this when readiness may have changed (a session registered), so the dispatcher looks again. */
export class Poke extends Context.Service<Poke, PokeShape>()("agent-comms/Poke") {}

export function makePoke(): PokeShape {
  const listeners = new Set<() => void>();
  return {
    poke: () => {
      for (const f of [...listeners]) f();
    },
    subscribe: (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
  };
}
