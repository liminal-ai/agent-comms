// The agent registry (capabilities pass §1): participants as registry entries,
// presence with staleness, and profile edits.

import {
  MAX_DESCRIPTION_CHARS,
  MAX_DUTIES,
  MAX_DUTY_CHARS,
  type Presence,
  PRESENCE_STALE_MS,
  type RegistryEntry,
} from "@agent-comms/protocol";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail, ref, refById } from "./core";

type StoredPresence = Doc<"participants">["presence"];

/** The presence to store for a status write: `idleSince` and `busySince` move only on the transition. */
export function nextPresence(previous: StoredPresence, status: StoredPresence["status"], now: number): StoredPresence {
  const since = previous.status === status ? ((status === "idle" ? previous.idleSince : previous.busySince) ?? previous.at) : now;
  if (status === "idle") return { status, at: now, idleSince: since };
  if (status === "busy") return { status, at: now, busySince: since };
  return { status, at: now };
}

/** Machine id → last heartbeat, for staleness. */
export async function machineSeen(ctx: QueryCtx): Promise<Map<string, number | null>> {
  const machines = await ctx.db.query("machines").collect();
  return new Map(machines.map((m) => [m.machineId, m.lastSeenAt ?? null]));
}

/** Presence as the registry shows it. People and system participants have none. */
export function presenceOf(p: Doc<"participants">, seen: Map<string, number | null>, now: number): Presence | null {
  if (p.kind !== "agent" || !p.home) return null;
  const lastSeen = seen.get(p.home.machine) ?? null;
  const stale = lastSeen === null || now - lastSeen >= PRESENCE_STALE_MS;
  return {
    status: p.presence.status,
    at: p.presence.at,
    ...(p.presence.status === "idle" && p.presence.idleSince !== undefined ? { idleSince: p.presence.idleSince } : {}),
    ...(p.presence.status === "busy" && p.presence.busySince !== undefined ? { busySince: p.presence.busySince } : {}),
    stale,
  };
}

export async function registryEntry(
  ctx: QueryCtx,
  p: Doc<"participants">,
  seen: Map<string, number | null>,
  now: number,
  options: { long: boolean },
): Promise<RegistryEntry> {
  return {
    participant: ref(p),
    state: p.state,
    presence: presenceOf(p, seen, now),
    ...(p.description ? { description: p.description } : {}),
    ...(p.duties && p.duties.length > 0 ? { duties: p.duties } : {}),
    ...(p.ownerId ? { owner: await refById(ctx, p.ownerId) } : {}),
    ...(p.home ? { harness: p.home.harness } : {}),
    ...(p.home && options.long ? { home: p.home } : {}),
  };
}

const LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * Checks a profile edit and returns the fields to patch. An empty description
 * or an empty duty list clears that field.
 */
export function profilePatch(input: { description?: string; duties?: string[] }): Partial<Doc<"participants">> {
  const patch: Partial<Doc<"participants">> = {};
  if (input.description !== undefined) {
    const d = input.description.trim();
    if (d.length > MAX_DESCRIPTION_CHARS) fail("bad_request", `a description is at most ${MAX_DESCRIPTION_CHARS} characters`);
    if (LINE_BREAK.test(d)) fail("bad_request", "a description is one line");
    patch.description = d.length > 0 ? d : undefined;
  }
  if (input.duties !== undefined) {
    if (input.duties.length > MAX_DUTIES) fail("bad_request", `at most ${MAX_DUTIES} duties`);
    const duties = input.duties.map((d) => d.trim());
    for (const d of duties) {
      if (d.length === 0 || d.length > MAX_DUTY_CHARS) fail("bad_request", `a duty is 1-${MAX_DUTY_CHARS} characters`);
      if (LINE_BREAK.test(d)) fail("bad_request", "a duty is one line");
    }
    patch.duties = duties.length > 0 ? duties : undefined;
  }
  return patch;
}
