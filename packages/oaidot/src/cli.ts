import { parseArgs } from "node:util";
import { resolveSocketPath } from "@agent-comms/comms-cli/client";
import { OaidotClient, OaidotError, OPERATIONS, type Operation, type Transport } from "./client.ts";

export const HELP = `usage: oaidot <stdio|listen|ack|recover|send|reply|read|list|agents|message-status> --participant <name> --locator <parent-binding> [--config <connector.json> | --socket <path>]

--config uses the existing Convex backend directly with a stdio boundary; no local socket is bound.
stdio serves bounded JSON-line requests {id,method,input} until stdin closes; requires --config.
listen blocks on the subscription, prints ONE delivery-offer JSON line, then exits. Optional --lease-ms <ms>.
ack takes {"deliveryId":"...","claimId":"..."} from stdin. Only the actual parent calls it after receipt.
recover reads acknowledged unfinished requests; optional stdin {"cursor":"...","limit":5} pages older work.
Other commands take request JSON on stdin (empty means {}). Identity and parent binding come only from configuration.
send/reply require a stable key. stdout is JSON; diagnostics go to stderr.
`;

export interface IO {
  stdout: (text: string) => void | Promise<void>;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  input?: AsyncIterable<Uint8Array | string>;
  transport?: Transport;
}

export async function run(argv: string[], io: IO): Promise<number> {
  let close: (() => Promise<void>) | undefined;
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      participant: { type: "string" }, locator: { type: "string" }, config: { type: "string" }, socket: { type: "string" },
      "lease-ms": { type: "string" }, help: { type: "boolean", short: "h" },
    } });
    if (values.help) { await io.stdout(HELP); return 0; }
    const command = positionals[0];
    const allowed = ["stdio", "listen", "ack", "recover", "send", "reply", "read", "list", "agents", "message-status"];
    if (positionals.length !== 1 || !values.participant || !values.locator || !command || !allowed.includes(command)) {
      throw new OaidotError("usage", HELP);
    }
    if (values.config && values.socket) throw new OaidotError("usage", "choose --config or --socket");
    if (command === "stdio" && (!values.config || !io.input)) throw new OaidotError("usage", "stdio requires --config and an input stream");
    if (values["lease-ms"] && command !== "listen") throw new OaidotError("usage", "--lease-ms applies only to listen");
    let client: OaidotClient;
    if (values.config && !io.transport) {
      const { createDirectClient } = await import("./direct.ts");
      const host = await createDirectClient({ participant: values.participant, locator: values.locator, configPath: values.config, log: io.stderr });
      client = host.client;
      close = host.close;
    } else {
      client = new OaidotClient({ participant: values.participant, locator: values.locator, socketPath: resolveSocketPath(values.socket), transport: io.transport });
    }
    if (command === "stdio") {
      const { serveStdio } = await import("./stdio.ts");
      await serveStdio(client, { input: io.input!, write: io.stdout, close });
      return 0;
    }
    let result: unknown;
    if (command === "listen") {
      const leaseMs = values["lease-ms"] === undefined ? undefined : Number(values["lease-ms"]);
      result = await client.listen({ leaseMs });
    } else {
      const raw = await io.readStdin();
      const input: unknown = raw.trim() ? JSON.parse(raw) : {};
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new OaidotError("bad_request", "input must be an object");
      if (command === "recover") {
        const { limit, cursor, ...extra } = input as { limit?: unknown; cursor?: unknown };
        if (Object.keys(extra).length) throw new OaidotError("bad_request", "recover takes only limit and cursor");
        result = await client.recover({ limit, cursor });
      } else {
        const op = command === "ack" ? "receive-ack" : command;
        if (!(OPERATIONS as readonly string[]).includes(op)) throw new OaidotError("usage", HELP);
        result = await client.call(op as Operation, input);
      }
    }
    await io.stdout(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    // Do not echo arbitrary transport errors; some clients include arguments.
    const message = error instanceof OaidotError ? `${error.code}: ${error.message}`
      : error instanceof SyntaxError ? "bad_request: stdin is not valid JSON"
      : "unavailable: connector call failed; outcome may be unknown. Retry send/reply with the same key.";
    io.stderr(`oaidot: ${message}\n`);
    return error instanceof OaidotError && ["bad_request", "usage"].includes(error.code) ? 2 : 1;
  } finally {
    await close?.();
  }
}
