// Copies packages/protocol/src into hooks/protocol: a hooks module may import
// only files inside its plugin folder. `--check` fails if the copy is stale.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../../protocol/src");
const target = join(here, "../hooks/protocol");
const HEADER = "// Copied from packages/protocol/src by scripts/sync-protocol.ts. Do not edit.\n";

const files = readdirSync(source).filter((f) => f.endsWith(".ts")).sort();
const expected = new Map(files.map((f) => [f, HEADER + readFileSync(join(source, f), "utf8")]));

if (process.argv.includes("--check")) {
  const actual = readdirSync(target).filter((f) => f.endsWith(".ts")).sort();
  const stale = [...expected].filter(([f, text]) => {
    try {
      return readFileSync(join(target, f), "utf8") !== text;
    } catch {
      return true;
    }
  });
  const extra = actual.filter((f) => !expected.has(f));
  if (stale.length || extra.length) {
    console.error(`hooks/protocol is stale: ${[...stale.map(([f]) => f), ...extra].join(", ")}. Run: node scripts/sync-protocol.ts`);
    process.exit(1);
  }
  console.log("hooks/protocol matches packages/protocol/src");
} else {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const [f, text] of expected) writeFileSync(join(target, f), text);
  console.log(`copied ${files.length} files to hooks/protocol`);
}
