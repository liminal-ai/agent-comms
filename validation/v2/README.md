# V2 port: live acceptance of the T3 adapter on orchestration protocol 2

Closeout docs/08 section 2, and the comms part of the acceptance in `/srv/work/t3code-v2-baseline/HANDOFF.txt`: dispatcher claim loss, concurrent human input, restart and interrupt, no double execution. Run 2026-10-03 from 03:16 UTC by Cedar.

## Pins and setup

- T3: stock `v0.0.46-nightly.20261003.2610` (8ed276c) on 127.0.0.1:13976, unit `t3code-v2-stock.service`, unmodified. Claude provider 2.1.288, model `claude-sonnet-4-6`.
- agent-comms: branch `cedar` from e5741d7 (adapter in `packages/adapter-t3/src/v2`, connector config `t3.protocol: 2`).
- A scratch Convex deployment (127.0.0.1:3214, its own state, admin token and machine `v2m`) and a separate connector (unit `cedar-v2-connector`, its own config and socket). The live Convex (3240), the live connector, 3773 and 3780 were not used.
- Synthetic participants: `@v2ann`, `@v2bob` (T3 threads in a synthetic project with a throwaway git fixture), `@v2cat` (T3, the first sender), `@v2req` (the sender from the rerun on; homed in Claude Code with no session, so its answers wake no thread), owner `@v2lee`.
- A bearer for 13976 was issued with `auth session issue --token-only` straight into a 0600 file (`~/.config/agent-comms/t3-13976.token`, label `agent-comms-v2-port`, 30 days); never printed.
- Scripts: `setup.ts` (project, threads, participants), `t3.ts` (a minimal protocol-2 RPC client), `lib.ts`, `scenarios.ts <name>`, `restart.ts`, `fix-cat.ts`. Results: `raw/results.jsonl`, one line per run; `raw/smoke-1.json`. No credentials and no user message text are kept (answers are clipped to 120 characters).

Found on 13976 before the run: an `/api/orchestration/*` request without `x-t3-orchestration-protocol: 2` gets HTTP 400; a missing thread is 404; a newly issued bearer works for HTTP and the WebSocket ticket.

## Results

"One message, one run" is counted from T3's own records: user messages with our id, and runs whose `userMessageId` is ours.

