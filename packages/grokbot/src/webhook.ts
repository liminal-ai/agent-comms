// The optional outbound wake: a small JSON POST when a delivery arrives or a
// request times out, so whatever runs Grok Bot can wake it instead of polling
// the inbox. Off unless configured; the text is included only on request.
// An Authorization header comes from a file, read at each wake so it can be
// rotated without a restart; it never appears in the log.

import { readFile } from "node:fs/promises";
import type { GrokbotConfig } from "./config.ts";
import type { InboxItem } from "./store.ts";

export type WakeEvent = "delivery" | "timeout";

export function wakePayload(event: WakeEvent, item: InboxItem, options: { includeText: boolean; inboxFile: string }) {
  return {
    event,
    participant: item.recipient,
    deliveryId: item.deliveryId,
    messageId: item.messageId,
    kind: item.kind,
    expectsReply: item.expectsReply,
    from: item.from.name,
    conversation: { id: item.conversation.id, kind: item.conversation.kind, ...(item.conversation.title ? { title: item.conversation.title } : {}) },
    receivedAt: item.receivedAt,
    ...(item.deadlineAt ? { deadlineAt: item.deadlineAt } : {}),
    state: item.state,
    inboxFile: options.inboxFile,
    ...(options.includeText ? { text: item.text, rendered: item.rendered } : {}),
  };
}

export type Wake = (event: WakeEvent, item: InboxItem, inboxFile: string) => Promise<void>;

export function webhookWake(hook: NonNullable<GrokbotConfig["wakeWebhook"]>, request: typeof fetch = fetch): Wake {
  return async (event, item, inboxFile) => {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "agent-comms-grokbot" };
    if (hook.authorizationFile) {
      const authorization = (await readFile(hook.authorizationFile, "utf8")).trim();
      if (!authorization) throw new Error(`wake webhook authorization file ${hook.authorizationFile} is empty`);
      headers.authorization = authorization;
    }
    const res = await request(hook.url, {
      method: "POST",
      headers,
      body: JSON.stringify(wakePayload(event, item, { includeText: hook.includeText, inboxFile })),
      signal: AbortSignal.timeout(hook.timeoutMs),
    });
    if (!res.ok) throw new Error(`wake webhook answered HTTP ${res.status}`);
  };
}
