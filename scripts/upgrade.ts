#!/usr/bin/env node
// Runs directory.upgrade on a deployment after a deploy: creates the system
// participants and migrates owners (capabilities pass, R1). Idempotent. The
// admin token is read from a file and never printed.
//
//   node scripts/upgrade.ts --url http://127.0.0.1:3240 --admin-token-file <f> [--default-owner lee]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const { values } = parseArgs({
  options: { url: { type: "string" }, "admin-token-file": { type: "string" }, "default-owner": { type: "string" } },
});
if (!values.url || !values["admin-token-file"]) {
  console.error("usage: upgrade.ts --url <convex url> --admin-token-file <file> [--default-owner lee]");
  process.exit(2);
}
const expand = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));
const adminToken = readFileSync(expand(values["admin-token-file"]), "utf8").trim();
const client = new ConvexHttpClient(values.url);
const result = await client.mutation(api.directory.upgrade, { adminToken, defaultOwner: values["default-owner"] ?? "lee" });
console.log(JSON.stringify(result));
