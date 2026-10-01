# Fix pass 1, section 5: independent acceptance (T3 side, Cedar)

Run 2026-10-01 from 13:40 UTC (`run-start.txt`) on the real installation: `agent-comms-connector.service` and `agent-comms-convex.service` from `main`, Hazel's T3 v0.0.44 on 3780. Isolated for the purpose: two new T3 threads (`run.json`), participants `fp1-native`, `fp1-codex` (T3) and `fp1-req` (the requester), and one new group per scenario (titles `fp1 …`). "Lee" is simulated by sending `thread.turn.start` with a foreign message id, as T3's web UI does.

Files (raw; no credentials, no user-message text):

| File | What |
|---|---|
| `results-t3.jsonl`, `results-web.jsonl` | one line per scenario, written by the scripts |
| `t3-events.jsonl` | every event on the two threads during the run: sequence, type, message ids, session state, turn ids (`record-t3.ts`) |
| `connector-service.log`, `connector-test-units.log` | the connector's journal for the run window, with its `decision …` and `t3 dispatch …` lines; the test units are the fault-injected connector and connector A |
| `convex-dump.json`, `deliveries.txt` | this run's conversations: every message and delivery state (`dump-convex.mjs`) |
| `summary-t3.json` | counts computed from the files above (`summarize.mjs`) |
| `web-1-promoted.png`, `web-2-group.png` | the web workflow |
| `lib.mjs`, `setup.mjs`, `t3-scenarios.mjs`, `racer.ts`, `record-t3.ts`, `web-workflow.mjs` | the scripts |

## Results

| Check | Scenario | Result |
|---|---|---|
| The dispatcher with the real T3 adapter | `baseline` | `replied`, one message, one turn |
| Claim lost while a T3 send waits (2.2) | `claimLost`: connector A claims and waits on a busy thread; A is frozen (SIGSTOP) past its 8 s lease; B (the service) takes over; A is resumed | B: recover → check absent → gate confirmed → one dispatch → `replied`. A: "claim lost to another holder; stopped", and its pre-send gate refused: no dispatch from A (`connector-test-units.log`). One message in the thread. |
| Crash after the harness accepted, before `delivered` | `crashWindow`: `AGENT_COMMS_FAULT=crash-after-accept` | state at the crash `claimed`; after restart, replay from the cursor recorded before sending → `replied`; one message, one turn |
| Concurrent input: queued message flushing at the same `ready` (1.1) | `queuedRace` ×3: a racer fires Lee's message on the same `ready` event our adapter waits for | all three `ambiguous` (Lee's started the turn, ours joined: `t3-turn-already-running`); the notice went in and the agent completed each with its own `comms reply`. `queuedFlush` (slower Lee) shows the other order: separate turns, `replied`. |
| Typed text during our turn | `typedIn` | `ambiguous` (`t3-user-message`), then the agent's `comms reply` |
| Recovery after an interrupt mid-stream | `interruptRecovery`: connector SIGKILLed mid-answer, turn interrupted, systemd restarts the connector | `failed` ("interrupted; its partial answer wasn't collected"); nothing collected |
| Retire, remove, rebind with a request in flight | `lifecycle` | each `replied` once; the rebound one finished in the original thread, nothing sent to the new one |
| Oversize request | `oversize`: 40,000 characters | refused at send, exit 1, "text: expected non-empty text (at most 32000 characters)"; nothing posted |
| The web workflow | `web-workflow.mjs` | promoted a terminal agent (shown "mod not connected"), created a group, posted addressing one member ("wakes @fp1-codex"), badge `claimed` → `replied`, answer shown |

Counts over the whole run (`summary-t3.json`): 15 request deliveries in 19 conversations; 14 ended `replied` (8 collected from the turn, the rest completed by the agent's `comms reply` after being ambiguous), 1 `failed` (the interrupt). Every one of the 15 was appended to T3 exactly once (`t3-events.jsonl`) and dispatched exactly once (`t3 dispatch` lines); no delivery has more than one collected answer; no answer delivery went past `delivered`. Two of the 15 come from first `queuedRace` runs whose script stopped early (a bug in the script, since fixed); their deliveries are in `deliveries.txt` like the rest.

Found and fixed during the run: the Convex client printed server errors itself, which could echo a call's arguments; its logging now goes through the same redaction (commit on main).

Still to do with Hazel: the Claude Code side (crash window, 1.6 background helper, 1.7 typed text, ten requests on Opus and Sonnet) and the eight shared checks on the real installation with her terminal from 4.2.

## Rerun after the 1.2 follow-up (13:57 UTC)

After the change requiring a turn's `starting` step (Reed's Q1, `validation/fix-pass-1/1`), `baseline` (replied), `crashWindow` (claimed at the crash, then replied, one turn) and `typedIn` (ambiguous) were rerun on the redeployed connector; they're the last lines of `results-t3.jsonl`, and the summary and dump above include them.
