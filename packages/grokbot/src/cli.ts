// The grokbot CLI: Grok Bot's side of the bridge. `run` is the daemon; the
// other commands read the inbox and hand answers to the daemon through the
// outbox, so only the daemon ever talks to the connector about deliveries.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CLI_EXIT, parseDuration } from "@agent-comms/protocol";
import { socketClient } from "./client.ts";
import { ConfigError, type GrokbotConfig, loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { commsReplyHint, planAck, planAnswer } from "./items.ts";
import { lockOwner } from "./lock.ts";
import { type Command, type CommandResult, DONE_STATES, type InboxItem, isDeliveryId, isSettled, Store } from "./store.ts";

export const EXIT = CLI_EXIT;

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
}

export const USAGE = `usage: grokbot <command> [options]

Commands:
  run                          run the bridge daemon in the foreground
  inbox [--all] [--json] [--limit <n>] [--skip <n>]
                               list pending items, oldest first (--all: done ones too);
                               20 at a time (at most 100), with a one-line preview each
  show <delivery-id> [--json]  a delivery as Grok Bot should read it, and how to answer it
  answer <delivery-id> <text…> answer a request (text from --file <f>, or - for stdin)
  ack <delivery-id>            mark an answer or notice read, or close a timed-out request
  status [--json]              the daemon, its session and the connector
  config                       print the resolved configuration

Options:
  --config <file>        default: $GROKBOT_CONFIG, else <home>/config.json if present
  --home <dir>           default: $GROKBOT_HOME, else ~/.grok-comms
  --socket <path>        default: $AGENT_COMMS_SOCKET, else the per-user path
  --participant <name>   default: $GROKBOT_PARTICIPANT, else "grok"
  --wait <dur>           answer/ack: how long to wait for the daemon (default 15s)
  --no-wait              answer/ack: queue it and return

Exit codes: 0 done, 1 refused, 2 usage, 4 queued but not confirmed yet.`;

