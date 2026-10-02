// The `comms` CLI: what an agent runs from its shell to send, answer and read.
// Talks only to the local connector (or the stub) over the loopback socket.

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  CLI_EXIT,
  type ConversationSummary,
  DEFAULT_WAIT_MS,
  formatDuration,
  formatSchedule,
  MAX_POLL_WAIT_MS,
  MAX_WAIT_MS,
  type MessageEnvelope,
  type MessageStatus,
  parseAt,
  parseDuration,
  renderAnswerWithProof,
  type Op,
  PARTICIPANT_ENV,
  type RegistryEntry,
  type Reminder,
  type Wait,
  type Requests,
  type Responses,
  type SendResult,
} from "@agent-comms/protocol";
import { call, ConnectionLost, ConnectorUnreachable, resolveSocketPath } from "./client.ts";

/** The protocol's exit codes (capabilities.ts): `pending` and `endedWithoutAnswer` come with send-and-wait (R2). */
export const EXIT = CLI_EXIT;

export const USAGE = `usage:
  comms send  --as <me> @name "text"                         ask one participant (their DM) and wait for the answer
  comms send  --as <me> --conversation <id> [@name…] "text"  ask in a conversation; only @named members are woken
      --wait <duration>  how long to wait (default ${formatDuration(DEFAULT_WAIT_MS)}, at most ${formatDuration(MAX_WAIT_MS)}); --continue: don't wait
  comms await --as <me> <message-id>                         go back to waiting on a send (after exit 4, or from another shell)
  comms status --as <me> <message-id>                        each recipient's delivery and answer
  comms reply --as <me> <message-id> "text"                  answer a message (sets inReplyTo)
  comms read  --as <me> <conversation-id> [--before <seq>] [--limit <n>]
  comms list  --as <me>                                      my conversations
  comms remind --as <me> @agent "text" (--every <duration> | --at <time>) [--name <n>] [--idle-for <d>]
               [--watch @x] [--max <n>] [--report-to @x] [--expires <d>]   a reminder (--at: ISO 8601 or HH:MM)
  comms reminders --as <me>                                  reminders I created, or that target me
  comms reminder --as <me> <id>                              one, with its fires and skips
  comms reminder pause|resume|done|cancel --as <me> <id>     (creator, target, or the target's owner)
  comms reminder blocked --as <me> <id> "why"
  comms agents --as <me> [@name] [--long]                    the agent registry (one with its duties; --long adds homes)
  comms agents set --as <me> @me [--description "…"] [--duty "…"]…   set your registry entry
                                                             ("" clears the description; any --duty replaces the list)
  comms status                                               the connector and who is homed here

  Waiting: answers are printed as they arrive. Short asks: the default. People never
  answer like agents: a send to a person returns at once (it's in their inbox).
  - Claude Code: the Bash tool stops waiting after 120 s by default and moves the command
    to the background. For --wait over 100s, raise the Bash timeout above it (at most 600 s
    in the foreground). For long asks use --continue, or run comms send in the background.
  - Codex: a command has no time limit but hands back control after 10 s. Keep polling
    the shell session until comms exits, or the answer is printed where nobody reads it.
  An answer counts as seen only when your harness shows it reached you: in Claude Code, this
  command's own output in the same turn, in the foreground. Otherwise (a background run,
  T3 or Codex, --json, an answer over about 30,000 characters) it's also delivered into
  your thread about 2 minutes after the wait ends, marked as possibly already shown.

  @owner addresses your owner (the person who owns you); @reminders and @alerts can't be addressed.
  --as defaults to $${PARTICIPANT_ENV}. It names you; the connector accepts any
  participant homed on this machine (a trusted-machine shortcut, not proof of identity).
  Text may be given as several words, or "-" to read it from stdin. Text may start
  with "-"; anything after "--" is text, whatever it looks like.
  --json prints the connector's response as JSON. --socket <path> overrides the socket.
  --key <k>: the idempotency key for send/reply (default: a new one). If the connector
  answers unavailable or the connection drops, comms retries with the same key, then
  prints it; rerunning with that --key can't post twice.

exit codes: 0 ok (every awaited answer arrived), 1 the connector refused, 2 usage,
  3 connector unreachable, 4 the wait ended with answers still to come (they'll arrive in
  your thread), 5 a recipient's delivery ended without an answer (failed, uncertain, retired)`;

