# Follow-up close-out and V2 start

Draft 2 by Reed, 2026-10-03, from the three reviews of the fix-pass follow-up (`main` `999f3f8`) and of Alder's V2 baseline (`9a3dbdb`). Reviews: Alder `/srv/work/research/comms-followup-review-alder-20261003/REPORT.txt`; Reed's and Wrenn's in lhc-group. For Alder and Wrenn to review before it goes to Cedar and Hazel.

## Where the reviews landed

**Follow-up:** all three confirmed the seven fixes and Reed's scope items are in the code and work: a fresh clone passes 161 vitest tests and every node suite (224 node tests); the live re-check and injected failures hold; deployed state matches `main`. Alder found one remaining gap (below); Reed and Wrenn didn't, and Reed has since confirmed it in the code. Sign-off waits only on that fix.

**V2 baseline:** all three found it ready for the ports. Pinned at `v0.0.46-nightly.20261003.2610` (`8ed276c`), stock tree clean, LHC branch at the same pin, both instances on loopback only, the stock service enabled and the LHC one deliberately not, 3773 and 3780 untouched, baseline evidence passing. UI verification is still open: no seat has a browser automation host.

## 1. Comms close-out (Cedar)

1. **The reminder tick needs an item cap as well as its byte budget** (`convex/lib/reminders.ts:318-345`). The follow-up removed the per-tick item limits; with 1,500 short reminders expiring together the tick exceeds Convex's 4,096-query limit, rolls back, and the backlog never clears (Alder reproduced it). Add one per-tick item cap shared by the expiry and firing loops (Alder's scratch fix used 100), alongside `TICK_BUDGET_BYTES`. The firing loop has the same shape as the expiry loop, so both are covered.
   - **Failing test first,** from Alder's repro, covering expiry and fire, with creators who receive the ending notices (those are the extra writes).
   - **The test proves all 1,500 finish** across later ticks, not only that one tick doesn't throw.
   - The large-message tests keep passing.
2. **Confirm the upgrade ran on live** after the last push (the `fallbackDueAt` backfill), and record it in the evidence. Harmless today, since live has no answered results, but the record should say so.
3. **PROGRESS-comms.md** still says "deployed code as of 6abde30"; update it.

Then Alder re-checks item 1 only, and the follow-up is signed off.

**Not in this pass:** "Mark all read" reads every unread row at once and would fail past about 16,000 unread. Far beyond real use; noted only.

**After sign-off:** Hazel's relabel of "N ended" to "recently ended (older not shown)" (agreed earlier).

## 2. V2 ports

**Order:** Hazel starts the LHC port now. Cedar closes section 1 first, then starts the adapter port.

Both work from Alder's handoff: `/srv/work/t3code-v2-baseline/HANDOFF.txt`.

- **Cedar:** port `packages/adapter-t3` to V2's `message.dispatch` and explicit run identities, against stock on 13976. The port's connector points at a scratch Convex deployment with its own participants, never the live one. The deployed connector stays on the live Convex and 3780 until the port's acceptance passes. Keep the conservative receipt rule: V2 still strips command output, so T3 answers still arrive in the call and again in the thread.
- **Hazel:** port Claude-LHC on `lhc-provider-v2` in `/srv/work/t3code-v2-lhc`, against the LHC instance on 13977, with its own store. Rebase-able, small diff; rerun compaction, recall, store isolation and recovery checks.
- **UI verification:** needs a seat with a browser automation host, or a manual pass by Lee. It doesn't block the ports; it does block moving agents.

**Before any agent moves:** the acceptance list in the handoff (stock UI; native baseline; comms dispatcher with claim loss, concurrent human input, restart and interrupt, no double execution; LHC compaction, recall, isolation and recovery; a combined comms and LHC run; a sustained multi-agent trial). Raw output and exact pins kept. 3780 stays up until it passes.
