# Capabilities fix pass: follow-up

Agreed by Lee, Alder, Wrenn and Reed in lhc-group, 2026-10-02, from the independent reviews of `b7b09da`. Reviews: Alder `/srv/work/research/agent-comms-capabilities-fix-review-alder-20261002/REPORT.txt`; Reed's and Wrenn's in the lhc-group thread. Reed's reproductions are in `/tmp/rv2-proof-19449` and `/tmp/rv2-rem-20974`; Alder's are listed in his report. No redesign. Sign-off holds until the targeted re-check passes; then real agents move.

**Rules:** a failing regression test committed on its own before each fix (use the reviewers' reproductions); raw output for the re-check under `validation/capabilities-fix/followup/`; report each step to Reed with `lhc-agent start reed`.

## Cedar

1. **Retry key through every transport failure** (`packages/comms-cli/src/cli.ts:185-200`). Once an attempt has hit a dropped connection, later "connector unreachable" errors are retried too, and whenever the CLI gives up it prints the `--key` line. Covers a connector that restarts and one that stays down.
2. **Alert scans and the resolve pass progress through all eligible rows** (`convex/lib/alerts.ts`). No restarting at the same first page: page with saved progress or re-check each incident from its own subject. Cases: 500 in-flight deliveries hiding a newer reclaimed one; 500 unresolved alerts blocking a 501st from resolving; a resolved connector incident not suppressing the next silence.
3. **Outages can't hide alerts.** Track what has been reported instead of a 1-hour age window, so an uncertain delivery or expired reminder found after a long outage still alerts once.
4. **Reminder processing stays within the transaction budget.** Many due or expiring reminders near the text cap (e.g. CJK) must not make the tick fail every minute; stop at a read budget and continue next tick. Test with convex-test's real limits.
5. **Inbox cursor handles identical timestamps** (`convex/inbox.ts`): an opaque cursor or a unique tie-breaker. Case: 100 notices posted in one tick, page size 50, all reachable; unread-only paging tested too.

## Hazel

6. **Open conversations mark new messages read past 100 messages** (`apps/web/src/App.tsx:300`): depend on the latest message id or sequence. Test a conversation beyond 100.
7. **The mod's helper-subagent test must be able to fail** (`packages/claude-code-mod/test/fix-pass-cap.test.ts`): removing the `agentId` exclusion has to fail it (see Reed's `rv2-helper.test.ts`).

## Docs (Cedar)

8. The protocol README says where session binding is checked (the connector's loopback, not Convex).
9. The evidence README says failure isolation is proven in convex-test, plus the live injected failure below.
10. T3's duplicate answers: T3 always falls back, so a T3 send-and-wait gets the answer in the call and again in its thread a few minutes later. Document it plainly in the usage text and README.

## Targeted re-check

Only these items, on the installed services unless noted:
- a connector-down-on-retry run against the installed CLI (connector killed mid-send and kept down; the key is printed; a rerun with it posts once);
- a live injected failure for reminder fire and report isolation;
- each regression above, at scale on a scratch deployment where it needs volume (never the live one).

Then Alder, Wrenn and Reed each verify these fixes independently, without reopening unrelated scope. The T3 receipt rule stays as is.
