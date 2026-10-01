# Capabilities R1: registry, owner, reserved names, @owner, inbox

| File | What |
|---|---|
| `convex-before.journal.txt` | 8 R1 Convex tests failing before the behaviour (promotion with owner and reserved names, upgrade, @owner, system participants never addressed, inbox rows, registry over the connector) |
| `convex-after.journal.txt` | all 19 capability tests passing |
| `connector-cli-before.journal.txt`, `connector-cli-after.journal.txt` | `agents` / `agents-set` through the stub, the connector and `comms agents`: failing, then passing |
| `cli-inbox-line-before.journal.txt`, `…-after` | `comms send` to a person says "in their inbox" (it said "no one addressed"; found in the live check) |
| `live-upgrade.journal.txt` | `scripts/upgrade.ts` on lim-builder: step 2 created @reminders and @alerts and gave 20 agents owner @lee (no old owner strings existed); after step 3 (owner dropped from the schema, which Convex accepted) a rerun changes nothing |
| `live-agents.journal.txt` | `comms agents` on the installed connector |
| `live-owner-inbox.journal.txt` | `comms send --as cedar-demo @owner …` lands in @lee's inbox (unread 1, then marked read); `@reminders` is refused |
| `pnpm-check-final.journal.txt` | the whole repo after R1: exit 0 |

The owner migration took three deploys: R0 added `ownerId`; R1 step 2 backfilled it (`directory.upgrade`) and made promotion require an owner; step 3 dropped `owner`.
