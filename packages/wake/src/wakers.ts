// How each kind of sandbox is woken. One adapter per sandbox platform; the
// coordinator doesn't care which. Secrets are read from files at each wake (so
// they can be rotated without a restart) and never logged.

import { readFile } from "node:fs/promises";
import type { WakeFn } from "./coordinator.ts";

/** POST a small JSON event to a URL, e.g. a Grok Bot routine's "when a webhook fires" trigger. */
export interface WebhookWaker {
  kind: "webhook";
  /** A file holding the URL. It can carry a secret, so it isn't kept in the config. */
  urlFile: string;
  /** A file holding a bearer key, sent as `Authorization: Bearer <key>`. Optional. */
  bearerKeyFile?: string;
  /** Default 10 s. */
  timeoutMs?: number;
}

export type WakerConfig = WebhookWaker;

export const WAKER_KINDS = ["webhook"] as const;

async function secret(path: string, what: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${what} file is empty`);
  return value;
}

export function webhookWaker(participant: string, config: WebhookWaker, request: typeof fetch = fetch): WakeFn {
  return async (deliveryIds) => {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "agent-comms-wake" };
    if (config.bearerKeyFile) headers.authorization = `Bearer ${await secret(config.bearerKeyFile, "bearer key")}`;
    const res = await request(await secret(config.urlFile, "webhook URL"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "delivery",
        participant,
        deliveryIds,
        note: "agent-comms: you have a delivery waiting. Check your comms inbox and answer it.",
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
    // Drain the body; it can echo identifiers, so it isn't logged.
    await res.text().catch(() => "");
    if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
  };
}

export function makeWaker(participant: string, config: WakerConfig, request: typeof fetch = fetch): WakeFn {
  switch (config.kind) {
    case "webhook":
      return webhookWaker(participant, config, request);
  }
}
