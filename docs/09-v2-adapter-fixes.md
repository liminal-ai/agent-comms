# V2 adapter fixes, before the combined run

Agreed by Lee, Alder, Wrenn and Reed in lhc-group, 2026-10-03, from the reviews of the V2 ports (`agent-comms` `631e2a2`, `lhc-provider-v2` `72f59957`). Alder's review and reproductions: `/srv/work/research/v2-ports-review-alder-20261003/`. Owner: Cedar. Hazel's LHC patch needs no change.

**Rules:** failing test committed on its own before each fix (use Alder's repros); full check; raw output under `validation/v2/fixes/`; report each step to Reed with `lhc-agent start reed`. Work on the scratch Convex (3214) and stock V2 (13976) only. The live connector stays on 3780.

## Fixes

1. **P1: re-check the claim before every dispatch** (`packages/adapter-t3/src/v2/adapter.ts`, `send()` and `handOff`). The claim is confirmed once before the first attempt; the retry inside `send()` never re-checks it, so a delivery can be dispatched after its claim was lost (Alder reproduced it). Confirm ownership before each fresh dispatch, including the retry; if it's lost, abort without sending. Check whether the v0.0.44 adapter has the same gap, and fix it there too if so.
2. **P2: the stream outage timer resets only after a successful sync** (`follow()`, `resubscribe`). Today `downSince` is cleared when `subscribe` resolves, before the replacement stream has delivered a snapshot or `synchronized`. Repeated failed reconnects keep resetting it, so `streamDownLimitMs` never triggers recovery (Alder: 35 reconnects, no recovery). Clear it only on `synchronized` (or a loaded snapshot), and back off failed streams.
3. **Cap the courtesy idle wait before dispatch** (`handOff`, the `f.wait(... !tracker.busy ...)`). It has no limit; V2 queues our message as its own run anyway, so a long-busy thread just churns claims. Cap it (a minute or two), then dispatch.
4. **Option A: an explicit `comms reply` settles the request** (Convex reply/collect path; see `docs/finding-reply-then-collect.md`). When the agent answers a delivered request with `comms reply`, that reply completes the delivery as `replied` and settles any wait. The turn's later final text is not collected as a second answer; it stays in the agent's transcript. A later outcome must not reopen, overwrite or post on an already-replied delivery. Applies to the live connector on 3780 too, not only V2.
5. **Document the `waiting` settle.** The 30-second `waitingSettleMs` heuristic: say what it is and why, in the adapter notes.

## Then

- Alder re-checks items 1–4 against his reproductions.
- Combined comms + Claude-LHC run on V2 (Cedar's connector against Hazel's LHC instance on 13977), the UI check (needs a browser host or Lee), and a sustained trial. Then agents move.

**Not in this pass:** the fork-then-switch edge. Unproven: someone reproduces it first, then we decide.
