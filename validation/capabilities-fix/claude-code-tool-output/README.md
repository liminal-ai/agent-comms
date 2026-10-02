# Claude Code: what a mod's `tool.call` sees of a tool's output (fix pass 0.1, Hazel)

Claude Code 2.1.287, a probe mod (`probe-plugin/`) that writes each `tool.call`'s `agentId`,
`run_in_background` and `next(e)`'s `text` ("the result as the model reads it") to a file, in a test
terminal in /tmp with its own config dir. `fake-answer.ts` prints a waiting send's output with
the section 0 markers (`renderAnswerWithProof`); `analyse.ts` runs `findAnswerProofs` over what was
captured (`results/`, `analysis.txt`):

| Case | `text` | Proof found |
|---|---|---|
| short answer, main loop | the output, exactly | yes |
| blank lines, trailing spaces, a tab | the output, exactly (whitespace kept) | yes |
| 28.7k characters | the output, whole | yes |
| 30.8k and 57k characters | `<persisted-output>`: "Output too large… Full output saved to: <file>", then a 2 KB preview | no (end marker missing) |
| the same command run by a helper subagent | exact, **with `agentId` set** | parser yes, so the mod must skip `agentId` calls |
| `run_in_background: true` | "Command running in background with ID: …" | no |

So the mod can confirm from `text`, main loop only (no `agentId`). Answers over ~30k characters
never confirm and fall back. No middle truncation was seen on this version; the `chars` check
covers it if it appears.

**Mod loading** (`mod-loading-debug-excerpt.txt`): the server-side rollout switch for mods
(`tengu_plugin_hooks_modules`) is now **off**. `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the process
environment or in a `--settings` file no longer loads them ("hooks module … not loaded: … the
rollout switch served off"). In the terminal's own user settings (`$CLAUDE_CONFIG_DIR/settings.json`
`env`, the README's procedure) it still does ("hooks module proof-probe@inline loaded").
