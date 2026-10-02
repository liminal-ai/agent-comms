// agent-comms for a standalone Claude Code session. Active only when the
// session's environment names its participant (AGENT_COMMS_PARTICIPANT); then
// it registers with the machine's connector, polls it (one poll at a time),
// submits deliveries as plugin prompts and reports how their turns ended.
// Nothing about other turns leaves the session except busy/idle presence.

import { socketPath } from "./protocol/loopback.ts";
import { CommsMod, type Host } from "./core/mod.ts";

const PLUGIN_NAME = "agent-comms";
const TICK_MS = 2_000;

let mod: CommsMod | undefined;

type Dollar = any;

// Environment names are literal at each call: the engine lists what a mod reads.
const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

async function run($: Dollar, argv: string[]): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 5_000 });
    return exitCode === 0 ? String(stdout).trim() : undefined;
  } catch {
    return undefined;
  }
}

async function resolveSocket($: Dollar): Promise<string | null> {
  const override = nonEmpty(await $.env.get("AGENT_COMMS_SOCKET"));
  if (override) return override;
  const xdgRuntimeDir = nonEmpty(await $.env.get("XDG_RUNTIME_DIR"));
  const home = nonEmpty(await $.env.get("HOME"));
  const system = await run($, ["uname", "-s"]);
  const platform = system === "Darwin" ? "darwin" : system === "Linux" ? "linux" : (system ?? "linux").toLowerCase();
  const uidText = platform === "linux" && !xdgRuntimeDir ? await run($, ["id", "-u"]) : undefined;
  const uid = uidText !== undefined && /^\d+$/.test(uidText) ? Number(uidText) : undefined;
  return socketPath({ platform, xdgRuntimeDir, home, uid });
}

/**
 * The journal and log hold delivered requests and answers: the folder is made
 * 0700 and both files 0600 before anything is written (`$.fs.write` keeps an
 * existing file's mode). False if that can't be done; the mod then stays off.
 */
async function secureStateFiles($: Dollar, dir: string, files: string[]): Promise<boolean> {
  for (const argv of [["mkdir", "-p", "-m", "700", dir], ["chmod", "700", dir], ["touch", ...files], ["chmod", "600", ...files]]) {
    if ((await run($, argv)) === undefined) return false;
  }
  return true;
}

function makeHost($: Dollar, socket: string, statePath: string, earlierLog: string[]): Host {
  // The log keeps its last 200 lines across sessions.
  const logLines: string[] = earlierLog.slice(-200);
  let logWrite: Promise<void> = Promise.resolve();
  return {
    call: async (path, body) => {
      const res = await $.http.fetch(`http://connector${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        socketPath: socket,
      });
      return { status: res.status, text: res.text };
    },
    submit: async (text) => {
      const result = await $.prompt.submit({ text });
      return result && typeof result === "object" && "drop" in result ? { dropped: String(result.drop) } : {};
    },
    now: () => Date.now(),
    sleep: (ms) => $.clock.sleep(ms),
    log: (line) => {
      // The last 200 lines, beside the journal; logging never breaks the session.
      logLines.push(`${new Date().toISOString()} ${line}`);
      if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
      logWrite = logWrite.then(() => $.fs.write(`${statePath}.log`, logLines.join("\n") + "\n")).catch(() => {});
    },
    loadJournal: async () => ((await $.fs.exists(`${statePath}.json`)) ? String(await $.fs.read(`${statePath}.json`)) : null),
    saveJournal: (text) => $.fs.write(`${statePath}.json`, text),
    transcriptHas: async (needle) => {
      const messages = await $.session.messages();
      return Array.isArray(messages) && messages.some((m: any) => m?.role === "user" && String(m.text ?? "").includes(needle));
    },
  };
}

export function register(on: any) {
  on("session.start", async ($: Dollar, e: any, next: any) => {
    const result = await next(e);
    try {
      const participant = nonEmpty(await $.env.get("AGENT_COMMS_PARTICIPANT"));
      if (!participant || mod) return result;
      const socket = await resolveSocket($);
      if (!socket) return result;
      const home = nonEmpty(await $.env.get("HOME")) ?? ".";
      const stateHome = nonEmpty(await $.env.get("XDG_STATE_HOME")) ?? `${home}/.local/state`;
      const sessionId = String(await $.session.id());
      const dir = `${stateHome}/agent-comms/mod`;
      const statePath = `${dir}/${participant}`;
      if (!(await secureStateFiles($, dir, [`${statePath}.json`, `${statePath}.log`]))) return result;
      const earlierLog = String((await $.fs.read(`${statePath}.log`)) ?? "").split("\n").filter((l) => l !== "");
      mod = new CommsMod(makeHost($, socket, statePath, earlierLog), {
        participant,
        sessionId,
        cwd: e.cwd ?? result?.cwd ?? home,
        pluginName: PLUGIN_NAME,
      });
      await mod.start();
      // Never awaited: a slow tick must not hold up the next period.
      $.clock.every(TICK_MS, () => {
        void mod?.tick();
      });
    } catch {
      // A broken connector never blocks the session.
    }
    return result;
  });

  on("turn.start", ($: Dollar, e: any, next: any) => {
    mod?.onTurnStart(e.turnId, String(e.text ?? ""));
    return next(e);
  });

  on("prompt.submit", ($: Dollar, e: any, next: any) => {
    if (!mod) return next(e);
    const input = { turnId: e.turnId, origin: e.origin ?? { kind: "unclassified" }, text: String(e.text ?? "") };
    mod.onPromptSubmit(input);
    const note = mod.contextFor(input);
    return note ? next({ ...e, context: [...(e.context ?? []), note] }) : next(e);
  });

  // Our work, by identity: the call, then its result (an Agent call names its
  // subagent, a background shell its task).
  on("tool.call", async ($: Dollar, e: any, next: any) => {
    mod?.onToolCall({ toolUseId: e.tool_use_id, agentId: e.agentId, background: e.run_in_background === true, tool: e.tool });
    const result = await next(e);
    mod?.onToolResult({ toolUseId: e.tool_use_id, agentId: e.agentId, result: result?.result, text: result?.text });
    return result;
  });

  on("agent.spawn", async ($: Dollar, e: any, next: any) => {
    const result = await next(e);
    mod?.onAgentSpawned({ agentId: result?.agentId, parentAgentId: e.parentAgentId, engine: e.provider?.plugin === "engine" });
    return result;
  });

  on("turn.complete", async ($: Dollar, e: any, next: any) => {
    const result = await next(e);
    mod?.onTurnComplete({ turnId: e.turnId, agentId: e.agentId, reason: e.reason, answer: String(e.answer ?? "") });
    return result;
  });

  // Task notifications name the call or subagent that started them only on their transcript row.
  on("ui.render", { component: "UserMessage" }, ($: Dollar, e: any, next: any) => {
    if (mod && e.props?.origin?.kind === "task-notification" && e.props.task) {
      mod.onTaskRow({ id: e.props.task.id, toolUseId: e.props.task.toolUseId });
    }
    return next(e);
  });

  on("session.end", async ($: Dollar, e: any, next: any) => {
    await mod?.stop();
    mod = undefined;
    return next(e);
  });
}