export interface Io {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

class UsageError extends Error {}
/** A keyed send or reply whose connection kept dropping; its key has been printed. Exits 3. */
class GaveUp extends Error {}

const OPTIONS = {
  as: { type: "string" },
  conversation: { type: "string" },
  before: { type: "string" },
  limit: { type: "string" },
  key: { type: "string" },
  json: { type: "boolean" },
  wait: { type: "string" },
  continue: { type: "boolean" },
  long: { type: "boolean" },
  every: { type: "string" },
  at: { type: "string" },
  name: { type: "string" },
  "idle-for": { type: "string" },
  watch: { type: "string" },
  max: { type: "string" },
  "report-to": { type: "string" },
  expires: { type: "string" },
  description: { type: "string" },
  duty: { type: "string", multiple: true },
  socket: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * Our options anywhere; anything else is message text, even if it starts with
 * "-" (a number, a list item). `--` ends options: everything after it is text (3.7).
 */
type OptionValue<O> = O extends { multiple: true } ? string[] : O extends { type: "string" } ? string : boolean;

function parseOptions(argv: string[]): { values: { [K in keyof typeof OPTIONS]?: OptionValue<(typeof OPTIONS)[K]> }; positionals: string[] } {
  const { tokens } = parseArgs({ args: argv, allowPositionals: true, strict: false, tokens: true, options: OPTIONS });
  const values: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  const unknownAt = new Set<number>();
  for (const t of tokens) {
    if (t.kind === "positional") positionals.push(t.value);
    else if (t.kind === "option") {
      const spec = (OPTIONS as Record<string, { type: "string" | "boolean"; multiple?: boolean }>)[t.name];
      if (!spec) {
        // Not one of ours: the whole argument is text (once, however it was split into short options).
        if (!unknownAt.has(t.index)) positionals.push(argv[t.index]!);
        unknownAt.add(t.index);
      } else if (spec.type === "string") {
        if (t.value === undefined) throw new Error(`option ${t.rawName} needs a value`);
        if (spec.multiple) values[t.name] = [...((values[t.name] as string[] | undefined) ?? []), t.value];
        else values[t.name] = t.value;
      } else values[t.name] = true;
    }
  }
  return { values: values as never, positionals };
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseOptions(argv);
  } catch (error) {
    io.stderr(`comms: ${(error as Error).message}\n${USAGE}\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    (values.help ? io.stdout : io.stderr)(USAGE + "\n");
    return values.help ? EXIT.ok : EXIT.usage;
  }

  try {
    const socket = resolveSocketPath(values.socket);
    const as = () => {
      const me = values.as ?? io.env[PARTICIPANT_ENV];
      if (!me) throw new UsageError(`say who you are with --as <name> (or set ${PARTICIPANT_ENV})`);
      return me;
    };
    const request = async <K extends Op>(
      op: K,
      body: Requests[K],
      options: { print?: boolean; onUnsupported?: () => void } = {},
    ): Promise<Responses[K] | null> => {
      // A send or reply carries an idempotency key, so retrying can't post twice (3.1). It's retried
      // after `unavailable` and, since fix pass 1.7, after a dropped connection (the connector may
      // have posted it and died before answering). Giving up prints the key: exit 3 if the
      // connector couldn't be reached, 1 if it said it was unavailable.
      const keyed = (body as { key?: string }).key;
      const attempt = async () => {
        try {
          return await call(socket, op, body);
        } catch (error) {
          if (keyed && error instanceof ConnectionLost) return error;
          throw error;
        }
      };
      let response = await attempt();
      for (const delayMs of keyed ? [2_000, 5_000] : []) {
        if (!(response instanceof ConnectionLost) && (response.ok || response.error.code !== "unavailable")) break;
        await new Promise((r) => setTimeout(r, delayMs));
        response = await attempt();
      }
      if (response instanceof ConnectionLost) {
        io.stderr(`comms ${command}: ${response.message}\nIt may or may not have been posted. Retry with the same key, which can't post twice: --key ${keyed}\n`);
        throw new GaveUp();
      }
      if (!response.ok && keyed && response.error.code === "unavailable") {
        io.stderr(`comms ${command}: unavailable: ${response.error.message}\nIt may or may not have been posted. Retry with the same key, which can't post twice: --key ${keyed}\n`);
        return null;
      }
      if (!response.ok && response.error.code === "unsupported" && options.onUnsupported) {
        options.onUnsupported();
        return null;
      }
      if (!response.ok) {
        io.stderr(`comms ${command}: ${response.error.code}: ${response.error.message}\n`);
        return null;
      }
      if (values.json && options.print !== false) io.stdout(JSON.stringify(response, null, 2) + "\n");
      return response;
    };
    const text = async (words: string[]) => {
      if (words.length === 1 && words[0] === "-") return (await io.readStdin()).replace(/\n$/, "");
      const joined = words.join(" ");
      if (!joined.trim()) throw new UsageError("no message text");
      return joined;
    };

    /**
     * Calls `await` until no result is open, printing each answer as it arrives and
     * acknowledging what was printed. Retries while the connector is restarting.
     */
    const awaitAnswers = async (me: string, initial: Wait): Promise<Wait> => {
      let wait = initial;
      const printed = new Set<string>();
      const graceUntil = () => wait.until + 30_000;
      const show = async () => {
        const fresh = wait.results.filter((x) => x.answer && !printed.has(x.recipient.name) && (x.state === "answered" || x.state === "acknowledged" || x.state === "fell-back"));
        if (fresh.length === 0) return;
        for (const x of fresh) {
          printed.add(x.recipient.name);
          if (!values.json) {
            const heading = `@${x.recipient.name} answered (${x.answer!.id}):`;
            // Fix pass 0.1: the markers let the harness confirm this output reached the model.
            io.stdout(
              (x.proofToken
                ? renderAnswerWithProof({ waitId: wait.id, messageId: x.answer!.id, token: x.proofToken }, heading, x.answer!.text)
                : `${heading}\n${x.answer!.text.split("\n").map((l) => `  ${l}`).join("\n")}`) + "\n",
            );
          }
        }
        if (values.json) return;
        const acked = await call(socket, "ack", { as: me, messageId: wait.messageId, recipients: fresh.map((x) => x.recipient.name) }).catch(() => null);
        if (acked?.ok) wait = acked.wait;
      };
      await show();
      while (wait.results.some((x) => x.state === "open") && Date.now() < graceUntil()) {
        let response;
        try {
          response = await call(socket, "await", { as: me, messageId: wait.messageId, waitMs: MAX_POLL_WAIT_MS });
        } catch (error) {
          if (!(error instanceof ConnectorUnreachable)) throw error;
          await new Promise((r) => setTimeout(r, 1_000));
          continue;
        }
        if (!response.ok) {
          if (response.error.code !== "unavailable") {
            io.stderr(`comms await: ${response.error.code}: ${response.error.message}\n`);
            break;
          }
          await new Promise((r) => setTimeout(r, 1_000));
          continue;
        }
        wait = response.wait;
        await show();
      }
      return wait;
    };

    /** With --json the answers are printed in the one object at the end; acknowledge them after printing. */
    const ackPrinted = async (me: string, wait: Wait): Promise<void> => {
      if (wait.results.some((x) => x.state === "answered")) await call(socket, "ack", { as: me, messageId: wait.messageId }).catch(() => null);
    };

    /** Reports what didn't come back, and picks the exit code. */
    const finish = (me: string, wait: Wait, waitMs: number): number => {
      const waiting = wait.results.filter((x) => x.state === "open" || x.state === "expired");
      const ended = wait.results.filter((x) => x.state === "ended");
      if (!values.json) {
        for (const x of ended) io.stdout(`@${x.recipient.name}: no answer (delivery ${x.delivery.state}${x.delivery.detail ? `: ${x.delivery.detail}` : ""})\n`);
        if (waiting.length > 0) {
          const who = waiting.map((x) => `@${x.recipient.name}`).join(", ");
          io.stdout(`no answer from ${who} within ${formatDuration(waitMs)}; it will arrive in your thread. Check with \`comms status ${wait.messageId} --as ${me}\`.\n`);
        }
      }
      return waiting.length > 0 ? EXIT.pending : ended.length > 0 ? EXIT.endedWithoutAnswer : EXIT.ok;
    };

    switch (command) {
      case "send": {
        const to: string[] = [];
        let i = 0;
        while (i < rest.length && rest[i]!.startsWith("@")) to.push(rest[i++]!.slice(1));
        if (!values.conversation && to.length !== 1) {
          throw new UsageError("address exactly one @name, or give --conversation <id>");
        }
        if (values.continue && values.wait) throw new UsageError("--continue and --wait don't go together");
        const waitMs = values.wait === undefined ? DEFAULT_WAIT_MS : parseDuration(values.wait);
        if (waitMs === null || waitMs < 1_000 || waitMs > MAX_WAIT_MS) {
          throw new UsageError(`--wait takes a duration like 90s, 9m or 1h, from 1s to ${formatDuration(MAX_WAIT_MS)}`);
        }
        const me = as();
        const body: Requests["send"] = {
          as: me,
          to,
          key: values.key ?? randomUUID(),
          text: await text(rest.slice(i)),
          ...(values.conversation ? { conversationId: values.conversation } : {}),
          ...(values.continue ? {} : { wait: true, waitMs }),
        };
        let unsupported = false;
        let r = await request("send", body, { print: !body.wait, onUnsupported: () => (unsupported = true) });
        if (unsupported) {
          // A connector that can't wait yet (an older one, or the stub) refuses before posting: send unwaited.
          const { wait: _wait, waitMs: _waitMs, ...unwaited } = body;
          r = await request("send", unwaited);
          if (!r) return EXIT.refused;
          io.stderr("comms send: this connector can't wait for answers (unsupported); sent without waiting.\n");
          if (!values.json) io.stdout(describeSend("sent", r));
          return EXIT.ok;
        }
        if (!r) return EXIT.refused;
        if (values.continue) {
          if (!values.json) io.stdout(describeSend("sent", r));
          return EXIT.ok;
        }
        if (!r.wait) {
          if (values.json) io.stdout(JSON.stringify({ ok: true, ...r }, null, 2) + "\n");
          else {
            io.stdout(describeSend("sent", r));
            if (r.noWait?.reason === "busy-waiting") {
              const who = (r.noWait.busy ?? []).map((n) => `@${n}`).join(", ");
              io.stdout(`${who} ${r.noWait.busy?.length === 1 ? "is" : "are"} waiting on another request, so this send didn't wait. Your message is queued; check with \`comms status ${r.message.id} --as ${me}\`.\n`);
            }
          }
          return EXIT.ok;
        }
        const m = r.message;
        if (!values.json) {
          io.stdout(`sent ${m.id} (#${m.seq} in ${m.conversationId}), waiting up to ${formatDuration(waitMs)} for ${r.wait.results.map((x) => `@${x.recipient.name}`).join(", ")}\n`);
          for (const p of r.wait.inInbox) io.stdout(`  → @${p.name}: in their inbox (people read in the web view)\n`);
        }
        const wait = await awaitAnswers(me, r.wait);
        if (values.json) {
          io.stdout(JSON.stringify({ ok: true, ...r, wait }, null, 2) + "\n");
          await ackPrinted(me, wait);
        }
        return finish(me, wait, waitMs);
      }
      case "reply": {
        const [messageId, ...words] = rest;
        if (!messageId) throw new UsageError("comms reply needs a message id");
        const r = await request("reply", { as: as(), messageId, key: values.key ?? randomUUID(), text: await text(words) });
        if (!r) return EXIT.refused;
        if (!values.json) {
          io.stdout(describeSend(`answered ${messageId} with`, r));
          if (r.completed) io.stdout(`completed delivery ${r.completed}\n`);
        }
        return EXIT.ok;
      }
      case "read": {
        const [conversationId, extra] = rest;
        if (!conversationId || extra) throw new UsageError("comms read needs exactly one conversation id");
        const body: Requests["read"] = {
          as: as(),
          conversationId,
          ...(values.before ? { before: integerOption("--before", values.before) } : {}),
          ...(values.limit ? { limit: integerOption("--limit", values.limit) } : {}),
        };
        const r = await request("read", body);
        if (!r) return EXIT.refused;
        if (!values.json) io.stdout(describeRead(r));
        return EXIT.ok;
      }
      case "list": {
        if (rest.length > 0) throw new UsageError("comms list takes no arguments");
        const me = as();
        const r = await request("list", { as: me });
        if (!r) return EXIT.refused;
        if (!values.json) io.stdout(describeList(me, r.conversations));
        return EXIT.ok;
      }
      case "await": {
        const [messageId, extra] = rest;
        if (!messageId || extra) throw new UsageError("comms await needs exactly one message id");
        const me = as();
        const first = await request("await", { as: me, messageId, waitMs: 0 }, { print: false });
        if (!first) return EXIT.refused;
        const wait = await awaitAnswers(me, first.wait);
        if (values.json) {
          io.stdout(JSON.stringify({ ok: true, wait }, null, 2) + "\n");
          await ackPrinted(me, wait);
        }
        return finish(me, wait, Math.max(0, wait.until - wait.createdAt));
      }
      case "remind": {
        const [target, ...words] = rest;
        if (!target?.startsWith("@")) throw new UsageError("comms remind needs an @agent first");
        if ((values.every === undefined) === (values.at === undefined)) throw new UsageError("give exactly one of --every and --at");
        const duration = (flag: string, value: string | undefined) => {
          if (value === undefined) return undefined;
          const ms = parseDuration(value);
          if (ms === null) throw new UsageError(`${flag} takes a duration like 90s, 30m, 2h or 7d`);
          return ms;
        };
        const atMs = values.at === undefined ? undefined : parseAt(values.at, Date.now());
        if (values.at !== undefined && atMs === null) throw new UsageError("--at takes ISO 8601 with a time (2026-10-02T09:00Z) or HH:MM");
        const handle = (flag: string, value: string | undefined) => {
          if (value === undefined) return undefined;
          if (!value.startsWith("@")) throw new UsageError(`${flag} takes an @name`);
          return value.slice(1);
        };
        const everyMs = duration("--every", values.every);
        const idleForMs = duration("--idle-for", values["idle-for"]);
        const expiresMs = duration("--expires", values.expires);
        const watch = handle("--watch", values.watch);
        const reportTo = handle("--report-to", values["report-to"]);
        const max = values.max === undefined ? undefined : integerOption("--max", values.max);
        const r = await request("remind", {
          as: as(),
          target: target.slice(1),
          text: await text(words),
          ...(everyMs !== undefined ? { everyMs } : {}),
          ...(atMs != null ? { at: atMs } : {}),
          ...(values.name !== undefined ? { name: values.name } : {}),
          ...(idleForMs !== undefined ? { idleForMs } : {}),
          ...(watch !== undefined ? { watch } : {}),
          ...(max !== undefined ? { max } : {}),
          ...(reportTo !== undefined ? { reportTo } : {}),
          ...(expiresMs !== undefined ? { expiresMs } : {}),
        });
        if (!r) return EXIT.refused;
        if (!values.json) io.stdout(describeNewReminder(r.reminder));
        return EXIT.ok;
      }
      case "reminders": {
        if (rest.length > 0) throw new UsageError("comms reminders takes no arguments");
        const r = await request("reminders", { as: as() });
        if (!r) return EXIT.refused;
        if (!values.json) io.stdout(r.reminders.length === 0 ? "no reminders\n" : r.reminders.map(describeReminderLine).join(""));
        return EXIT.ok;
      }
      case "reminder": {
        const actions = ["pause", "resume", "done", "cancel", "blocked"] as const;
        const action = actions.find((x) => x === rest[0]);
        if (!action) {
          const [id, extra] = rest;
          if (!id || extra) throw new UsageError("comms reminder needs exactly one reminder id");
          const r = await request("reminder", { as: as(), id });
          if (!r) return EXIT.refused;
          if (!values.json) io.stdout(describeReminderDetail(r));
          return EXIT.ok;
        }
        const [, id, ...why] = rest;
        if (!id) throw new UsageError(`comms reminder ${action} needs a reminder id`);
        if (action === "blocked" && why.join(" ").trim() === "") throw new UsageError('comms reminder blocked needs a reason: comms reminder blocked <id> "why"');
        if (action !== "blocked" && why.length > 0) throw new UsageError(`comms reminder ${action} takes only the id`);
        const r = await request("reminder-update", { as: as(), id, action, ...(action === "blocked" ? { reason: why.join(" ") } : {}) });
        if (!r) return EXIT.refused;
        if (!values.json) io.stdout(describeReminderLine(r.reminder));
        return EXIT.ok;
      }
      case "agents": {
        if (rest[0] === "set") {
          const [, target, extra] = rest;
          if (!target?.startsWith("@") || extra) throw new UsageError("comms agents set needs exactly one @name");
          if (values.description === undefined && values.duty === undefined) throw new UsageError("give --description and/or --duty");
          const r = await request("agents-set", {
            as: as(),
            name: target.slice(1),
            ...(values.description !== undefined ? { description: values.description } : {}),
            ...(values.duty !== undefined ? { duties: values.duty } : {}),
          });
          if (!r) return EXIT.refused;
          if (!values.json) io.stdout(describeAgent(r.agent, true));
          return EXIT.ok;
        }
        const [target, extra] = rest;
        if (extra || (target !== undefined && !target.startsWith("@"))) throw new UsageError("comms agents takes at most one @name");
        const r = await request("agents", {
          as: as(),
          ...(target ? { name: target.slice(1) } : {}),
          ...(values.long ? { long: true } : {}),
        });
        if (!r) return EXIT.refused;
        if (!values.json) io.stdout(r.agents.map((e) => describeAgent(e, target !== undefined)).join(""));
        return EXIT.ok;
      }
      case "status": {
        if (rest.length > 1) throw new UsageError("comms status takes at most one message id");
        if (rest[0]) {
          const s = await request("message-status", { as: as(), messageId: rest[0] });
          if (!s) return EXIT.refused;
          if (!values.json) io.stdout(describeStatus(s));
          return EXIT.ok;
        }
        const r = await request("status", {});
        if (!r) return EXIT.refused;
        if (!values.json) {
          io.stdout(`${r.implementation} on ${r.machine}, protocol v${r.protocol}\n`);
          for (const p of r.participants) {
            io.stdout(`  @${p.participant.name} (${p.participant.kind}, ${p.state}) ${p.home.harness}:${p.home.locator}\n`);
          }
        }
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`comms: ${error.message}\n${USAGE}\n`);
      return EXIT.usage;
    }
    if (error instanceof GaveUp) return EXIT.unreachable;
    if (error instanceof ConnectorUnreachable) {
      io.stderr(`comms: ${error.message}\n`);
      return EXIT.unreachable;
    }
    throw error;
  }
}

