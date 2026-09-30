# Mod validation: Claude Code 2.1.286 against the connector stub (2026-09-30)

Interactive Claude Code sessions in tmux on lim-builder (Sonnet 5.5 unless noted), the stub on a
private socket, requests posted as `lee`. Evidence: the stub's request/response record and the
mod's decision log (paths in PROGRESS-t3.md); summaries below.

| Acceptance check | Result |
|---|---|
| User settings `env` block enables the mod | Yes: flag in the user-settings layer (a throwaway `CLAUDE_CONFIG_DIR`, Lee's settings untouched) loads it, both with `--plugin-dir` and installed from the marketplace. Also loads without the flag today: mods are gated by a server rollout switch that is on for this account; the flag forces them on |
| Idle terminal woken by a delivery; answer reported as replied | Pass: `51` collected, `delivered` then `replied` |
| Delivery during a long turn runs as the next turn and is matched | Pass: waited behind a 40 s turn, ran as its own turn, `Paris` collected |
| Background shell task + helper subagent: collected normally; helper's answer never reported | Pass: a background shell's notification inside our turn was linked by its row (`toolUseId`) and the answer collected (`Background: 5, helper (9×9): 81, foreground: 6.`); subagent turns (`agentId`) never reported |
| Do task notifications carry `toolUseId` in practice? | Yes, on their transcript rows (background shell and helper subagent). Rows are drawn only on a surface; headless `-p` can't link, so that case is ambiguous |
| Lee types into the terminal while an injected turn runs | The typed text **enters our turn** (answered together). Delivery `ambiguous` (`origin: composer`); the mod's notice led the agent to `comms reply`, completing it |
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
