// The connector against a Convex deployment (multi-host mode): the Convex
// client as the server API. Shared by main.ts and the comms service's convex mode.

import { ConvexClient } from "convex/browser";
import type { LoadedConfig } from "./config.ts";
import { type ConvexTransport, describeFailure, makeServerApi } from "./server-api.ts";
import { startConnector } from "./start.ts";

export async function startConvexConnector(config: LoadedConfig, log: (line: string) => void): Promise<{ stop: () => Promise<void> }> {
  // The Convex client's own logging prints server errors, which can echo a call's arguments (the
  // machine secret among them). It only gets to log what's known to be safe (fix pass 3.6).
  const quiet = (level: string) => (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (/ConvexError: \{"code":"[a-z_]+"/.test(text) || /^\[CONVEX [A-Z]\(/.test(text)) {
      const code = /"code":"([a-z_]+)"/.exec(text)?.[1];
      if (code) log(`convex ${level}: refused (${code})`);
      return;
    }
    log(`convex ${level}: ${describeFailure(new Error(text))}`);
  };
  const client = new ConvexClient(config.convexUrl, {
    unsavedChangesWarning: false,
    logger: { log: () => {}, logVerbose: () => {}, warn: quiet("warn"), error: quiet("error") },
  });
  const transport: ConvexTransport = {
    query: (ref, args) => client.query(ref, args),
    mutation: (ref, args) => client.mutation(ref, args),
    watch: (ref, args, onValue, onError) => {
      const unsubscribe = client.onUpdate(ref, args, onValue, onError);
      return () => unsubscribe();
    },
  };
  client.subscribeToConnectionState((state) => {
    if (!state.isWebSocketConnected && state.hasEverConnected) log("server connection lost; retrying");
  });

  const api = makeServerApi(transport, { machine: { id: config.machine, secret: config.secret } });
  const connector = await startConnector(config, api, log);
  return { stop: () => connector.stop().finally(() => client.close()) };
}
