#!/usr/bin/env node
// comms-service: the comms service in one process.
//
//   service.mjs [run] --config <file>                 run until SIGINT/SIGTERM (mode from the config)
//   service.mjs web-url --config <file>               local: print the web view's link (it carries the admin token)
//   service.mjs register --config <file> <name> --harness t3|claude-code --locator <thread id|session name>
//                        [--owner <person>] [--description "…"] [--rebind]
//   service.mjs seed --config <file> <seed.json>      local: people, agents and groups (dev-setup's format)
//   service.mjs admin --config <file> <module:function> ['<json args>']
//
// Admin commands talk to the running local service on 127.0.0.1 with the admin
// token from its data directory; they never open the store themselves.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { expand, loadConfig, verifyT3Binding } from "@agent-comms/connector/config";
import { startConvexConnector } from "@agent-comms/connector/convex";
import { listenWeb, webListener } from "../../../scripts/serve-web.mjs";
import { type LocalConfig, loadServiceConfig } from "./config.ts";
import { ADMIN_TOKEN_FILE, credential } from "./data.ts";
import { startLocal } from "./local.ts";

const USAGE = `usage:
  service.mjs [run] --config <file>
  service.mjs web-url --config <file>
  service.mjs register --config <file> <name> --harness t3|claude-code --locator <id> [--owner <person>] [--description "…"] [--rebind]
  service.mjs seed --config <file> <seed.json>
  service.mjs admin --config <file> <module:function> ['<json args>']`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    harness: { type: "string" },
    locator: { type: "string" },
    owner: { type: "string" },
    description: { type: "string" },
    rebind: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const command = positionals[0] && ["run", "web-url", "register", "seed", "admin"].includes(positionals[0]) ? positionals.shift()! : "run";
if (values.help || !values.config) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 2);
}
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
// Startup refusals (wrong mode, a second writer, a live socket, unsafe files) are reported plainly.
let config: ReturnType<typeof loadServiceConfig>;
try {
  config = loadServiceConfig(values.config);
  if (command === "run") await run();
  else {
    if (config.mode !== "local") fail(`${command} is for local mode; a convex-mode service is administered as before (setup/upgrade scripts, web view)`);
    await adminCommand(config);
  }
} catch (error) {
  console.error(`comms-service: ${(error as Error).message}`);
  process.exit(1);
}

async function run() {
  if (config.mode === "convex") {
    // The existing connector and web view, unchanged, in one process.
    const connectorConfig = loadConfig(config.connector);
    if (connectorConfig.adapters?.includes("t3") && connectorConfig.t3) await verifyT3Binding(connectorConfig.t3);
    for (const w of connectorConfig.warnings) log(`warning: ${w}`);
    const connector = await startConvexConnector(connectorConfig, log);
    let web: ReturnType<typeof webListener> | undefined;
    if (config.web) {
      const webConfig = JSON.parse(readFileSync(config.web, "utf8")) as { environment?: string; convexUrl?: string; port?: number; socket?: string; adminTokenFile?: string };
      if (!webConfig.environment || !webConfig.convexUrl || (!webConfig.socket && !Number.isInteger(webConfig.port))) throw new Error("web config requires environment, convexUrl and port (or socket)");
      if (!["http:", "https:"].includes(new URL(webConfig.convexUrl).protocol)) throw new Error("Invalid public Convex URL");
      const root = webRoot();
      if (!root) throw new Error("no built web view beside this service");
      web = webListener(webConfig as { environment: string; convexUrl: string; adminTokenFile?: string }, root, log);
      await listenWeb(web, webConfig as { environment: string; convexUrl: string; port?: number; socket?: string; adminTokenFile?: string }, log);
    }
    onStop(async () => {
      web?.close();
      await connector.stop();
    });
    return;
  }
  const running = await startLocal(config, { log, ...(webRoot() ? { webRoot: webRoot()! } : {}) });
  log(`local comms service running: machine ${config.machine}, socket ${config.socket}`);
  onStop(running.stop);
}

