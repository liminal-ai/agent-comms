# Fix pass 1

For Cedar and Hazel. Draft 2 by Reed, 2026-09-30 (Alder's and Wrenn's edits in), from three independent reviews of `main` at `9de3a0c` and Hazel's T3 branch `lhc-provider` at `4e38dbdac2`:

- Reed: `/srv/work/research/agent-comms-review-20260930/REPORT.md`
- Wrenn: `~/.local/state/lhc-campaigns/agent-comms-review-wrenn-20260930/`
- Alder: posted in lhc-group, 2026-09-30 (17 items, 11 reproduced in isolated probes)

Reviewers: Alder (scope), Wrenn (references; re-tests the adapter and mod fixes live).

**Verdict of all three reviews.** The design holds and the local acceptance check really passed on normal flows. It is not ready for real agents: the reply-matching rule ("never guessed") fails in edge cases that can send the wrong answer, or leak what Lee typed, to a requester; recovery can run a delivery twice; and the evidence doesn't cover the crash window or concurrent input. One fix pass, no redesign.

## Rules for this pass

- **A failing test before each fix** in sections 1 and 2: reproduce the failure, commit the test, then fix. Name the test after the item number.
- **Uncertainty stops automatic retries.** Wherever we can't prove what the harness did, the delivery goes to `uncertain` and nothing re-runs it automatically. Don't promise "never runs twice"; promise "never re-runs when it can't tell".
- Read the reviewers' reports for each item's file:line and repro. Wrenn checks references against source before you start.
- Ownership is unchanged: Cedar owns `packages/protocol`, the repo root, Convex, connector, adapter-t3, CLI, stub, web. Hazel owns `packages/claude-code-mod` and the T3 checkout. Cross-boundary changes go through the owner.
- Progress in your lane's progress file; report each section's completion to Reed by relay.
- Not in this pass: redesign, queues, cloud, Slack/iMessage, `origin.externalId` (waits for the channels), splitting old commits.

## 0. Before anything else (Cedar)

0.1 **Bind local Convex to 127.0.0.1** (both 3240 and 3241). It currently listens on `0.0.0.0`. Do this now.
0.2 **A fresh clone must install, typecheck and test with no builder's folder.** Today the connector typechecks only after `link-deps.sh` symlinks T3 client packages from `/srv/agents/hazel/t3code-v044`, an undocumented step, and the running connector depends on that folder. Prefer vendoring the few T3 contract schemas the adapter needs, with the T3 tag and commit they came from recorded, over depending on a T3 checkout (which moves with T3 and drags in its whole Effect tree). If T3's RPC client itself can't reasonably be vendored, depend on a fixed, documented copy inside the repo's control, never a builder's folder. Document the choice in the README. Gate: `git clone` → `pnpm install` → `pnpm check` passes on a scratch copy. Cedar does the rest of the pass on that basis.

## 1. Correctness: reply ownership and privacy

