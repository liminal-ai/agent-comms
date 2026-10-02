// The term-a reminder check (W, mod 0.1.3): a reminder set by @lee for @term-a that fires
// once and reports to @term-a, so term-a sees a reminder fire (a request from @reminders)
// and then a notice (the report of its own answer). Usage:
//   node reminder-check.mjs create            → prints the reminder id
//   node reminder-check.mjs show <id>         → the reminder, its fires and skips (JSON)
//   node reminder-check.mjs status <messageId>
// The admin token is read from its file and never printed.
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const adminToken = readFileSync(`${process.env.HOME}/.config/agent-comms/admin-token`, "utf8").trim();
const client = new ConvexHttpClient("http://127.0.0.1:3240");
const [cmd, arg] = process.argv.slice(2);

if (cmd === "create") {
  const { reminder } = await client.mutation(anyApi.reminders.create, {
    adminToken,
    as: "lee",
    target: "term-a",
    text: "Fix pass 4 render check (Hazel, mod 0.1.5): reply with the single word PONG and nothing else. Use no tools.",
    everyMs: 60_000,
    max: 1,
    name: "fix-pass render check",
    reportTo: "lee",
    expiresMs: 30 * 60_000,
  });
  console.log(JSON.stringify(reminder, null, 2));
} else if (cmd === "show") {
  console.log(JSON.stringify(await client.query(anyApi.reminders.get, { adminToken, id: arg }), null, 2));
} else {
  console.error("usage: create | show <id>");
  process.exit(2);
}
