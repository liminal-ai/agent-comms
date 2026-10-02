// Copied from packages/protocol/src by scripts/sync-protocol.ts. Do not edit.
// Proof that an agent saw an answer (fix pass 0.1). The waiting CLI prints each answer
// between a begin line and an end line that carry the wait id, the answer's message id
// and a secret token only the waiting CLI is given. A harness (the mod, the T3 adapter)
// that finds both lines, complete, in a tool result of the main turn that ran the CLI
// reports them with `answer-seen`; only that makes the result `acknowledged`.

export interface AnswerProof {
  waitId: string;
  messageId: string;
  /** Random, per answered result; returned only to the waiter's `await` and `send`, never by `message-status` or the web. */
  token: string;
}

export const PROOF_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

const BEGIN = /^\[agent-comms proof v1 begin wait=([A-Za-z0-9_-]{1,128}) message=([A-Za-z0-9_-]{1,128}) token=([0-9a-f]{32})\]$/;
const END = /^\[agent-comms proof v1 end wait=([A-Za-z0-9_-]{1,128}) message=([A-Za-z0-9_-]{1,128}) token=([0-9a-f]{32}) chars=(\d{1,9})\]$/;

export function renderProofBegin(p: AnswerProof): string {
  return `[agent-comms proof v1 begin wait=${p.waitId} message=${p.messageId} token=${p.token}]`;
}

export function renderProofEnd(p: AnswerProof, chars: number): string {
  return `[agent-comms proof v1 end wait=${p.waitId} message=${p.messageId} token=${p.token} chars=${chars}]`;
}

/**
 * The CLI's printing of one answer: the heading, the begin line, the answer with every
 * line indented by two spaces (so no answer line can be a marker), and the end line with
 * the length of the indented answer (lines joined by "\n"), so output cut in the middle
 * doesn't count.
 */
export function renderAnswerWithProof(p: AnswerProof, heading: string, text: string): string {
  const body = text.split("\n").map((line) => `  ${line}`).join("\n");
  return [heading, renderProofBegin(p), body, renderProofEnd(p, body.length)].join("\n");
}

/**
 * `chars` counts JavaScript string length (UTF-16 code units), as the CLI, the mod and the
 * connector all do; a parser in another language must count the same way.
 *
 * Every complete proof in a tool result: a begin line, then an end line with the same
 * wait, message and token, both whole lines at column 0, with exactly `chars` characters
 * between them. Lines are split on "\n"; a trailing "\r" is dropped from each.
 */
export function findAnswerProofs(output: string): AnswerProof[] {
  const lines = output.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const found: AnswerProof[] = [];
  for (let i = 0; i < lines.length; i++) {
    const b = BEGIN.exec(lines[i]!);
    if (!b) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const e = END.exec(lines[j]!);
      if (!e || e[1] !== b[1] || e[2] !== b[2] || e[3] !== b[3]) continue;
      if (lines.slice(i + 1, j).join("\n").length === Number(e[4])) {
        found.push({ waitId: b[1]!, messageId: b[2]!, token: b[3]! });
        i = j;
      }
      break;
    }
  }
  return found;
}
