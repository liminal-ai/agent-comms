// Shared test helpers: deliveries, temporary homes, waiting.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, MessageKind } from "@agent-comms/protocol";
import { Store } from "../src/store.ts";

export async function tempDir(prefix = "grokbot-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function storeIn(home: string): Store {
  return new Store({
    inboxDir: join(home, "inbox"),
    outboxDir: join(home, "outbox"),
    logFile: join(home, "log.jsonl"),
    stateFile: join(home, "state.json"),
  });
}

export function delivery(overrides: { id?: string; kind?: MessageKind; text?: string; createdAt?: number } = {}): Delivery {
  const id = overrides.id ?? "d_1";
  const kind = overrides.kind ?? "request";
  const lee = { id: "p_lee", name: "lee", kind: "human" as const };
  const grok = { id: "p_grok", name: "grok", kind: "agent" as const };
  return {
    id,
    recipient: grok,
    conversation: { id: "g_build", kind: "group", title: "build" },
    message: {
      id: `m_${id}`,
      conversationId: "g_build",
      seq: 2,
      sender: lee,
      recipients: [grok],
      kind,
      ...(kind === "answer" ? { inReplyTo: "m_0" } : {}),
      text: overrides.text ?? "grok: what's 2+2?",
      attachments: [],
      createdAt: overrides.createdAt ?? 1_000,
      origin: { via: "web" },
    },
    history: { messages: [], omitted: 0 },
    status: { state: "claimed", at: 1_000 },
  };
}

export async function waitFor<T>(what: string, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}