const clock = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function scheduleOf(r: Reminder): string {
  return formatSchedule(r.schedule);
}

function describeNewReminder(r: Reminder): string {
  const conditions = [
    r.idleForMs !== undefined ? `when @${(r.watch ?? r.target).name} has been idle ${formatDuration(r.idleForMs)}` : undefined,
    r.max !== undefined ? `at most ${r.max} time${r.max === 1 ? "" : "s"}` : undefined,
    r.reportTo ? `reports to @${r.reportTo.name}` : undefined,
    `expires ${clock(r.expiresAt)}`,
  ].filter(Boolean);
  return `reminder ${r.id} "${r.name}" for @${r.target.name}: ${scheduleOf(r)}, from ${r.nextFireAt !== undefined ? clock(r.nextFireAt) : "now"}; ${conditions.join("; ")}\n`;
}

function describeReminderLine(r: Reminder): string {
  const next = r.state === "active" && r.nextFireAt !== undefined ? `, next ${clock(r.nextFireAt)}` : "";
  const why = r.stateReason ? ` (${r.stateReason})` : "";
  const skip = r.lastSkip ? `; last skipped ${clock(r.lastSkip.at)}: ${r.lastSkip.reason}` : "";
  return `${r.id} ${r.state}${why} "${r.name}" → @${r.target.name} ${scheduleOf(r)}${next}; ${r.fires} fire${r.fires === 1 ? "" : "s"}${skip}\n`;
}

