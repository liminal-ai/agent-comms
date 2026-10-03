# Follow-up close-out (docs/08-followup-closeout.md), section 1

| Item | Evidence |
|---|---|
| 1. One shared per-tick item cap | `before.journal.txt`: Alder's repro as two tests (1,500 short reminders expiring together, and 1,500 due together, made half by people and half by agents so the ending notices are written), failing with "Too many index ranges read (limit: 4096)". `after.journal.txt`: with a cap of 100 items per tick shared by both loops (beside the 6 MiB byte budget), every one of the 1,500 finishes across later ticks (all 1,500 ending notices written), and the four large-text tests still pass. `pnpm-check.journal.txt`: whole repo, exit 0, 163 vitest tests |
| 2. The upgrade on live | `live-upgrade.journal.txt`: the push of 2b7cda5 and `scripts/upgrade.ts` right after it, run twice: the history migration was already done; the fallback-due backfill set 0 (live has no answered results). The previous push's run is noted there too |
| 3. PROGRESS-comms.md | updated |
