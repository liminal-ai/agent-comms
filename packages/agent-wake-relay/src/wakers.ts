// How each kind of sandbox is woken. One adapter per sandbox platform; the
// coordinator doesn't care which. Secrets are read from files at each wake (so
// they can be rotated without a restart) and never logged.

import { readFile } from "node:fs/promises";
import type { WakeFn } from "./coordinator.ts";
import type { EventHub } from "./mcp/events.ts";

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

/**
 * Send an MCP Events webhook event to every ChatGPT conversation subscribed to
 * the agent's event, through the MCP server agent-wake-relay hosts (the `mcp`
 * section of the config). For agents living in a ChatGPT conversation (Dot).
 */
export interface McpEventsWaker {
  kind: "mcp-events";
  /** The event's name. Default `comms.delivery.<participant>`. */
  event?: string;
}

export type WakerConfig = WebhookWaker | McpEventsWaker;

export const WAKER_KINDS = ["webhook", "mcp-events"] as const;

export function eventName(participant: string, config: McpEventsWaker): string {
  return config.event ?? `comms.delivery.${participant}`;
}

async function secret(path: string, what: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${what} file is empty`);
  return value;
}

export function webhookWaker(participant: string, config: WebhookWaker, request: typeof fetch = fetch): WakeFn {
  return async (deliveryIds) => {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "agent-comms-agent-wake-relay" };
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

export interface WakerDeps {
  request?: typeof fetch;
  /** The MCP Events hub, when the config has an `mcp` section. */
  events?: EventHub;
}

export function makeWaker(participant: string, config: WakerConfig, deps: WakerDeps = {}): WakeFn {
  switch (config.kind) {
    case "webhook":
      return webhookWaker(participant, config, deps.request);
    case "mcp-events":
      if (!deps.events) throw new Error(`@${participant}: the mcp-events waker needs the config's mcp section`);
      return deps.events.waker(participant);
  }
}