function describeReminderDetail(d: Responses["reminder"]): string {
  const r = d.reminder;
  const lines = [describeReminderLine(r).trimEnd(), `  text: ${r.text.split("\n")[0]}`, `  set by @${r.createdBy.name}; expires ${clock(r.expiresAt)}`];
  if (d.fires.length === 0) lines.push("  no fires yet");
  for (const f of d.fires) lines.push(`  fire ${clock(f.firedAt)}: ${f.deliveryState}${f.answer ? ` · answered: ${f.answer.text.split("\n")[0]!.slice(0, 200)}` : ""}`);
  for (const s of d.skips.slice(0, 10)) lines.push(`  skipped ${clock(s.at)}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`);
  return lines.join("\n") + "\n";
}

function describeStatus(s: MessageStatus): string {
  const m = s.message;
  const lines = [`${m.id} (#${m.seq} in ${s.conversation.id}) from @${m.sender.name}: ${m.text.split("\n")[0]!.slice(0, 120)}`];
  for (const r of s.recipients) {
    const state = r.delivery ? r.delivery.state : r.inbox ? (r.inbox.readAt ? "read" : "unread, in their inbox") : "not delivered";
    const answer = r.answer ? ` · answered: ${r.answer.text.split("\n")[0]!.slice(0, 200)}` : "";
    const more = r.followUps.length > 0 ? ` (+${r.followUps.length} follow-up${r.followUps.length === 1 ? "" : "s"})` : "";
    lines.push(`@${r.participant.name}: ${state}${r.delivery?.detail ? ` (${r.delivery.detail})` : ""}${answer}${more}`);
  }
  if (s.wait) {
    const answered = s.wait.results.filter((x) => x.state !== "open" && x.state !== "expired" && x.state !== "ended").length;
    lines.push(`wait: answered ${answered} of ${s.wait.results.length}, ${s.wait.active ? `until ${new Date(s.wait.until).toISOString().slice(11, 19)} UTC` : "ended"}`);
  }
  return lines.join("\n") + "\n";
}

