// The cloud CLI only acknowledges posting a message. The session answers later
// with comms reply; neither its final message nor its turn can be collected here.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { renderDelivery } from "@agent-comms/protocol";
import * as Effect from "effect/Effect";
import type { HarnessAdapter } from "./adapter.ts";

export interface ClaudeCloudOptions {
  bin?: string;
  run?: (args: string[], signal: AbortSignal, stdin: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const TIMEOUT_MS = 120_000;
const tail = (text: string) => text.slice(-2_000).trim();
const LOCATOR = /^(?:session_[A-Za-z0-9]+|https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+(?:\?.*)?)$/;
const windowsShim = (bin: string) => process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);

/** Resolve without invoking the CLI, which may have side effects even for a probe. */
function resolveBinary(bin: string): string | undefined {
  const paths = isAbsolute(bin) || bin.includes("/") || bin.includes("\\")
    ? [bin]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, bin));
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.COM").split(";")] : [""];
  for (const path of paths) {
    for (const ext of extensions) {
      try {
        const candidate = path + ext;
        // Batch shims require a shell. Configure the native executable instead.
        if (windowsShim(candidate)) continue;
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}

function runCli(bin: string, args: string[], signal: AbortSignal, stdin: string): ReturnType<NonNullable<ClaudeCloudOptions["run"]>> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let spawned = false;
    child.once("spawn", () => { spawned = true; });
    // Receipts are small. Bound captured output even if the CLI misbehaves.
    child.stdout.on("data", (data: Buffer) => {
      const next = stdout + data.toString();
      if (next.length > 1_000_000) stdoutTruncated = true;
      stdout = next.slice(-1_000_000);
    });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2_000); });
    child.on("error", (error) => reject(Object.assign(error, { spawned })));
    // A discarded prefix must never turn malformed output into a valid receipt.
    child.on("close", (code) => resolve({ code, stdout: stdoutTruncated ? "" : stdout, stderr }));
    // Content from other participants is data, never a shell command or argv.
    child.stdin.on("error", (error) => reject(Object.assign(error, { spawned: true })));
    child.stdin.end(stdin, "utf8");
  });
}

export function claudeCloudHarnessAdapter(options: ClaudeCloudOptions = {}): HarnessAdapter {
  const bin = options.bin ?? "claude";
  let resolved: string | undefined;
  const run = options.run ?? ((args, signal, stdin) => runCli(resolved ?? bin, args, signal, stdin));
  return {
    harness: "claude-cloud",
    steersIntoRunningTurn: false,
    // Cache success; a missing binary or failed handoff is checked again next time.
    ready: () => Effect.sync(() => Boolean(resolved ?? (resolved = resolveBinary(bin)))),
    // Registry polls recheck availability, including a binary removed since ready().
    presence: () => Effect.sync(() => ((resolved = resolveBinary(bin)) ? "idle" : "offline")),
    handOff: (target, delivery, gate) => Effect.promise(async (effectSignal) => {
      const signal = gate.signal ? AbortSignal.any([effectSignal, gate.signal]) : effectSignal;
      if (signal.aborted) return { _tag: "aborted", detail: "cancelled before sending" };
      if (!LOCATOR.test(target.locator) || /[\r\n\u2028\u2029]/.test(target.locator)) {
        return { _tag: "rejected", detail: "claude-cloud: locator must be a session_<alphanumeric id> or https://claude.ai/code/session_<alphanumeric id> URL" };
      }
      if (windowsShim(resolved ?? bin)) {
        return { _tag: "rejected", detail: "claude-cloud: Windows requires claudeCloud.bin pointing at the native executable, not a .cmd/.bat shim" };
      }
      const text = renderDelivery(delivery, {
        harnessLabelsSource: false,
        answerInstructions: ({ me, messageId, sender }) => [
          `An answer is expected. Answer @${sender} with \`comms reply --as ${me} ${messageId} "<your answer>"\`, now or once you have it. Nothing you write in this cloud session is sent or collected automatically.`,
        ],
      });
      if (signal.aborted || !(await gate.confirm(undefined)) || signal.aborted) {
        return { _tag: "aborted", detail: "claim not held, or cancelled, before sending" };
      }
      try {
        const result = await run(["-p", "--cloud", target.locator, "--output-format", "json"], signal, text);
        if (signal.aborted || result.code === null) {
          resolved = undefined;
          return { _tag: "lost", detail: tail(result.stderr) || "claude-cloud: CLI timed out or was signalled after spawn" };
        }
        let receipt: unknown;
        try { receipt = JSON.parse(result.stdout); } catch { /* The message may have posted before the receipt was lost. */ }
        if (result.code === 0 && typeof receipt === "object" && receipt !== null && "ok" in receipt && receipt.ok === true) {
          // steered means the answer comes by comms reply, so don't hold the agent.
          return { _tag: "accepted", turnId: `cloud-${delivery.id}-${Date.now()}`, steered: true };
        }
        resolved = undefined;
        const refused = typeof receipt === "object" && receipt !== null && "ok" in receipt && receipt.ok === false;
        return { _tag: refused ? "rejected" : "lost", detail: tail(result.stderr) || `claude-cloud: ${refused ? "refused" : "indeterminate"} receipt (exit ${result.code})` };
      } catch (error) {
        resolved = undefined;
        const failure = error as NodeJS.ErrnoException & { spawned?: boolean };
        const code = failure?.code;
        const detail = tail(String(error));
        // A spawn failure proves nothing entered. Everything else may have posted.
        return { _tag: !signal.aborted && !failure?.spawned && (code === "ENOENT" || code === "EACCES") ? "rejected" : "lost", detail };
      }
    }),
    awaitOutcome: () => Effect.succeed({ _tag: "ambiguous", entered: [{ origin: "claude-cloud" }] }),
    // Unknown settles as uncertain, never absent (which would blindly resend).
    check: () => Effect.succeed({ _tag: "unknown", detail: "claude-cloud: no way to ask the session" }),
  };
}