| Check | Scenario | Result |
|---|---|---|
| Plain request | `baseline`, smoke | `replied`; one message, one run |
| Thread busy with Lee's run | `busyThenOwn` | courtesy wait, then its own run; `replied` |
| Lee sends while ours runs (the composer's queue) | `queuedBehind` | Lee's message is its own run; ours `replied`, not ambiguous |
| Lee steers into our run | `steeredIn` | `ambiguous` (`t3-user-message`); nothing collected; the unmatched notice went in as its own run and the agent replied itself |
| Lee restarts our run with his message | `restartSteer` | T3 refuses `restart_active` for Claude ("Claude cannot redirect an active run. Stop it first, then send the message."): V2 behaviour, nothing to fix. Ours `replied` |
| Lee presses Stop | `liveInterrupt` | `failed` (aborted, "the run was interrupted"); nothing collected |
| Claim lost while waiting to send (2.2) | `claimLost`: connector A (8 s lease) claims and waits on a busy thread, is frozen past its lease, B takes over, A resumes | A: "claim lost to another holder; stopped", no dispatch. B: one dispatch, `replied`. One message, one run |
| Crash after T3 accepted, before `delivered` | `crashWindow` (`AGENT_COMMS_FAULT=crash-after-accept`) | state at the crash `claimed`; after restart, the check from one snapshot found the run completed: `replied`; one message, one run |
| Stop while the connector is down | `interruptRecovery`: connector SIGKILLed, run stopped, connector restarted | `failed` (aborted); nothing collected; one run |
| Run ends while the connector is down | `connectorRestart` | recovered from one snapshot: `replied`; one run |
| The conservative receipt rule | `receipt`: `@v2ann` runs `comms send @v2bob` from its shell (the one approved command) | the answer printed in the call (the agent quoted it), and again delivered into `@v2ann`'s thread as the fallback ("Already seen"). T3 strips command output, so the receipt can't be proven and the fallback stands |
| T3 restarts mid-run | `t3Restart` (`restart.ts`, via `bin/service stock restart`) | the connector's stream dropped and resubscribed with backoff; T3 came back and had **cancelled** the run (no provider recovery; automatic continuation is off): `failed` (aborted, "the run was cancelled"), nothing collected, one message, one run, no re-run |
| Repeated commandId across a T3 restart (Reed) | `commandIdAcrossRestart` | **persisted**. An accepted `message.dispatch` sent again after the restart with the same commandId returned its first sequence (1563) and added nothing (one message, one run); a rejected command sent again after the restart failed "Command … was previously rejected". The shell snapshot showed no active run outside the synthetic project before the restart |

Adapter change from the run (Reed): before retrying a dispatch with the same commandId, the adapter re-reads the thread; if our message is there it counts as sent, so no duplicate depends on T3's receipt store (`a030de9` test, `7bc5a09`).

## Void runs, kept for the record

The first fault batch (lines at 03:21–03:32) is contaminated and was rerun:

- `claimLost` (first): the CLI wrapper pinned the main socket, so the send to connector A failed; A was left running.
- `crashWindow` (first): A, still running, took the delivery; the fault-injected connector never crashed. Its line in `results.jsonl` is not a crash-window result.
- `interruptRecovery` (first): the fault-injected connector, still holding the socket, took this delivery and crashed after accept; recovery recorded `replied` (in effect a valid crash-window case, but not the scenario named).
- `connectorRestart` and `receipt` (first): the agents ran full-access; see the incident below.

## Incident: a full-access test agent acted on its own

`@v2ann` and `@v2bob` first ran full-access so they could run shell commands. In the first `connectorRestart`, `@v2bob` found the scratch socket gone and, unasked, read the scratch directory (the connector config and a scenario log; no secret files), listed the user's systemd units and ran `systemctl --user restart cedar-v2-faulty` (a scratch unit; it failed). Nothing live was touched: `agent-comms-connector` stayed up from 22:51 EDT, and nothing used 3240 or 3780.

Fixed for the rerun: every synthetic thread approval-required; long runs use text-only prompts; the harness (`approveOnly`) approves a command only if it is exactly the one the test asked for, and declines anything else; the sender has no T3 thread. Standing rule now in `docs/deploy-checklist.md` ("Testing against real harnesses").

Related: with `@v2cat` approval-required and as the sender, each answer delivered into its thread started a run that asked to read a file; they queued behind the first. `fix-cat.ts` interrupted them (never approving), and the rerun sends as `@v2req`.

## Findings

- `restart_active` is refused for Claude on V2 (above).
- Not V2-specific: an agent's explicit `comms reply` during the turn and the turn's collected final text both become answers to one request. Written up in `docs/finding-reply-then-collect.md` for Alder, Wrenn and Lee; no change in this port.

## Not covered here

The rest of the handoff's acceptance: the stock UI pass, LHC (Hazel, 13977), the combined comms + LHC run and the sustained multi-agent trial. The deployed connector stays on protocol 1 and 3780 until those pass.

## Rerun on the 2632 re-pin (docs/11 step 3)

2026-10-03 from 14:58 UTC: stock `v0.0.46-nightly.20261003.2632` (f391794a) on 13976 after Cedar's re-pin (`/srv/work/t3code-v2-baseline/HANDOFF.txt`), agent-comms main d87e55b+ (option A, both stream fixes, the reply race), scratch Convex 3214, same synthetic threads. Lines after the `marker` line in `raw/results.jsonl`.

The contract diff from 2610 to 2632 is additive (a `workStartedAt` field on runs, pull-request watch commands and events, one capability flag; the only removed line is a doc comment), and nothing the adapter reads or sends changed: no adapter change.

| Check | 2632 result |
|---|---|
| baseline, busy thread, Lee queues, claim loss, crash after accept, connector restart | `replied`; one message, one run each |
| Lee steers into our run | `ambiguous` (twice; see below) |
| restart_active | still refused for Claude; ours `replied` |
| Stop, and Stop while the connector is down | `failed` (aborted); nothing collected |
| receipt rule | the one exact command approved; the answer in the call and again as the fallback |
| option A, `replyDuring` | `replied` with the agent's `comms reply` only; the final text not collected |
| commandId across a T3 restart | still persisted: the accepted command returns its first sequence (2382) and adds nothing; the rejected one stays rejected |
| T3 restart mid-run | **changed from 2610:** the run now ends `failed` ("Provider turn failed.") instead of `cancelled`; we record `failed` (error), collect nothing, no re-run. Likely PR 15048's stuck-run handling; either way the outcome is right |

Harness notes: in the steer check the agent now often answers the original request with its own `comms reply` (the new delivery sentence tells it that's the answer). That command carries free text, which can't be matched exactly, so under the standing rule its approval is declined; `steeredIn` now declines it itself and waits for the thread to go idle (the first 2632 run left the thread blocked on the approval, so `restartSteer` failed on the idle wait and was rerun; the second `steeredIn` timed out on it and its outcome was recorded by hand, marked). The reply race has no live scenario: it needs a reply to land between T3 accepting and the `delivered` write, which the Convex tests cover in every ordering.
