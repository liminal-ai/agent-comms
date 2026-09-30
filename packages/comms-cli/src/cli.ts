// The `comms` CLI: what an agent runs from its shell to send, answer and read.
// Talks only to the local connector (or the stub) over the loopback socket.

import { parseArgs } from "node:util";
import {
  type ConversationSummary,
  type MessageEnvelope,
  type Op,
  PARTICIPANT_ENV,
  type Requests,
  type Responses,
  type SendResult,
} from "@agent-comms/protocol";
import { call, ConnectorUnreachable, resolveSocketPath } from "./client.ts";

export const EXIT = { ok: 0, error: 1, usage: 2, unreachable: 3 } as const;

export const USAGE = `usage:
  comms send  --as <me> @name "text"                         request to one participant (their DM)
  comms send  --as <me> --conversation <id> [@name…] "text"  request in a conversation; only @named members are woken
  comms reply --as <me> <message-id> "text"                  answer a message (sets inReplyTo)
  comms read  --as <me> <conversation-id> [--before <seq>] [--limit <n>]
  comms list  --as <me>                                      my conversations
  comms status                                               the connector and who is homed here

  --as defaults to $${PARTICIPANT_ENV}. It names you; the connector accepts any
  participant homed on this machine (a trusted-machine shortcut, not proof of identity).
  Text may be given as several words, or "-" to read it from stdin.
  --json prints the connector's response as JSON. --socket <path> overrides the socket.

exit codes: 0 ok, 1 the connector refused, 2 usage, 3 connector unreachable`;

export interface Io {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

class UsageError extends Error {}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        as: { type: "string" },
        conversation: { type: "string" },
        before: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
        socket: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
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
      const response = await call(socket, op, body);
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
          text: await text(rest.slice(i)),
          ...(values.conversation ? { conversationId: values.conversation } : {}),
        };
        const r = await request("send", body);
        if (!r) return EXIT.error;
        if (!values.json) io.stdout(describeSend("sent", r));
        return EXIT.ok;
      }
      case "reply": {
        const [messageId, ...words] = rest;
        if (!messageId) throw new UsageError("comms reply needs a message id");
        const r = await request("reply", { as: as(), messageId, text: await text(words) });
        if (!r) return EXIT.error;
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
        if (!r) return EXIT.error;
        if (!values.json) io.stdout(describeRead(r));
        return EXIT.ok;
      }
      case "list": {
        if (rest.length > 0) throw new UsageError("comms list takes no arguments");
        const me = as();
        const r = await request("list", { as: me });
        if (!r) return EXIT.error;
        if (!values.json) io.stdout(describeList(me, r.conversations));
        return EXIT.ok;
      }
      case "status": {
        const r = await request("status", {});
        if (!r) return EXIT.error;
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
