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
  run?: (args: string[], signal: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const TIMEOUT_MS = 120_000;
const tail = (text: string) => text.slice(-2_000).trim();

/** Resolve without invoking the CLI, which may have side effects even for a probe. */
function resolveBinary(bin: string): string | undefined {
  const paths = isAbsolute(bin) || bin.includes("/") || bin.includes("\\")
    ? [bin]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, bin));
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const path of paths) {
    for (const ext of extensions) {
      try {
        const candidate = path + ext;
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}

function runCli(bin: string, args: string[], signal: AbortSignal): ReturnType<NonNullable<ClaudeCloudOptions["run"]>> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal, timeout: TIMEOUT_MS, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";
    // Receipts are small. Bound captured output even if the CLI misbehaves.
    child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(-1_000_000); });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2_000); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function claudeCloudHarnessAdapter(options: ClaudeCloudOptions = {}): HarnessAdapter {
  const bin = options.bin ?? "claude";
  let resolved: string | undefined;
  const run = options.run ?? ((args, signal) => runCli(resolved ?? bin, args, signal));
  return {
    harness: "claude-cloud",
    steersIntoRunningTurn: false,
    // Cache success; a missing binary or failed handoff is checked again next time.
    ready: () => Effect.sync(() => Boolean(resolved ?? (resolved = resolveBinary(bin)))),
    handOff: (target, delivery, gate) => Effect.promise(async (effectSignal) => {
      const signal = gate.signal ? AbortSignal.any([effectSignal, gate.signal]) : effectSignal;
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
        const result = await run(["-p", text, "--cloud", target.locator, "--output-format", "json"], signal);
        if (signal.aborted || result.code === null) {
          resolved = undefined;
          return { _tag: "lost", detail: tail(result.stderr) || "claude-cloud: CLI timed out or was signalled after spawn" };
        }
        let receipt: unknown;
        try { receipt = JSON.parse(result.stdout); } catch { /* An invalid receipt is a rejection. */ }
        if (result.code === 0 && typeof receipt === "object" && receipt !== null && "ok" in receipt && receipt.ok === true) {
          // steered means the answer comes by comms reply, so don't hold the agent.
          return { _tag: "accepted", turnId: `cloud-${delivery.id}-${Date.now()}`, steered: true };
        }
        resolved = undefined;
        return { _tag: "rejected", detail: tail(result.stderr) || `claude-cloud: invalid or refused receipt (exit ${result.code})` };
      } catch (error) {
        resolved = undefined;
        const code = (error as NodeJS.ErrnoException)?.code;
        const detail = tail(String(error));
        // A spawn failure proves nothing entered. Everything else may have posted.
        return { _tag: !signal.aborted && (code === "ENOENT" || code === "EACCES") ? "rejected" : "lost", detail };
      }
    }),
    awaitOutcome: () => Effect.succeed({ _tag: "ambiguous", entered: [{ origin: "claude-cloud" }] }),
    // Unknown settles as uncertain, never absent (which would blindly resend).
    check: () => Effect.succeed({ _tag: "unknown", detail: "claude-cloud: no way to ask the session" }),
  };
}
