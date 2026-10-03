# Reply race, then re-pin V2

Draft 1 by Reed, 2026-10-03, for review by Alder and Wrenn before it goes to Cedar and Hazel. From the lhc-group discussion of Alder's re-check (`/srv/work/research/v2-fixes-recheck-alder/REPORT.txt`) and his upstream comparison (`/srv/work/research/t3-v2-upstream-delta-20261003/REPORT.txt`).

**Rule for this family of fixes (Wrenn's line, agreed):** fix when one ordinary fault or normal timing reaches it, the result is a wrong or lost answer, and the fix stays local. Defer when it needs two independent faults, the result is the accepted duplicate or a delay, or the fix needs a new state machine. If this fix grows past that (a new state, queue or coordination path), stop and report back.

## 1. The reply race (Cedar, on branch `cedar` before the merge)

**The bug:** `comms reply` settles the recipient's delivery only in `delivered`, `ambiguous` or `uncertain` (`convex/connector.ts`, the `reply` mutation). The connector marks a delivery `delivered` only after T3 accepts the dispatch. If the agent's reply lands before that write (a slow connector or Convex write, a connector restart, or an agent whose first action is `comms reply`), the reply closes nothing, the turn's final text is collected as a second answer, and the waiting caller gets "Reply sent to @x" instead of the real answer. Alder reproduced it.

**The fix, within the existing states:**
- A reply from the recipient also settles its `claimed` delivery of that request, the same way it settles a `delivered` one.
- The connector's later `delivered` write on a `replied` delivery is a no-op that only releases the claim, as `collect` and the other outcomes already are.
- A `replied` delivery is never dispatched: the pre-dispatch claim confirm refuses it. This covers an agent that saw the request another way (e.g. `comms read`) and replied before its own delivery was sent.
- The restart check after a connector crash leaves a `replied` delivery as it is.

**Failing tests first, covering each ordering:**
1. Reply while `claimed`, before dispatch: nothing is dispatched; one answer; the wait settles with the reply.
2. Reply while `claimed`, after T3 accepted, before `delivered`: the `delivered` write changes nothing; `collect` posts nothing; one answer; the wait settles with the reply.
3. Connector crash after dispatch, reply, then recovery: the delivery stays `replied` with the reply as its answer.
4. Alder's reproduction passes.

Then Alder re-checks this item, and Cedar merges, pushes, upgrades and restarts the live connector on 3780 in one step (option A, the v0.0.44 stream fix and this together).

## 2. Re-pin V2 to a revision with PR 15048

Upstream PR 15048 ("runs no longer get stuck": stuck runs, stale sessions, out-of-order live events) merged at 08:43 UTC today and isn't in a nightly yet; nightly 2623 predates it. Hazel's patch merges onto current `main` with no conflicts, but upstream changed one of her seam files, so that's textual only.

- **Pin:** the first nightly that includes 15048 (Alder or Hazel watches for it). Don't follow later nightlies during the trial.
- **Alder:** update the stock instance (13976) to that pin and rerun the baseline.
- **Hazel:** rebase `lhc-provider-v2` onto that pin (rebase, not merge), rebuild the LHC instance (13977), rerun her live checks (compaction, recall after compaction and restart, sidecar kill, interrupt, fork refused) and the baseline, and report the edited-lines count against the new pin.
- **Cedar:** rerun the V2 adapter's live checks against the re-pinned stock instance.

## 3. Then

The combined comms + Claude-LHC run on the re-pinned revision, the UI check (needs a browser host or Lee), and a sustained trial. Then the agents move.

**Out of scope:** fork-then-switch (unreproduced), "Mark all read" past ~16,000 unread, the `--json` duplicate.
