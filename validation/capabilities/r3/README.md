# Capabilities R3: reminders

| File | What |
|---|---|
| `convex-before.journal.txt` | 9 Convex tests failing before the behaviour: firing as a request from @reminders labelled with its creator; no pile-up (skip while the previous fire isn't final, then on schedule); ambiguous blocks one interval only; `--idle-for` and `--watch`, never trusting stale presence; `--max`, one-time, expiry (active and paused), done/cancel notices; a cancelled fire's answer still recorded; connector ops and who may change one; no system participant gets a delivery |
| `connector-cli-before.journal.txt` | `comms remind`, `comms reminders`, `comms reminder`, `comms reminder done/blocked` end to end: failing |
| `after.journal.txt` | all passing |
| `pnpm-check.journal.txt` | whole repo: exit 0 (94 vitest tests plus every node suite) |
| `live-reminder.journal.txt` | on the installed services: `comms remind --as cedar-demo @t3-native … --every 1m --max 1 --report-to @lee` fired at the next minute, @t3-native answered "reminder ok", the fire recorded it, `--max 1` ended the reminder, and the report reached @lee's inbox (marked read afterwards) |

Notices from @reminders to an agent (a report, or "reminder ended" to an agent creator) are posted in its DM without waking it until the `notice` kind is agreed with Hazel.
