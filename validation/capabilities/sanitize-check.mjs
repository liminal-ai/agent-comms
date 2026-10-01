// Scans evidence files (given as arguments) for anything credential-like before they're committed:
// this machine's real secret, admin token or T3 bearer, and "secret"/"bearer"/"token" values.
// Test fixtures' made-up secrets (e.g. "m1-secret-0123456789") are reported too; check them by eye.
import { readFileSync } from "node:fs";
const secrets = ["lim-builder.secret", "admin-token", "t3-3780.token"].flatMap((f) => {
  try {
    return [readFileSync(`${process.env.HOME}/.config/agent-comms/${f}`, "utf8").trim()];
  } catch {
    return [];
  }
});
let bad = 0;
for (const f of process.argv.slice(2)) {
  const text = readFileSync(f, "utf8");
  const real = secrets.filter((s) => s && text.includes(s)).length;
  const shaped = [...text.matchAll(/(secret|bearer|authorization|wsTicket)\s*[=:]\s*["']?[A-Za-z0-9._-]{8,}/gi)].length;
  console.log(`${f}: ${text.split("\n").length} lines, ${real} real credential values, ${shaped} credential-shaped`);
  bad += real;
}
process.exit(bad > 0 ? 1 : 0);