**T3 adapter (Cedar)**
1.1 **Foreign input before ours.** `model.ts:153-164` counts foreign user messages only after ours. A message appended between the idle snapshot and our send (e.g. the web UI's queued message flushing on the same `ready`) leaves `foreign=0`, and Lee's turn is taken as ours. Count foreign messages from the pre-send snapshot sequence; if any landed before ours with no turn started in between, the delivery is `ambiguous`.
1.2 **A background turn mistaken for ours.** `model.ts:139`: a Claude turn with no user message starting between our message and our turn is linked as ours. Link only a turn whose start follows our message with nothing else in between; otherwise `ambiguous`.
1.3 **Recovery without full events is `uncertain`, never collected.** `adapter.ts:211-219`: the snapshot fallback collects with `foreign: 0` and trusts `requestedAt` (which T3 can carry over from another turn), and the restart check ignores the interrupt signal, so an interrupted turn's partial answer is collected. If replay doesn't cover our turn from before our message to its end, report `uncertain`. Never collect an interrupted turn.
1.4 **Turn state after a later turn starts.** `adapter.ts:163-164` defaults to `completed` when `latestTurn` is someone else's, which can return an earlier commentary message. Read our turn's own end state; if it can't be read, `uncertain`.

**Mod (Hazel)**
1.5 **Link notifications by identity only.** Delete the count netting at `tracker.ts:224` (foreign = notifications − linked rows). Each notification entering our turn is ours only if its `toolUseId` or task id is one our turn produced; everything else is other input.
1.6 **Only helpers our turn started.** `tracker.ts:143-144, 167-170, 194-195` credit any subagent seen during our turn, including one Lee started earlier. Take subagent ids only from Agent/`agent.spawn` calls whose `tool_use_id` is in our main-turn tool calls, and their descendants.
1.7 **Remove the queued-prompt guess.** `tracker.ts:113` reclassifies typed input as queued if a turn within 3 s contains its text (Alder reproduced `yes` vs `yesterday`). Hazel's validation shows typed text always enters the running turn on 2.1.286. Composer, peer, bridge or SDK input carrying our `turnId` is other input, full stop.
1.8 **Journal safety.** `mod.ts:417`: a failed journal write is logged and the prompt is still submitted; a replacement session can then answer the restart check with "never arrived". If the journal write fails, don't submit; report `failed`. The restart check never answers `absent` from a transcript that may have been compacted; it answers `unknown`.
1.9 **More than 50 entered inputs** (`tracker.ts:224`; the limit is `packages/protocol/src/loopback.ts:178`): a report over the limit is silently dropped. Truncate with a count, or report `ambiguous` with a summary; never drop.

**Protocol (Cedar)**
1.10 **Size cap.** Request text is injected unclipped (`render.ts:93-95`); Alder injected over 50,000 tokens. Cap message text at send (Convex rejects over the cap with a clear error), and cap the **whole rendered delivery** (message, history, title, attachment references and framing together), so several individually valid fields can't add up to an oversized injection. Record both caps in the protocol.
1.11 **Lone CR (defensive).** `quote` and the parser both split on `\r?\n` (`render.ts:164`, `:31`), so a lone `\r` only forges a header if the harness normalizes line endings before `turn.start`, which nobody has checked. The fix is cheap: treat `\r`, U+2028 and U+2029 as line breaks in `quote`. The test asserts the parser on the raw text and on the normalized text.

## 2. Correctness: one executor and lifecycle (Cedar)

2.1 **Recovery reads current state.** `dispatcher.ts:181` decides `wasDelivered` from the snapshot held since the claim, so after `markDelivered` and a `lost` outcome an `absent` check re-runs the delivery. Use the delivery's current state.
2.2 **Losing the claim cancels the send.** `connector/src/t3.ts` wraps adapter calls in `Effect.promise`; the fiber is interrupted on claim loss, but the underlying promises ignore cancellation, so a waiting T3 injection still sends after another connector takes over. Make handoff abortable, and re-check the claim inside the adapter immediately before dispatching to T3.
2.3 **Connection loss isn't rejection.** `adapter-t3/src/t3/client.ts:131` and `adapter.ts:202`: a dropped connection during turn start is recorded `failed` though T3 may have accepted it. A definite refusal is `failed`: an RPC error response from T3 (e.g. thread archived) or `provider.turn.start.failed` for our message id. A transport error (socket close, timeout, no response) goes to recovery, which checks the thread for our message; only if recovery can't establish what happened is it `uncertain`.
2.4 **Retire and remove mid-request.** `convex/lib/post.ts:23-28`: collecting the answer of an agent retired or removed from the group fails, and the delivery is stuck in `delivered` and re-claimed forever. Let an in-flight delivery's answer post, or mark it `failed` with a reason; either way it ends. Fix the comment at `convex/directory.ts:72` to match.
2.5 **Rebind mid-request.** Recovery after a rebind checks the new home, finds nothing and can re-run. Record the target home on the delivery **before** handing it to the harness (recording it after leaves the same crash window), keep it through a rebind, and recover against it; if that home is gone, `uncertain`.
2.6 **Answer deliveries pile up.** The Convex `work` query (`convex/connector.ts:92-95`) re-reads every finished answer delivery on each `work` run. Move them to a final state or index them out.

## 3. Reliable local operation

**Cedar**
3.1 Timeouts: T3 `ready` off the main dispatcher loop (`dispatcher.ts:273`); Claude Code handoff/check deadline (`claude-code.ts:271-309`); CLI `send` idempotency key so an `unavailable` timeout followed by a later post can't double-send on retry.
3.2 T3 subscription: retry a failed resubscribe, and handle a snapshot response after a gap (`adapter.ts:124-129, 274`); `later` escalates to `uncertain` after a bound.
3.3 Subscription leak for answer deliveries (`adapter.ts:263`); superseded sessions freed (`claude-code.ts:205`).
3.4 Presence: mark stale when Convex writes have been failing; add a **"mod not connected"** state for a promoted terminal participant that has no registered session (absence alone doesn't prove the mod failed to load). Show it in the web view distinctly from "offline".
3.5 Web: the send form locks while sending and only clears the text it sent (`App.tsx:295`). A DM with no @mention either addresses the other member by default or says that nobody will be woken.
3.6 Secrets: never log Convex error text that may echo arguments (`server-api.ts:206`); constant-time admin token compare (`convex/lib/core.ts:53`).
3.7 Stub: set attachments before handing out a delivery (`connector-stub/src/state.ts:567, 583`). CLI: accept message text starting with `-` and document `--`.

**Hazel**
3.8 Mod: timeout on every connector call (`register.ts:46`, `mod.ts:154-167`), so a hung connector can't stop polling silently or block session exit. A deadline on a `submitted` delivery that never starts, but the deadline must not allow a late, untracked run: if the queued prompt can still start afterwards, keep tracking it (and report it if it does start), or cancel it and confirm the cancel. Just marking it failed isn't enough.
3.8a Mod: the follow-up note (`mod.ts:435-442`) says "your reply was already sent" whatever happened; word it from the delivery's actual outcome.
3.9 Mod journal and log files mode 0600 (they hold typed text).
3.10 Mod README: what Lee sees when the mod isn't connected; "start promoted terminals in their own folder, never in an agent's home".
3.11 T3: the server sets the Claude-LHC store from `T3CODE_HOME` (e.g. `$T3CODE_HOME-lhc` or a subfolder) instead of relying on the unit's `T3CODE_LHC_HOME`; `run-3780.sh` refuses to start if `T3CODE_HOME` is empty. A bare start must never touch `~/.t3code-lhc`.
3.12 T3: Claude-LHC settings validation: allow the documented ~80k rebuilt view, reject empty values, reject a rebuilt view at or above the trigger (`settings.ts:637, 705-716`).
3.13 T3: a missing custom-named LHC instance must not fall back to native (`ChatView.logic.ts:561`).
3.14 T3: commit the sidecar lock with its integrity hashes; check the staged sidecar version at server start, not only at staging.
3.15 T3: tests for "unavailable" reporting and the rollback flag mirror; captured typecheck/test output in `validation/`.

## 4. Real installation (Cedar for the connector, Hazel for the terminal)

4.1 The connector runs as a proper `systemd --user` service from `main` in `/srv/work/agent-comms`, with config outside any builder's folder. Retire the M5 smoke unit.
4.2 One real terminal, by the documented procedure only: mod installed through `claude plugin marketplace add` and `claude plugin install`, the mods flag in user settings, promoted from the web view, started in its own folder. Write the procedure in the mod README as executed.

## 5. Independent acceptance (Cedar and Hazel together; Wrenn re-tests)

Rerun the eight shared checks on the real installation from section 4, plus:

- **First: the dispatcher with the real T3 adapter.** Today the T3 adapter is never exercised through the dispatcher; the crash-window and claim-loss checks only mean something on that path. Include a claim lost while a T3 send is waiting (2.2).

- **Crash in the window that matters:** kill the connector after the harness accepted our message but before `delivered` is recorded, on T3 and on Claude Code. Expected: `delivered` or `uncertain`, never a second run. Count turns, not messages.
- **Concurrent input:** Lee's queued web message flushing at the same `ready` as our send (1.1); a background helper started before our request finishing during it (1.6); typed text during our turn (1.7).
- **Recovery after an interrupt** mid-stream: `uncertain` or `failed`, never a partial answer collected.
- **Retire, remove and rebind** with a request in flight.
- **Oversize request** rejected with a clear error.
- **Ten requests on Opus and Sonnet against the real connector,** with the model's view captured inside Claude Code's plugin wrapper.
- **The web workflow** end to end: promote, group, post, delivery states, "mod not connected".

**Evidence:** run in isolated test conversations and threads made for the purpose. Commit raw output for every check, with credentials and unrelated private content removed but every event needed to reproduce the result kept: script output, a Convex dump scoped to the run, connector decision logs, mod logs, T3 event recordings. Counts in the write-up are computed from those files, for this run only. Prose without a file behind it doesn't count.

## Done means

All of sections 0-5 committed on `main`, the evidence in `validation/fix-pass-1/`, Wrenn's live re-test of the adapter and mod fixes passed, Alder's scope check passed, and Reed's report to Lee. Only then do real agents move onto comms.
