// The `comms` CLI: what an agent runs from its shell to send, answer and read.
// Talks only to the local connector (or the stub) over the loopback socket.

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  CLI_EXIT,
  type ConversationSummary,
  formatDuration,
  type MessageEnvelope,
  type Op,
  PARTICIPANT_ENV,
  type RegistryEntry,
  type Requests,
  type Responses,
  type SendResult,
} from "@agent-comms/protocol";
import { call, ConnectorUnreachable, resolveSocketPath } from "./client.ts";

/** The protocol's exit codes (capabilities.ts): `pending` and `endedWithoutAnswer` come with send-and-wait (R2). */
export const EXIT = CLI_EXIT;

export const USAGE = `usage:
  comms send  --as <me> @name "text"                         request to one participant (their DM)
  comms send  --as <me> --conversation <id> [@name…] "text"  request in a conversation; only @named members are woken
  comms reply --as <me> <message-id> "text"                  answer a message (sets inReplyTo)
  comms read  --as <me> <conversation-id> [--before <seq>] [--limit <n>]
  comms list  --as <me>                                      my conversations
  comms agents --as <me> [@name] [--long]                    the agent registry (one with its duties; --long adds homes)
  comms agents set --as <me> @me [--description "…"] [--duty "…"]…   set your registry entry
                                                             ("" clears the description; any --duty replaces the list)
  comms status                                               the connector and who is homed here

  @owner addresses your owner (the person who owns you); @reminders and @alerts can't be addressed.
  --as defaults to $${PARTICIPANT_ENV}. It names you; the connector accepts any
  participant homed on this machine (a trusted-machine shortcut, not proof of identity).
  Text may be given as several words, or "-" to read it from stdin. Text may start
  with "-"; anything after "--" is text, whatever it looks like.
  --json prints the connector's response as JSON. --socket <path> overrides the socket.
  --key <k>: the idempotency key for send/reply (default: a new one). If the connector
  answers unavailable, comms retries with the same key, then prints it; rerunning with
  that --key can't post twice.

exit codes: 0 ok, 1 the connector refused, 2 usage, 3 connector unreachable`;

export interface Io {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

class UsageError extends Error {}

const OPTIONS = {
  as: { type: "string" },
  conversation: { type: "string" },
  before: { type: "string" },
  limit: { type: "string" },
  key: { type: "string" },
  json: { type: "boolean" },
  long: { type: "boolean" },
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
    const request = async <K extends Op>(op: K, body: Requests[K]): Promise<Responses[K] | null> => {
      let response = await call(socket, op, body);
      // A send or reply carries an idempotency key, so retrying after `unavailable` can't post twice (3.1).
      const keyed = (body as { key?: string }).key;
      for (const delayMs of keyed ? [2_000, 5_000] : []) {
        if (response.ok || response.error.code !== "unavailable") break;
        await new Promise((r) => setTimeout(r, delayMs));
        response = await call(socket, op, body);
      }
      if (!response.ok && keyed && response.error.code === "unavailable") {
        io.stderr(`comms ${command}: unavailable: ${response.error.message}\nIt may or may not have been posted. Retry with the same key, which can't post twice: --key ${keyed}\n`);
        return null;
      }
      if (!response.ok) {
        io.stderr(`comms ${command}: ${response.error.code}: ${response.error.message}\n`);
        return null;
      }
      if (values.json) io.stdout(JSON.stringify(response, null, 2) + "\n");
      return response;
    };
    const text = async (words: string[]) => {
      if (words.length === 1 && words[0] === "-") return (await io.readStdin()).replace(/\n$/, "");
      const joined = words.join(" ");
      if (!joined.trim()) throw new UsageError("no message text");
      return joined;
    };

    switch (command) {
      case "send": {
        const to: string[] = [];
        let i = 0;
        while (i < rest.length && rest[i]!.startsWith("@")) to.push(rest[i++]!.slice(1));
        if (!values.conversation && to.length !== 1) {
          throw new UsageError("address exactly one @name, or give --conversation <id>");
        }
        const body: Requests["send"] = {
          as: as(),
          to,
          key: values.key ?? randomUUID(),
          text: await text(rest.slice(i)),
          ...(values.conversation ? { conversationId: values.conversation } : {}),
        };
        const r = await request("send", body);
        if (!r) return EXIT.refused;
        if (!values.json) io.stdout(describeSend("sent", r));
        return EXIT.ok;
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
    if (error instanceof ConnectorUnreachable) {
      io.stderr(`comms: ${error.message}\n`);
      return EXIT.unreachable;
    }
    throw error;
  }
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
  if (r.deliveries.length === 0 && r.skipped.length === 0) lines.push("  (no one addressed; visible to members, wakes no one)");
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
