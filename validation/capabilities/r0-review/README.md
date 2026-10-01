# R0 review (Hazel): changes

| Item | Change | Test |
|---|---|---|
| 1 ack only while the turn runs | contract: presence `busySince` (set on the transition to busy); an ack counts only if the waiter is busy, not stale, and `busySince` ≤ the wait's creation. Enforced in R2 | Convex: busySince transitions |
| 2 busy waiting | contract: a wait stops being active when no result is `open` (answered included), or at `until`. Enforced in R2 | (R2) |
| 3 `--at` | `parseAt` (ISO 8601 with a time, or HH:MM = next local occurrence); `formatSchedule` (`every 30m`, `once at 2026-10-01 14:30 UTC`) | protocol |
| 4 blocked reason | the `reminder-update` decoder refuses `blocked` without a non-blank reason | protocol |
| 5 alert conversation | `Alert.conversationId` (its DM) and `subject.conversationId` for deliveries | Convex |
| 6 list rows | `Reminder.lastFire` and `lastSkip` | Convex |
| 7 inbox for system senders | confirmed for R1: post() writes inbox rows for every person addressed, whoever sends | (R1) |

`before.journal.txt`: 3 protocol and 3 Convex tests failing. `after.journal.txt`: all passing (the older idleSince test now also expects `busySince` on busy writes, by design). `pnpm-check.journal.txt`: whole repo, exit 0. Sanitized: 0 credential values.