/** One registry line; with `full`, the owner, duties and home below it. */
function describeAgent(e: RegistryEntry, full: boolean): string {
  const p = e.participant;
  const presence = e.presence
    ? e.presence.stale
      ? "presence unknown (connector not heard from)"
      : e.presence.status === "idle" && e.presence.idleSince !== undefined
        ? `idle for ${formatDuration(Math.max(60_000, Math.floor((Date.now() - e.presence.idleSince) / 60_000) * 60_000))}`
        : e.presence.status
    : undefined;
  const parts = [presence, e.harness].filter(Boolean).join(" · ");
  const lines = [`@${p.name} (${p.kind}, ${e.state})${parts ? ` ${parts}` : ""}${e.description ? ` — ${e.description}` : ""}`];
  if (full) {
    if (e.owner) lines.push(`  owner: @${e.owner.name}`);
    if (e.duties?.length) lines.push("  duties:", ...e.duties.map((d) => `  - ${d}`));
    if (e.home) lines.push(`  home: ${e.home.harness} ${e.home.locator} on ${e.home.machine}`);
  }
  return lines.join("\n") + "\n";
}

function integerOption(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} takes a positive integer`);
  return n;
}

function describeSend(verb: string, r: SendResult): string {
  const m = r.message;
  const lines = [`${verb} ${m.id} (#${m.seq} in ${m.conversationId})`];
  for (const d of r.deliveries) lines.push(`  → @${d.recipient}: delivery ${d.id} ${d.state}`);
  for (const s of r.skipped) lines.push(`  → @${s.name}: not delivered (${s.reason})`);
  const people = m.recipients.filter((p) => p.kind === "human" && !r.skipped.some((s) => s.name === p.name));
  for (const p of people) lines.push(`  → @${p.name}: in their inbox (people read in the web view)`);
  if (m.recipients.length === 0) lines.push("  (no one addressed; visible to members, wakes no one)");
  return lines.join("\n") + "\n";
}

