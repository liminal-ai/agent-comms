# W: the web view's registry, inbox, reminders and alerts (Hazel)

Against R0 (main 3f2d4dc) and Cedar's review changes (ff55c4d: alert conversation ids, reminders' last fire and skip). Raw evidence:

- `view-tests-before.txt`: the 14 view-logic tests failing on the stub module (commit 9610657).
- `view-tests-2-before.txt`: two more failing (live staleness, inbox labels) before their helpers (1526452).
- `view-tests-3-before.txt`: the last-fire/skip test failing before its helper (2cde8c1).
- `view-tests-after.txt`: 17 of 17 pass, typecheck clean.
- `live-r0/`: `live-check.mjs` in headless Chrome against my dev server (127.0.0.1:3791, my worktree)
  and the local Convex deployment: `output.txt` (every step logged, ALL PASS) and screenshots.
  - Registry: term-a's description and duties set through `registry.setProfile` and shown; an
    over-long description refused in the form.
  - Reminders: one created as @lee for @term-a (every 45m, at most 3), paused, resumed, blocked with a
    reason, history shown, cancelled (so it can never fire); a 30s interval refused in the form.
  - Alerts: thresholds read, a 1-minute value refused, a change saved through `alerts.setConfig`, then
    restored to the previous value.
  - Phone width: the side pane from the header tabs, one pane at a time.

Not yet checkable live, waiting on Cedar: system participants in the registry (created at deploy, R1/R3),
inbox rows and marking them read (post() writes them in R1), alerts in the list (R4). The live
acceptance (`docs/04-capabilities.md` 6, 9, 11) covers them once those land.

Promotion for R1's API (Cedar's heads-up): the promote form now has an owner picker (people only, default
@lee) and sends `owner`, which today's `directory.promote` already accepts as an optional string, so it
works before and after R1. Reserved names are refused in the form. Failing tests first (58ece7d,
`view-tests-4-before.txt`); 19 of 19 pass. Live: `promote-check.mjs` → `live-r0/promote-output.txt` and
`7-promote-owner.png` (the owner list, and @reminders refused; nothing promoted).

## Against R1 (main 436b0f9)

`live-r1.mjs` → `live-r1/output.txt` (ALL PASS) and screenshots, on my dev server (3791) and the local
Convex:
- the registry lists @reminders and @alerts under System with no controls, and agents with their owner (@lee);
- @hazel-w promoted through the form with owner @lee, then retired at the end;
- `comms send --as hazel-w @owner …` → "→ @lee: in their inbox"; the title, the Inbox tab and the header
  pill go from 0 to 1 unread;
- opening the conversation from the Conversations list marks it read; a message arriving while it's open
  doesn't stay unread; clicking an unread inbox item opens its conversation and marks it read.
Web tests 19/19 and mod 44/44 pass on R1.