function onStop(stop: () => Promise<void>) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log(`${signal}: stopping`);
      void stop().finally(() => process.exit(0));
    });
  }
}

/** The built web view: beside the bundled service, or apps/web/dist in a checkout. */
function webRoot(): string | undefined {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const dir of [join(here, "web"), join(here, "../../../apps/web/dist")]) {
    if (existsSync(join(dir, "index.html"))) return realpathSync(dir);
  }
  return undefined;
}

// ---------------------------------------------------------------------------

async function adminCommand(config: LocalConfig) {
  const token = credential(config.dataDir, ADMIN_TOKEN_FILE);
  const base = `http://127.0.0.1:${config.web.port}`;
  if (command === "web-url") {
    // The token travels in the fragment: the browser never sends it to the server or logs it.
    console.log(`${base}/#token=${token}`);
    return;
  }
  const call = async (kind: "query" | "mutation", name: string, args: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await fetch(`${base}/api/call`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, name, args: { adminToken: token, ...args } }),
      });
    } catch {
      fail(`no local comms service answering on ${base}; is it running with this config?`);
    }
    const body = (await response.json().catch(() => ({}))) as { value?: unknown; error?: { message: string; data?: { code?: string } } };
    if (!response.ok || body.error) throw Object.assign(new Error(body.error?.message ?? `HTTP ${response.status}`), { code: body.error?.data?.code });
    return body.value;
  };

  if (command === "admin") {
    const [name, json] = positionals;
    if (!name) fail(USAGE);
    const args = json ? (JSON.parse(json) as Record<string, unknown>) : {};
    const listing = name.includes(":") ? name : fail("name a function as module:function, e.g. directory:list");
    let out: unknown;
    try {
      out = await call("query", listing, args);
    } catch (error) {
      if (!/is a mutation/.test((error as Error).message)) throw error;
      out = await call("mutation", listing, args);
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (command === "register") {
    const name = positionals[0]?.replace(/^@/, "");
    const harness = values.harness;
    if (!name || (harness !== "t3" && harness !== "claude-code") || !values.locator) fail(USAGE);
    const home = { machine: config.machine, harness, locator: values.locator };
    if (values.rebind) {
      await call("mutation", "directory:rebind", { name, home });
      console.log(`@${name}: moved to ${harness} ${values.locator} on ${config.machine}`);
      return;
    }
    await call("mutation", "directory:promote", {
      name,
      kind: "agent",
      home,
      owner: values.owner ?? config.owner,
      ...(values.description ? { description: values.description } : {}),
    });
    console.log(`@${name}: registered (${harness} ${values.locator} on ${config.machine}, owner @${values.owner ?? config.owner})`);
    return;
  }

  if (command === "seed") {
    const file = positionals[0] ?? fail(USAGE);
    const seed = JSON.parse(readFileSync(expand(file), "utf8")) as {
      participants?: { name: string; kind: "human" | "agent"; owner?: string; home?: { machine?: string; harness: string; locator: string }; description?: string }[];
      groups?: { title: string; members: string[] }[];
    };
    for (const p of seed.participants ?? []) {
      try {
        await call("mutation", "directory:promote", {
          name: p.name,
          kind: p.kind,
          // Seeds for local mode may leave out the machine: it's this service's.
          ...(p.home ? { home: { ...p.home, machine: p.home.machine ?? config.machine } } : {}),
          ...(p.kind === "agent" ? { owner: p.owner ?? config.owner } : {}),
          ...(p.description ? { description: p.description } : {}),
        });
        console.log(`@${p.name}: registered`);
      } catch (error) {
        if ((error as { code?: string }).code !== "conflict") throw error;
        console.log(`@${p.name}: already exists`);
      }
    }
    for (const g of seed.groups ?? []) {
      const r = (await call("mutation", "conversations:createGroup", { title: g.title, members: g.members })) as { conversation: { id: string } };
      console.log(`group "${g.title}": ${r.conversation.id}`);
    }
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