function storeFor(config: GrokbotConfig): Store {
  return new Store({ inboxDir: config.inboxDir, outboxDir: config.outboxDir, logFile: config.logFile, stateFile: config.stateFile });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function localTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const INBOX_PAGE = 20;
const INBOX_MAX_PAGE = 100;
const PREVIEW_CHARS = 160;

function firstLine(text: string, max = 100): string {
  const line = text.split(/\r\n|[\n\r\u2028\u2029]/).find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function conversationLabel(item: InboxItem): string {
  const c = item.conversation;
  return c.kind === "dm" ? `DM ${c.id}` : `${c.id}${c.title ? ` "${c.title}"` : ""}`;
}

/** What Grok Bot should do next with an item. */
export function nextStep(item: InboxItem): string {
  switch (item.state) {
    case "awaiting-answer":
      return `grokbot answer ${item.deliveryId} "<your answer>"   (sent back to @${item.from.name} as the reply)`;
    case "timed-out":
    case "reply-failed":
      return `grokbot answer ${item.deliveryId} "<your answer>"   (posted with comms reply; or run ${commsReplyHint(item)} and then grokbot ack ${item.deliveryId})`;
    case "unread":
      return `grokbot ack ${item.deliveryId}   (no reply expected)`;
    case "answered":
    case "late-reply-queued":
      return "nothing: the daemon is sending the answer";
    default:
      return `nothing (${item.state}); for a follow-up use ${commsReplyHint(item)}`;
  }
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        home: { type: "string" },
        socket: { type: "string" },
        participant: { type: "string" },
        all: { type: "boolean" },
        limit: { type: "string" },
        skip: { type: "string" },
        json: { type: "boolean" },
        file: { type: "string" },
        wait: { type: "string" },
        "no-wait": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    io.stderr(`grokbot: ${(error as Error).message}\n${USAGE}\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command || command === "help") {
    io.stdout(`${USAGE}\n`);
    return command || values.help ? EXIT.ok : EXIT.usage;
  }

  let config: GrokbotConfig;
  try {
    config = loadConfig(io.env, {
      ...(values.config ? { config: values.config } : {}),
      ...(values.home ? { home: values.home } : {}),
      ...(values.socket ? { socket: values.socket } : {}),
      ...(values.participant ? { participant: values.participant } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`grokbot: ${error.message}\n`);
      return EXIT.usage;
    }
    throw error;
  }
  const store = storeFor(config);

  switch (command) {
    case "run":
    case "daemon":
      return runDaemon(config, { log: (line) => io.stderr(`${new Date().toISOString()} grokbot: ${line}\n`) });

    case "config":
      io.stdout(`${JSON.stringify(config, null, 2)}\n`);
      return EXIT.ok;

    case "inbox": {
      const limit = values.limit === undefined ? INBOX_PAGE : Number(values.limit);
      const skip = values.skip === undefined ? 0 : Number(values.skip);
      if (!Number.isInteger(limit) || limit < 1 || limit > INBOX_MAX_PAGE || !Number.isInteger(skip) || skip < 0) {
        io.stderr(`grokbot: --limit is 1-${INBOX_MAX_PAGE} and --skip is 0 or more\n`);
        return EXIT.usage;
      }
      const all = await store.list({ all: values.all === true });
      const items = all.slice(skip, skip + limit);
      const more = all.length - skip - items.length;
      // Full text and answers are read with `show`; the listing stays small however long the backlog.
      if (values.json) {
        const summaries = items.map((item) => {
          const { delivery, rendered, events, text, answer, notice, ...summary } = item;
          return { ...summary, preview: firstLine(text, PREVIEW_CHARS), file: store.pathOf(item) };
        });
        io.stdout(`${JSON.stringify({ total: all.length, skip, items: summaries, more: Math.max(0, more) }, null, 2)}\n`);
        return EXIT.ok;
      }
      if (all.length === 0) {
        io.stdout(values.all ? "the inbox is empty\n" : "nothing pending\n");
        return EXIT.ok;
      }
      for (const item of items) {
        const done = isSettled(item) ? "done   " : "PENDING";
        const due = item.state === "awaiting-answer" ? `  due ${localTime(item.deadlineAt)}` : "";
        io.stdout(
          `${done} ${item.deliveryId}  ${item.kind}  ${item.state}  from @${item.from.name}  ${conversationLabel(item)}  received ${localTime(item.receivedAt)}${due}\n` +
            `        ${firstLine(item.text, PREVIEW_CHARS)}\n`,
        );
      }
      if (more > 0) io.stdout(`${more} more: grokbot inbox${values.all ? " --all" : ""} --skip ${skip + items.length}\n`);
      return EXIT.ok;
    }

    case "show": {
      const id = rest[0];
      if (!id || rest.length > 1) {
        io.stderr("usage: grokbot show <delivery-id> [--json]\n");
        return EXIT.usage;
      }
      const item = await store.get(id);
      if (!item) {
        io.stderr(`grokbot: no delivery ${id} in ${config.inboxDir}\n`);
        return EXIT.refused;
      }
      if (values.json) {
        io.stdout(`${JSON.stringify({ ...item, file: store.pathOf(item), next: nextStep(item) }, null, 2)}\n`);
        return EXIT.ok;
      }
      const lines = [
        `delivery ${item.deliveryId} (message ${item.messageId}): ${item.kind} from @${item.from.name}, ${item.state}`,
        `conversation: ${conversationLabel(item)}`,
        `received: ${localTime(item.receivedAt)}${item.deadlineAt && item.state === "awaiting-answer" ? `; answer due ${localTime(item.deadlineAt)}` : ""}`,
        `file: ${store.pathOf(item)}`,
        ...(item.lastError ? [`last error: ${item.lastError}`] : []),
        ...(item.answer ? [`your answer${item.answerMessageId ? ` (message ${item.answerMessageId})` : ""}:`, ...item.answer.split("\n").map((l) => `  ${l}`)] : []),
        "",
        item.rendered,
        ...(item.notice && (item.state === "timed-out" || item.state === "reply-failed") ? ["", item.notice] : []),
        "",
        `Next: ${nextStep(item)}`,
      ];
      io.stdout(`${lines.join("\n")}\n`);
      return EXIT.ok;
    }

    case "answer":
    case "ack": {
      const id = rest[0];
      if (!id || !isDeliveryId(id)) {
        io.stderr(`usage: grokbot ${command} <delivery-id>${command === "answer" ? " <text…> | --file <f> | -" : ""}\n`);
        return EXIT.usage;
      }
      let text: string | undefined;
      if (command === "answer") {
        const words = rest.slice(1);
        if (values.file) text = await readFile(values.file, "utf8");
        else if (words.length === 1 && words[0] === "-") text = await io.readStdin();
        else text = words.join(" ");
        if (!text.trim()) {
          io.stderr("grokbot answer: give the answer as arguments, --file <f>, or - for stdin\n");
          return EXIT.usage;
        }
      } else if (rest.length > 1) {
        io.stderr("usage: grokbot ack <delivery-id>\n");
        return EXIT.usage;
      }
      const waitMs = values["no-wait"] ? 0 : values.wait ? parseDuration(values.wait) : 15_000;
      if (waitMs === null) {
        io.stderr(`grokbot: --wait takes <n>s|m|h, got "${values.wait}"\n`);
        return EXIT.usage;
      }
      const item = await store.get(id);
      if (!item) {
        io.stderr(`grokbot: no delivery ${id} in ${config.inboxDir}\n`);
        return EXIT.refused;
      }
      const plan = command === "answer" ? planAnswer(item, text!) : planAck(item);
      if (!plan.ok) {
        io.stderr(`grokbot ${command}: ${plan.message}\n`);
        return EXIT.refused;
      }
      const cmd: Command = { id: randomUUID(), action: command, deliveryId: id, ...(text !== undefined ? { text } : {}), at: new Date().toISOString() };
      await store.writeCommand(cmd);
      const daemon = await lockOwner(config.lockFile);
      if (daemon === null) {
        io.stdout(`queued ${command} for ${id}: no grokbot daemon is running; it's applied when the daemon starts\n`);
        return EXIT.pending;
      }
      if (waitMs === 0) {
        io.stdout(`queued ${command} for ${id}\n`);
        return EXIT.ok;
      }
      return awaitCommand(store, cmd, waitMs, io);
    }

    case "status": {
      const daemon = await lockOwner(config.lockFile);
      const status = await readFile(join(config.home, "status.json"), "utf8").then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null);
      const pending = await store.list();
      let connector: unknown;
      try {
        const res = await socketClient(config.socket).call("status", {}, { timeoutMs: 3_000 });
        connector = res.ok ? { reachable: true, implementation: res.implementation, machine: res.machine } : { reachable: true, error: res.error };
      } catch (error) {
        connector = { reachable: false, error: (error as Error).message };
      }
      const report = {
        participant: config.participant,
        socket: config.socket,
        home: config.home,
        daemon: daemon !== null ? { running: true, pid: daemon } : { running: false },
        session: status,
        connector,
        inbox: {
          pending: pending.length,
          awaitingAnswer: pending.filter((i) => i.state === "awaiting-answer").length,
          timedOut: pending.filter((i) => i.state === "timed-out" || i.state === "reply-failed").length,
          unread: pending.filter((i) => i.state === "unread").length,
        },
      };
      if (values.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      else {
        const c = connector as { reachable: boolean; implementation?: string; machine?: string; error?: unknown };
        io.stdout(
          [
            `participant: @${config.participant}`,
            `daemon: ${daemon !== null ? `running (pid ${daemon})` : "not running"}${status ? `, session ${String(status.sessionId)}, ${status.registered ? "registered" : "not registered"}` : ""}`,
            `connector: ${c.reachable ? (c.implementation ? `${c.implementation} on ${c.machine}` : `answered ${JSON.stringify(c.error)}`) : `unreachable (${String(c.error)})`} at ${config.socket}`,
            `inbox: ${report.inbox.pending} pending (${report.inbox.awaitingAnswer} awaiting an answer, ${report.inbox.timedOut} timed out, ${report.inbox.unread} unread) in ${config.inboxDir}`,
            ...(status?.lastError ? [`last error: ${String(status.lastError)}`] : []),
          ].join("\n") + "\n",
        );
      }
      return EXIT.ok;
    }

    default:
      io.stderr(`grokbot: unknown command "${command}"\n${USAGE}\n`);
      return EXIT.usage;
  }
}

