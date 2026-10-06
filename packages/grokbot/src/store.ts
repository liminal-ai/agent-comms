// The bridge's durable state, all plain files Grok Bot can read directly:
//
//   <inbox>/<deliveryId>.json        pending: needs Grok Bot (or a report is still being sent)
//   <inbox>/done/<deliveryId>.json   handled and fully reported
//   <home>/log.jsonl                 append-only event log
//   <home>/state.json                session id, when this history started
//   <home>/outbox/*.json             commands from the CLI, consumed by the daemon
//   <home>/outbox/results/*.json     the daemon's answer to each command
//   <home>/daemon.lock               the running daemon's pid
//
// Every JSON file is written whole to a temporary name, synced and renamed into
// place, so a reader never sees half a file. The daemon is the only writer of
// the inbox; the CLI only writes commands.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ConversationRef, type Delivery, ID_PATTERN, type MessageKind, type OutcomeBody, type ParticipantRef } from "@agent-comms/protocol";

export type ItemState =
  /** A request Grok Bot hasn't answered yet. */
  | "awaiting-answer"
  /** Answered; the `replied` outcome is being reported. */
  | "answered"
  /** Done: the connector took the answer. */
  | "replied"
  /** Not answered in time: reported `ambiguous`. Answer it with `grokbot answer` (sent as `comms reply`). */
  | "timed-out"
  /** An answer after the timeout (or one the connector refused), being posted with `reply`. */
  | "late-reply-queued"
  /** Done: the answer was posted with `reply`. */
  | "replied-late"
  /** The `reply` was refused; see `lastError`. `grokbot answer` tries again, `grokbot ack` closes it. */
  | "reply-failed"
  /** An answer or notice: no reply expected. `grokbot ack` marks it read. */
  | "unread"
  /** Done: read (`grokbot ack`), or closed without an answer. */
  | "acknowledged";

export const DONE_STATES: ReadonlySet<ItemState> = new Set(["replied", "replied-late", "acknowledged"]);

export interface ItemEvent {
  at: string;
  event: string;
  detail?: string;
}

export interface InboxItem {
  v: 1;
  deliveryId: string;
  messageId: string;
  kind: MessageKind;
  /** Only requests expect an answer. */
  expectsReply: boolean;
  from: ParticipantRef;
  /** Our own comms name (pass as `--as` to the comms CLI). */
  recipient: string;
  conversation: ConversationRef;
  /** For an answer: the request it answers. */
  inReplyTo?: string;
  /** The message text as sent. */
  text: string;
  /** `renderDelivery`: the whole delivery as a model should read it. */
  rendered: string;
  receivedAt: string;
  /** The turn id reported with `delivered`: `grok-<deliveryId>`. */
  turnId: string;
  state: ItemState;
  deliveredReported: boolean;
  /** Requests: when the bridge gives up waiting and reports `ambiguous`. */
  deadlineAt?: string;
  /** The outcome being (or already) reported. */
  outcome?: OutcomeBody;
  outcomeReported?: boolean;
  answer?: string;
  answeredAt?: string;
  answerMessageId?: string;
  /** An answer sent with the `reply` operation (after a timeout, or when the outcome was refused). */
  lateReply?: { text: string; key: string; messageId?: string };
  /** After a timeout: the protocol's unmatched notice, saying how to answer now. */
  notice?: string;
  lastError?: string;
  /** Command ids already applied, so a command re-read after a crash isn't applied twice. */
  appliedCommands?: string[];
  delivery: Delivery;
  events: ItemEvent[];
}

/** Done, and nothing left to tell the connector: the item moves to `done/`. */
export function isSettled(item: InboxItem): boolean {
  return DONE_STATES.has(item.state) && item.deliveredReported && (item.outcome === undefined || item.outcomeReported === true);
}

export interface BridgeState {
  sessionId: string;
  /** Epoch ms when this inbox was started: a delivery created before it may have been seen by a lost history. */
  historyStartedAt: number;
}

export interface Command {
  id: string;
  action: "answer" | "ack";
  deliveryId: string;
  text?: string;
  at: string;
}

export interface CommandResult {
  id: string;
  ok: boolean;
  message: string;
  state?: ItemState;
}

export interface StorePaths {
  inboxDir: string;
  outboxDir: string;
  logFile: string;
  stateFile: string;
}

export function isDeliveryId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Writes a file whole, synced, then renamed into place. */
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(tmp, "w", mode);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const unlinkQuiet = (path: string) =>
  unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });

