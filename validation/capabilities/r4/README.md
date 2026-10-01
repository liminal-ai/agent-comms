# Capabilities R4: alerts

| File | What |
|---|---|
| `convex-before.journal.txt` | 5 Convex tests failing before the behaviour: an uncertain delivery alerts once with its conversation and resolves when completed; a silent connector alerts once per incident (down, recovered, down: two); a reminder blocked past the threshold alerts and resolves on resume; an expiry alerts once; claims are counted and too many alert; retired agents raise nothing; no system participant gets a delivery |
| `after.journal.txt` | all passing |
| `pnpm-check.journal.txt` | whole repo: exit 0 (99 vitest tests plus every node suite) |
| `live-preview.journal.txt` | before deploying: the live data would raise nothing (no uncertain deliveries, the one machine heard from, no claim counts yet) |

The live alert checks (a stopped connector, an injected uncertain delivery; acceptance item 11) are joint with Hazel: stopping the installed connector for 10 minutes is a service interruption to schedule.