async function awaitCommand(store: Store, cmd: Command, waitMs: number, io: CliIo): Promise<number> {
  const until = Date.now() + waitMs;
  let result: CommandResult | null = null;
  while (Date.now() < until) {
    result = await store.readResult(cmd.id);
    if (result) break;
    await sleep(150);
  }
  if (!result) {
    io.stdout(`queued ${cmd.action} for ${cmd.deliveryId}; the daemon hasn't picked it up yet\n`);
    return EXIT.pending;
  }
  await store.removeResult(cmd.id);
  if (!result.ok) {
    io.stderr(`grokbot ${cmd.action}: ${result.message}\n`);
    return EXIT.refused;
  }
  if (cmd.action === "ack") {
    io.stdout(`${cmd.deliveryId}: ${result.state ?? "acknowledged"}${result.message && result.message !== "marked read" ? ` (${result.message})` : ""}\n`);
    return EXIT.ok;
  }
  // Wait for the daemon to report it.
  let item = await store.get(cmd.deliveryId);
  while (item && !DONE_STATES.has(item.state) && item.state !== "reply-failed" && Date.now() < until) {
    await sleep(150);
    item = await store.get(cmd.deliveryId);
  }
  if (!item) {
    io.stderr(`grokbot answer: ${cmd.deliveryId} disappeared from the inbox\n`);
    return EXIT.refused;
  }
  switch (item.state) {
    case "replied":
      io.stdout(`answered ${item.deliveryId}: collected as the reply to @${item.from.name}${item.answerMessageId ? ` (message ${item.answerMessageId})` : ""}\n`);
      return EXIT.ok;
    case "replied-late":
      io.stdout(`answered ${item.deliveryId} late: posted with comms reply${item.answerMessageId ? ` (message ${item.answerMessageId})` : ""}\n`);
      return EXIT.ok;
    case "reply-failed":
      io.stderr(`grokbot answer: ${item.lastError ?? "the reply was refused"}\n`);
      return EXIT.refused;
    default:
      io.stdout(`accepted the answer for ${item.deliveryId} (${item.state}); the daemon is still reporting it\n`);
      return EXIT.pending;
  }
}