export class Store {
  readonly paths: StorePaths;
  readonly doneDir: string;
  readonly resultsDir: string;

  constructor(paths: StorePaths) {
    this.paths = paths;
    this.doneDir = join(paths.inboxDir, "done");
    this.resultsDir = join(paths.outboxDir, "results");
  }

  async init(): Promise<void> {
    for (const dir of [dirname(this.paths.stateFile), this.paths.inboxDir, this.doneDir, this.paths.outboxDir, this.resultsDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
  }

  private pendingPath(id: string): string {
    return join(this.paths.inboxDir, `${id}.json`);
  }

  private donePath(id: string): string {
    return join(this.doneDir, `${id}.json`);
  }

  /** Where the item's file is now (pending or done). */
  pathOf(item: InboxItem): string {
    return isSettled(item) ? this.donePath(item.deliveryId) : this.pendingPath(item.deliveryId);
  }

  async get(id: string): Promise<InboxItem | null> {
    if (!isDeliveryId(id)) return null;
    return (await readJson<InboxItem>(this.pendingPath(id))) ?? (await readJson<InboxItem>(this.donePath(id)));
  }

  /** Writes the item to `done/` once settled, else to the inbox, and removes the other copy. */
  async put(item: InboxItem): Promise<void> {
    if (!isDeliveryId(item.deliveryId)) throw new Error(`refusing to store delivery id ${JSON.stringify(item.deliveryId)}`);
    const settled = isSettled(item);
    await writeFileAtomic(settled ? this.donePath(item.deliveryId) : this.pendingPath(item.deliveryId), JSON.stringify(item, null, 2) + "\n");
    await unlinkQuiet(settled ? this.pendingPath(item.deliveryId) : this.donePath(item.deliveryId));
  }

  /** Pending items (oldest first), and with `all` the done ones too. */
  async list(options: { all?: boolean } = {}): Promise<InboxItem[]> {
    const dirs = options.all ? [this.paths.inboxDir, this.doneDir] : [this.paths.inboxDir];
    const items = new Map<string, InboxItem>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names) {
        if (!name.endsWith(".json") || name.startsWith(".")) continue;
        const item = await readJson<InboxItem>(join(dir, name)).catch(() => null);
        if (item && !items.has(item.deliveryId)) items.set(item.deliveryId, item);
      }
    }
    return [...items.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.deliveryId.localeCompare(b.deliveryId));
  }

  async log(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    await appendFile(this.paths.logFile, JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n", { mode: 0o600 });
  }

  async loadState(): Promise<BridgeState | null> {
    return readJson<BridgeState>(this.paths.stateFile);
  }

  async saveState(state: BridgeState): Promise<void> {
    await writeFileAtomic(this.paths.stateFile, JSON.stringify(state, null, 2) + "\n");
  }

  // -------------------------------------------------------------------------
  // Commands (CLI → daemon)

  async writeCommand(command: Command): Promise<string> {
    await mkdir(this.paths.outboxDir, { recursive: true, mode: 0o700 });
    const path = join(this.paths.outboxDir, `${Date.now().toString().padStart(14, "0")}-${command.id}.json`);
    await writeFileAtomic(path, JSON.stringify(command, null, 2) + "\n");
    return path;
  }

  /** Commands waiting, oldest first, each with the file to remove once it's handled. */
  async readCommands(): Promise<{ file: string; command: Command | null }[]> {
    let names: string[];
    try {
      names = await readdir(this.paths.outboxDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: { file: string; command: Command | null }[] = [];
    for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
      const file = join(this.paths.outboxDir, name);
      out.push({ file, command: await readJson<Command>(file).catch(() => null) });
    }
    return out;
  }

  async removeCommand(file: string): Promise<void> {
    await unlinkQuiet(file);
  }

  async writeResult(result: CommandResult): Promise<void> {
    await writeFileAtomic(join(this.resultsDir, `${result.id}.json`), JSON.stringify(result, null, 2) + "\n");
  }

  async readResult(id: string): Promise<CommandResult | null> {
    return readJson<CommandResult>(join(this.resultsDir, `${id}.json`));
  }

  async removeResult(id: string): Promise<void> {
    await unlinkQuiet(join(this.resultsDir, `${id}.json`));
  }
}

/** Removes command results nobody collected, older than `maxAgeMs`. */
export async function pruneOld(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (st && now - st.mtimeMs > maxAgeMs) {
      await unlinkQuiet(path);
      removed++;
    }
  }
  return removed;
}
