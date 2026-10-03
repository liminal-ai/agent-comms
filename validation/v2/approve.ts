// The live kit's approval rule (standing rule, docs/deploy-checklist.md): a synthetic test
// agent's command is approved only if it is a single invocation of the scratch comms CLI
// (its wrapper pins the scratch socket) as that agent's own test identity, with any message
// text. Anything with shell operators or substitutions, or that isn't that CLI, is declined.
// Pure, so it's unit-tested (approve.test.ts).

export const SCRATCH_COMMS = "/srv/agents/cedar/tmp/v2/comms";
export const TEST_IDENTITIES = ["v2ann", "v2bob", "v2cat"] as const;
const SUBCOMMANDS = new Set(["send", "reply", "await", "status", "read", "list", "agents"]);

/**
 * Splits a command into shell words, the way bash would, refusing only what the shell would
 * act on: operators and substitutions outside quotes, and substitutions or named variables
 * inside double quotes (the shell still runs `$(…)` and backticks there, and `"$TOKEN"` would
 * put an environment variable into the message). Inside single quotes everything is literal;
 * inside double quotes operators are literal text (`"a > b"`, `"x; y"`), and `$` followed by a
 * digit is a positional parameter, empty in the agent's shell (`"costs $5"` becomes "costs ").
 */
export function words(input: string): string[] | { refused: string } {
  const out: string[] = [];
  let word: string | null = null;
  const add = (t: string) => (word = (word ?? "") + t);
  let i = 0;
  const at = (k: number) => input[k] ?? "";
  while (i < input.length) {
    const c = at(i);
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return { refused: "unterminated single quote" };
      add(input.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let k = i + 1;
      let text = "";
      for (;;) {
        if (k >= input.length) return { refused: "unterminated double quote" };
        const d = at(k);
        if (d === '"') break;
        if (d === "\\" && "$`\"\\\n".includes(at(k + 1))) {
          text += at(k + 1);
          k += 2;
          continue;
        }
        if (d === "`") return { refused: "command substitution (backtick) in double quotes" };
        if (d === "$") {
          const n = at(k + 1);
          if (/[0-9]/.test(n)) {
            k += 2; // a positional parameter: empty
            continue;
          }
          if (/[A-Za-z_{(@*#?$!-]/.test(n)) return { refused: `expansion ($${n}) in double quotes` };
        }
        text += d;
        k++;
      }
      add(text);
      i = k + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= input.length) return { refused: "trailing backslash" };
      if (at(i + 1) !== "\n") add(at(i + 1)); // an escaped newline joins lines
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      if (word !== null) out.push(word);
      word = null;
      i++;
      continue;
    }
    if (c === "$" || c === "`") return { refused: `substitution (${c}) outside quotes` };
    if (";&|<>()\n#{}*?[]~!".includes(c)) return { refused: `shell operator (${JSON.stringify(c)}) outside quotes` };
    add(c);
    i++;
  }
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
