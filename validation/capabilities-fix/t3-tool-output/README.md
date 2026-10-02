# Does T3 v0.0.44 show a turn's tool output to the adapter? (fix pass 0.1, Hazel)

**No, not enough for the 0.1 proof.** T3 shows the adapter only a one-line preview of each tool's
output: the first non-empty line, clipped at 84 characters. The CLI's end marker is never visible,
so T3 can't confirm, and falls back like Codex.

## Live (2026-10-02, 3780, Claude Code 2.1.287 via claudeAgent, Codex 0.154)
One turn per provider (`tto-turn`, threads from H0): the agent ran
`printf "<<<comms-answer …\nThe answer is forty-two.\n>>>comms-answer …\n"`.
- `claude/`: the model quoted all three lines back (`result.json`); the `tool.completed`
  activity on `subscribeThread` (`events.jsonl`) has `data.rawOutput = {"content": "<<<comms-answer wait=w_test message=m_test"}`.
- `codex/`: the model's tool result held all three lines; the activity has
  `data.item.aggregatedOutput = "<<<comms-answer wait=w_test message=m_test"`.

## Source (t3code v0.0.44)
- `apps/server/src/orchestration/ActivityPayloadProjection.ts:164-188` `summarizeToolTextOutput`:
  returns the first meaningful line (≤ 84 chars, "…" past that). Applied to Claude's `rawOutput`
  (`:362-400`) and Codex's `aggregatedOutput` (`:97-101`).
- Applied to everything an outside client can read: the live stream and snapshot
  (`ws.ts:2199, 2269, 2340`), HTTP (`orchestration/http.ts:90`), and before activities are stored
  (`Layers/ProviderRuntimeIngestion.ts:941-945`), so the full output isn't kept anywhere reachable.

## Also seen (H0 recordings, `validation/capabilities/h0/`)
- Claude, backgrounded command (T3C-1, T3C-3): the activity's output is the tool result the model
  got ("Command did not complete within its 120s timeout and was moved to the background…"), so
  for Claude the preview does reflect what the model saw, just not all of it.
- Codex (T3X-1): a command the agent stopped polling finished later, and its `tool.completed`
  with `aggregatedOutput: "FINISHED"` was attached to a **later turn** (T3X-4's turn 01a0f87e),
  though no model ever read it. Codex's aggregated output isn't proof of reading even in full.
