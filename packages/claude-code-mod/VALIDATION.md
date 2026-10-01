# Mod validation: Claude Code 2.1.286 against the connector stub (2026-09-30)

Interactive Claude Code sessions in tmux on lim-builder (Sonnet 5.5 unless noted), the stub on a
private socket, requests posted as `lee`. Evidence: the stub's request/response record, final state
and fixture in `validation/mod-2026-09-30/` (`record.jsonl.gz`, `state.json`, `fixture.json`);
summaries below. The mod's decision logs from these runs were not kept (the log was rewritten each
session until fix pass 1). Fix pass 1 evidence is in `validation/fix-pass-1/5/claude-code/`.

| Acceptance check | Result |
|---|---|
| User settings `env` block enables the mod | Yes: flag in the user-settings layer (a throwaway `CLAUDE_CONFIG_DIR`, Lee's settings untouched) loads it, both with `--plugin-dir` and installed from the marketplace. Also loads without the flag today: mods are gated by a server rollout switch that is on for this account; the flag forces them on |
| Idle terminal woken by a delivery; answer reported as replied | Pass: `51` collected, `delivered` then `replied` |
| Delivery during a long turn runs as the next turn and is matched | Pass: waited behind a 40 s turn, ran as its own turn, `Paris` collected |
| Background shell task + helper subagent: collected normally; helper's answer never reported | Pass: a background shell's notification inside our turn was linked by its row (`toolUseId`) and the answer collected (`Background: 5, helper (9×9): 81, foreground: 6.`); subagent turns (`agentId`) never reported |
| Do task notifications carry `toolUseId` in practice? | Yes, on their transcript rows (background shell and helper subagent), and in the notification text itself (`<tool-use-id>`; a helper's `<task-id>` is its agent id). Since fix pass 1 the mod links by the text, so headless `-p` sessions link too |
| Lee types into the terminal while an injected turn runs | The typed text **enters our turn** (answered together). Delivery `ambiguous` (`origin: composer`) in both runs (`d_3`, `d_4`). In `d_4` the mod's notice led the agent to `comms reply`, completing it; `d_3` predates the notice and stayed `ambiguous` |
| An answer delivered in wakes the agent; nothing next is collected | Pass: `delivered` only, no outcome; the agent sent nothing back |
| Connector restarts mid-session: reconnects, nothing run twice | Pass: stub restarted mid-turn; `unknown_session` → re-register → check `yes/running` → `replied`; submitted once |
| A slow connector never leads to overlapping polls | Pass: 0 `poll_in_progress` over 69 live polls; unit test with a 1 s hold |
| Ten benign rendered requests, Sonnet and Opus, normal permission prompts | Pass 10/10 on both (below); the file write raised the normal permission prompt on both |
| Follow-up `comms reply` after the turn's own answer was collected | Pass: accepted as a second answer with the same `inReplyTo` (no `collectedFrom`) |
| Nothing outside comms turns sent to the connector | Pass: only protocol fields leave the session; no text from non-comms turns or typed input in the record |
| Claude Code ↔ Claude Code | Pass: mod-b (installed plugin) answered mod-a's request; the answer woke mod-a and ended `delivered` |

Also found: Claude Code often ends a turn while background work (a background shell, or the Agent
tool, which ran helpers asynchronously here) is still running, so the collected answer is interim.
The mod now attaches a reminder to the later notification, and the agent sent the result with
`comms reply` both times.

## Ten benign requests

```
Sonnet 5.5
1	d_13	replied	permission-prompt=no	12
2	d_14	replied	permission-prompt=no	Tokyo
3	d_15	replied	permission-prompt=no	Buenos días
4	d_16	replied	permission-prompt=no	There are 0 files in my current working directory (`/srv/agents/hazel/mod-work/moda`). The directory is empty, including hidden files.
5	d_17	replied	permission-prompt=no	A hash map is a data structure that stores key-value pairs and uses a hash function to turn each key into an index, which gives fast average-case lookup, insert
6	d_18	replied	permission-prompt=no	pong
7	d_19	replied	permission-prompt=no	Thursday.
8	d_20	replied	permission-prompt=yes	Created `/srv/agents/hazel/mod-work/moda/notes.txt` containing "hello".
9	d_21	replied	permission-prompt=no	Yes
10	d_22	replied	permission-prompt=no	10

Opus 5.5
1	d_23	replied	permission-prompt=no	12
2	d_24	replied	permission-prompt=no	Tokyo
3	d_25	replied	permission-prompt=no	Buenos días
4	d_26	replied	permission-prompt=no	Zero. `/srv/agents/hazel/mod-work/moda` is empty: no files and no hidden entries.
5	d_27	replied	permission-prompt=no	A hash map stores key-value pairs and runs a hash function on each key to find the slot that holds its value, so lookups, inserts and deletes take constant time
6	d_28	replied	permission-prompt=no	pong
7	d_29	replied	permission-prompt=no	Thursday
8	d_30	replied	permission-prompt=yes	I created `/srv/agents/hazel/mod-work/moda/notes.txt`, and it contains `hello`.
9	d_31	replied	permission-prompt=no	yes
10	d_32	replied	permission-prompt=no	10
```

## Against the real connector (2026-09-30, Cedar's `cedar-connector-m5`, local Convex, T3 on 3780)

Participants cc-a and cc-b (Claude Code, lim-builder); requests sent as cc-b with the `comms` CLI.

| Check | Result |
|---|---|
| Idle wake | Pass: `92` collected |
| Delivery during a long typed turn | Pass: ran as the next turn, `Rome` collected |
| Typed input during our turn | Entered our turn → `ambiguous` → the protocol's unmatched notice → the agent's `comms reply` |
| Background shell inside our turn | Pass: linked by its row, one answer collected (`Background: 5, helper subagent (9×9): 81, foreground: 6.`). The model skipped the Agent tool on both runs; the helper path was proven on the stub |
| Answers delivered, no loop | Pass: five answers queued for cc-b were delivered one by one when its terminal started; each ended `delivered`, nothing sent back |
| Agent-initiated Claude Code → Claude Code and Claude Code → T3 | Pass: cc-b's agent asked cc-a (`36`, collected) and t3-native (`56`, collected by the T3 adapter); both answers woke cc-b and weren't collected |
| Ten benign requests, Sonnet, normal permissions | Pass 10/10; the file write raised the permission prompt |
| Protocol errors in the mods' logs | None (no `poll_in_progress`, `conflict`, `bad_request`, `unavailable`) |
| Connector SIGKILLed mid-turn and recreated (Cedar's `start-connector-m5.sh`) | Pass: the mod saw ECONNRESET, then ECONNREFUSED, then `unknown_session`, and re-registered 5 s after the kill. The delivery was submitted once; its turn (held on a permission prompt for 5 min) finished after the lease handover and `It printed 271.` was collected |
