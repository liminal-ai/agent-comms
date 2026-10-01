# Fix pass 1, section 5: Claude Code side (Hazel)

Real installation: `agent-comms-connector.service` (main), Claude Code 2.1.286, mod from branch hazel (merged with main 69ec9d0). Participant cc-a in `/tmp/hazel-mod-work/cca` with only `comms` and `node` on PATH; requests sent as cc-b. Each folder holds `run.txt` (times, command) or `steps.txt`, `output.txt` (script output), `mod-log.txt` (the mod's decisions during the run) and `terminal.txt` (the terminal at the end). Counts below are computed from these files; the crash case also has the connector journals (`journal-connector.txt`, `journal-fault-unit.txt`) and `run.sh`.

| Case | Expected | Result (from the files) |
|---|---|---|
| `1.6-foreign-helper` | A helper Lee started before our request, finishing during it: ambiguous | `outcome=ambiguous`; mod log: `peer input during our turn`; the helper's tool calls logged "in subagent" and not credited; answer then sent with `comms reply` |
| `1.7-typed-mid-turn` | Typed text during our turn: ambiguous, then `comms reply` | `outcome=ambiguous`; mod log: `composer input during our turn`; reply carries none of the typed text |
| `crash-after-accept` | Connector SIGKILLed after the mod acked `delivered`, before Convex recorded it (Cedar's `AGENT_COMMS_FAULT=crash-after-accept`); service restarted: `delivered` or `uncertain`, never a second run | 1 turn carried the header (`counts.txt`: mod log and terminal agree); fault unit killed itself right after `handoff-accepted`; the restarted connector, once the old lease expired (60 s), logged `recover` → `check-completed` → `outcome replied`; 1 answer collected (`42`). The mod's `replied` report, queued while the connector was down, was retried after re-registration (`mod-log.txt`) |
| `ten-requests-sonnet` | 10 requests collected; model's view inside the plugin wrapper | 10/10 replied; 10/10 captures in `model-view/` show the wrapper |
| `ten-requests-opus` | 10 requests collected; model's view inside the plugin wrapper | 10/10 replied; 10/10 captures in `model-view/` show the wrapper |

PRIVATE- markers (typed in 1.6 and 1.7) in any `output.txt` or `mod-log.txt`: 0.

The connector restarted during 1.6 (13:43:06Z) and before the Opus run (13:48:38Z), from Cedar's own checks; the mod re-registered within 3 s each time (`mod-log.txt`). An Opus run interrupted by that restart was discarded and rerun.