function describeRead(r: Responses["read"]): string {
  const c = r.conversation;
  const first = r.messages[0];
  const range = first ? `#${first.seq}-#${r.messages.at(-1)!.seq}` : "nothing";
  const more = r.hasMore && first ? `; older: --before ${first.seq}` : "";
  const lines = [`${c.id} · ${conversationLabel(c)} · ${c.lastSeq} messages, showing ${range}${more}`];
  for (const m of r.messages) lines.push(...describeMessage(m));
  return lines.join("\n") + "\n";
}

function describeMessage(m: MessageEnvelope): string[] {
  const to = m.recipients.length > 0 ? ` → ${m.recipients.map((p) => `@${p.name}`).join(", ")}` : "";
  const answer = m.inReplyTo ? ` (answer to ${m.inReplyTo})` : "";
  const when = new Date(m.createdAt).toISOString().replace("T", " ").slice(0, 16);
  return [
    `#${m.seq} ${when} @${m.sender.name}${to}${answer} [${m.id}]`,
    ...m.text.split("\n").map((line) => `  ${line}`),
    ...m.attachments.map((a) => `  attachment: ${a.name} ${a.url}`),
  ];
}

function conversationLabel(c: ConversationSummary): string {
  const members = c.members.map((p) => `@${p.name}`).join(", ");
  return c.kind === "group" ? `group${c.title ? ` "${c.title}"` : ""} (${members})` : `dm (${members})`;
}

function describeList(me: string, conversations: ConversationSummary[]): string {
  if (conversations.length === 0) return `@${me} is in no conversations yet\n`;
  return (
    conversations
      .map((c) => {
        const label =
          c.kind === "dm"
            ? `dm with ${c.members.filter((p) => p.name !== me).map((p) => `@${p.name}`).join(", ")}`
            : `group${c.title ? ` "${c.title}"` : ""}, ${c.members.length} members`;
        return `${c.id}  ${label}  last #${c.lastSeq}, ${c.unread} unread`;
      })
      .join("\n") + "\n"
  );
}
