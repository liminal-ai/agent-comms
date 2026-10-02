# Fix pass section 4: affected acceptance items, rerun on the fixed code (Cedar)

Cedar's acceptance scripts (`validation/capabilities/acceptance/*.mjs`) run on the installed services after sections 0-3. Each journal has a PASS or FAIL line per check.

| Items | Journal | Result |
|---|---|---|
| 3, 4, 5 | `a-waits.journal.txt` | all pass |
| 7 | `b-restarts.journal.txt` (`-run1`: the 7b check matched an earlier fallback from the same run; the matcher was loose, not the behaviour, and the rerun with an exact matcher passes) | all pass |
| 8 | `c-races.journal.txt` | all pass. 8a: replies from 400 ms before the bound to 400 ms after it. 8b now races the harness's `answer-seen` against the waits sweep (the CLI's `ack` is provisional): confirmations up to the sweep were acknowledged, later ones fell back, both outcomes occurred, and there were never two fallbacks |
| 9, 10 | `d-reminders.journal.txt` | all pass |
| 11, 12 | `e-alerts.journal.txt` | all pass; `connectorSilentMs` 600000, then 120000 for the test, then 600000 again (logged) |

The restart items with each kill proven (old PID gone), and 7c with a real CLI kill: `../restarts-7a.journal.txt`, `../restarts-7c.journal.txt`. The scale run: `../scale/`. `cleanup.journal.txt`: after the rerun, the acceptance alerts in @lee's inbox were marked read, and the last connector-silent incident resolved on its own once the connector was heard from.

Under the fix pass, every answer to a scripted session that never sends `answer-seen` falls back once into its thread: that's the designed duplicate, and the journals show it.
