# Capabilities R2: send-and-wait

| File | What |
|---|---|
| `convex-before.journal.txt` | 14 Convex tests failing before the behaviour: registering a wait, people in inbox, nobody to wait for, idempotent replay, the busy-waiting rule (and that an answered or past-`until` wait isn't busy), taking the answer in the collecting mutation (never pending, never in the work query), group waits, ambiguous then `comms reply`, failed / uncertain / retired → `ended`, answers after `until` or with no CLI awaiting → thread, ack only in the same busy stretch (idle, later turn, stale all ignored), exactly one fallback rendered as possibly seen, expiry and retention, `message-status` |
| `connector-cli-before.journal.txt` | 5 end-to-end tests (the real CLI, the connector, a scripted mod, convex-test) failing |
| `cli-stub-before.journal.txt` | the old CLI tests failing once `comms send` waits by default against a connector that can't (the stub); fixed by sending unwaited and saying so |
| `after.journal.txt` | all passing |
| `pnpm-check.journal.txt` | whole repo: exit 0, 85 vitest tests plus every node suite |
| `live-smoke.journal.txt` | on the installed services: `comms send --as cedar-demo --wait 90s @t3-native …` returned "pong" in the call, exit 0; `comms status` shows it; @cedar-demo has no live thread, so its ack didn't count, and after the window the result fell back once |

The full live acceptance (items 2-8 of the brief, with term-a) is joint with Hazel.
