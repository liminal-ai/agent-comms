// The live kit's approval rule (standing rule, docs/deploy-checklist.md): a synthetic test
// agent's command is approved only if it is a single invocation of the scratch comms CLI
// (its wrapper pins the scratch socket) as that agent's own test identity, with any message
// text. Anything with shell operators or substitutions, or that isn't that CLI, is declined.
// Pure, so it's unit-tested (approve.test.ts).

export const SCRATCH_COMMS = "/srv/agents/cedar/tmp/v2/comms";
export const TEST_IDENTITIES = ["v2ann", "v2bob", "v2cat"] as const;
const SUBCOMMANDS = new Set(["send", "reply", "await", "status", "read", "list", "agents"]);

/** Splits a command into words like a POSIX shell, refusing anything but plain words and quotes. */
export function words(input: string): string[] | { refused: string } {
  const out: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    // Substitutions are refused everywhere, quoted or not ($ expands inside double quotes too).
    if (c === "`" || c === "$") return { refused: `substitution (${c})` };
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\") return { refused: "escape inside double quotes" };
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
      continue;
    }
    if (c === " " || c === "\t") {
      if (word !== null) out.push(word);
      word = null;
      continue;
    }
    if (";&|<>()\n\\#{}*?[]~!".includes(c)) return { refused: `shell operator (${JSON.stringify(c)})` };
    word = (word ?? "") + c;
  }
  if (quote) return { refused: "unterminated quote" };
  if (word !== null) out.push(word);
  return out;
}

export function judge(input: string | null, identity: string): { approve: boolean; why: string } {
  if (input === null) return { approve: false, why: "no single open command to match the request" };
  if (!(TEST_IDENTITIES as readonly string[]).includes(identity)) return { approve: false, why: `not a test identity: ${identity}` };
  const argv = words(input.trim());
  if (!Array.isArray(argv)) return { approve: false, why: argv.refused };
  if (argv[0] !== SCRATCH_COMMS) return { approve: false, why: "not the scratch comms CLI" };
  if (!SUBCOMMANDS.has(argv[1] ?? "")) return { approve: false, why: `comms ${argv[1] ?? ""} isn't allowed` };
  if (argv.some((a) => a.startsWith("--socket"))) return { approve: false, why: "--socket overrides the scratch socket" };
  if (argv.some((a) => a.startsWith("--as="))) return { approve: false, why: "--as= form" };
  const as = argv.flatMap((a, i) => (a === "--as" ? [argv[i + 1]] : []));
  if (as.length !== 1 || as[0] !== identity) return { approve: false, why: `--as must be the agent's own identity (@${identity})` };
  return { approve: true, why: "one scratch comms invocation as the agent itself" };
}
