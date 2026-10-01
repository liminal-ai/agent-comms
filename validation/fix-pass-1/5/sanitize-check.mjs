// Scans the committed journals for anything credential-like before they're committed: the machine
// secret, admin token or T3 bearer themselves, "secret"/"bearer"/"token" values, and ticketed URLs.
import { readFileSync } from "node:fs";
const OUT = new URL(".", import.meta.url).pathname;
const files = ["connector-service.journal.txt", "connector-test-units.journal.txt", "shared/connector-service.journal.txt"];
const secrets = ["lim-builder.secret", "admin-token", "t3-3780.token"].flatMap((f) => { try { return [readFileSync(`${process.env.HOME}/.config/agent-comms/${f}`, "utf8").trim()]; } catch { return []; } });
let bad = 0;
for (const f of files) {
  const text = readFileSync(`${OUT}${f}`, "utf8");
  const hits = [
    ...secrets.filter((s) => s && text.includes(s)).map(() => "a credential's value"),
    ...[...text.matchAll(/(secret|bearer|authorization|wsTicket)\s*[=:]\s*["']?[A-Za-z0-9._-]{8,}/gi)].map((m) => m[1]),
  ];
  console.log(`${f}: ${text.split("\n").length} lines, ${hits.length} credential-like hits`);
  bad += hits.length;
}
process.exit(bad ? 1 : 0);
