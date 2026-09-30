#!/usr/bin/env node
// Seeds a development deployment: registers a machine's connector secret and
// promotes participants. Secrets are read from files and never printed.
//
//   node scripts/dev-setup.ts --url http://127.0.0.1:3240 --admin-token-file <f> --seed <seed.json>
//
// seed.json:
//   { "machine": { "id": "lim-builder", "secretFile": "~/.config/agent-comms/lim-builder.secret" },
//     "participants": [ { "name": "lee", "kind": "human" },
//                       { "name": "x", "kind": "agent", "home": { "machine": "lim-builder", "harness": "claude-code", "locator": "x" } } ],
//     "groups": [ { "title": "build", "members": ["lee", "x"] } ] }
// Re-running is safe: existing participants are left alone, groups are created again.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const { values } = parseArgs({
  options: { url: { type: "string" }, "admin-token-file": { type: "string" }, seed: { type: "string" } },
});
if (!values.url || !values["admin-token-file"] || !values.seed) {
  console.error("usage: dev-setup.ts --url <convex url> --admin-token-file <file> --seed <seed.json>");
  process.exit(2);
}
const expand = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));
const adminToken = readFileSync(expand(values["admin-token-file"]), "utf8").trim();
const seed = JSON.parse(readFileSync(expand(values.seed), "utf8")) as {
  machine?: { id: string; secretFile: string };
  participants?: { name: string; kind: "human" | "agent"; home?: { machine: string; harness: "t3" | "claude-code" | "web"; locator: string } }[];
  groups?: { title: string; members: string[] }[];
};
const client = new ConvexHttpClient(values.url);

if (seed.machine) {
  const secret = readFileSync(expand(seed.machine.secretFile), "utf8").trim();
  await client.mutation(api.directory.registerMachine, { adminToken, machineId: seed.machine.id, secret });
  console.log(`machine ${seed.machine.id}: credential registered`);
}
for (const p of seed.participants ?? []) {
  try {
    await client.mutation(api.directory.promote, { adminToken, name: p.name, kind: p.kind, ...(p.home ? { home: p.home } : {}) });
    console.log(`@${p.name}: promoted`);
  } catch (error) {
    const code = (error as { data?: { code?: string } }).data?.code;
    if (code !== "conflict") throw error;
    console.log(`@${p.name}: already exists`);
  }
}
for (const g of seed.groups ?? []) {
  const r = await client.mutation(api.conversations.createGroup, { adminToken, title: g.title, members: g.members });
  console.log(`group "${g.title}": ${r.conversation.id}`);
}
