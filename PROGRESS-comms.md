# Comms lane progress

Owner: Cedar. Plan: [docs/01-comms-lane.md](docs/01-comms-lane.md).

## M0: contract, CLI, stub
- [x] Workspace root: pnpm, Node 24 type stripping (erasable TS, `.ts` imports), `node --test`, `scripts/capped.sh` for memory-capped runs
- [x] `packages/protocol`: envelope, delivery, history bounding, renderer + header parser, loopback operations with request decoders and response types
- [x] `packages/protocol/README.md`: the contract in prose
- [x] `packages/connector-stub`: held polls, serial per participant, restart checks, persisted state, JSONL record, stub controls
- [x] `packages/comms-cli`: send, reply, read, list, status; `--as` falls back to `AGENT_COMMS_PARTICIPANT`; ~100 ms start
- [x] Tests: protocol 28, stub 19, CLI 10; walkthrough run live against the stub in a capped unit
- [ ] Hazel's review (02, part C): change requests land here

### M0 decisions to review
- Turn events are carried by `delivered`, `outcome` and `presence`; there's no separate turn-event op, so nothing about non-comms turns reaches the connector except idle/busy.
- The connector's restart questions to the mod travel as `check` items in poll responses (the mod has no server); answered with `check-result`.
- One delivery in flight per participant: the next is offered after the previous request is finished (or the previous answer delivered).
- Humans get no deliveries; they read in the web view.
- `comms reply` completes an `ambiguous` or `uncertain` delivery, not a still-running `delivered` one (whose own answer is still collected).
- `ambiguous` reports only the origins of what entered the turn, never its text.

## M1: Convex (local deployment)
- [x] Schema: participants, conversations, members, messages, deliveries, machines
- [x] `directory`: registerMachine, promote, rebind, setState (pause/resume/retire), list
- [x] `conversations`: createGroup, openDm, addMember, removeMember, postAs (people), list, view (with delivery states)
- [x] `connector`: work (subscription), claim/renew (lease + compare-and-set, takeover), delivered, collect, ambiguous, failed, uncertain, send, reply, read, list, homed, presence, heartbeat
- [x] Protocol errors thrown as `ConvexError {code, message}` so a failed check rolls back the mutation; the connector maps them to loopback errors
- [x] 23 convex-test tests: every transition, lease expiry and takeover, duplicate answers, answers never collected, retire/pause/rebind, read positions
- [x] Local anonymous deployment on port 3240/3241 (3210/3220 belong to other projects): `CONVEX_AGENT_MODE=anonymous npx convex dev --once` via `scripts/capped.sh`

### M1 decisions
- Dev auth: machine credential `{id, secret}` on every connector call (SHA-256 stored); admin token from the deployment env `COMMS_ADMIN_TOKEN` for the web view.
- The claim is held from `claimed` through `delivered` (so a takeover can still collect); cleared when finished. An answer's delivery finishes at `delivered`.
- New group members start with everything so far counted as read.

## M2: the connector
- [x] `packages/connector` (Effect 4.0.0-rc.115): server API over Convex, dispatcher, Claude Code sessions + adapter, loopback server, config, `comms-connector` entry point
- [x] Claims with lease, renewal, pre-handoff compare-and-set; recovery through adapter checks (never blind); claims only what can be handed over; serial per participant; writes retried through outages
- [x] 9 integration tests (convex-test + real socket + scripted mod), stable over repeated runs
- [x] Live smoke on lim-builder: real local Convex (3240) + real ConvexClient, request → mod → collected answer → answer delivered back
- [x] `scripts/dev-setup.ts`: registers a machine secret and promotes participants from a seed file (secrets read from files, never printed)

### M2 decisions
- Mod reports (`delivered`, `outcome`, `check-result`, `presence`) are acknowledged at once and written in the background; documented in the protocol. `answerMessageId` only when known.
- Any `unknown_session` answer means: register again, then retry the call (documented).
- After a connector restart, recovery waits for the old lease to expire (60 s default) before asking the session.

## M3: the T3 adapter
- [x] `packages/adapter-t3`: a T3 v0.0.44 client (fix pass 0.2: now vendored in `src/t3/wire.ts` on this repo's effect; no T3 checkout), promise API, no T3 or Effect types across the boundary
- [x] Deliver: courtesy wait for idle, `thread.turn.start` with message id `comms-<delivery id>`, the thread's own runtime and interaction modes (never forced full access), T3 rendering with source line
- [x] Match from T3's records. v0.0.44 user messages carry `turnId: null` (Hazel, live), so our turn is: the first turn-tagged message after ours, else the session's active turn, else the latest turn requested at our message's timestamp. Any other user message inside that turn's window → ambiguous (origin only, no text); final assistant message → answer; interrupted/error → failed; a stale `latestTurn` never ends our turn; a later turn starting does
- [x] Restart check: our message id in the whole thread → absent / running / completed with outcome
- [x] Connector loads it when the config lists `"adapters": ["t3"]` with a `t3` section (`baseUrl`, `authFile`)
- [x] 11 tests against a fake T3 (idle, busy wait, typed-into, raced steer, later turn, interrupt, error, stale latestTurn, refusals, idempotent handoff, restart check)
- [x] Hazel's API notes applied: interrupt = completed with `assistantMessageId: null` → failed (aborted); answer = `latestTurn.assistantMessageId`; `provider.turn.start.failed` for our message id → rejected; a latest turn requested after our message is never ours (measured: our turn's `requestedAt` equals our message's `createdAt`)
- [x] Live on 3780 (`validation/m3/`): all three providers answered and matched; busy thread waited then ran as its own turn; typed-in → ambiguous; interrupt → failed; connector SIGKILL mid-delivery → recovered, one run, one answer
- [x] Hazel's review: matching follows T3's event order (not client clocks, not "first output after ours"); a cursor saved with `delivered` lets a restart replay the events; snapshot fallback links only by `requestedAt`; mid-answer Claude interrupts detected by the session stopping right after; unmatched notice sent into the thread
- [x] Contract (Hazel's review): `failed` outcome may omit `turnId`; over-long answers clipped (`clipAnswer`), not refused; `check-result` completed may omit the outcome (answer deliveries); `renderUnmatchedNotice` / `parseNoticeHeader`; delivery `status.cursor`
- [ ] Presence from T3 session state (idle/busy)

## M4: the web view
- [x] `apps/web` (Vite + React + Convex subscriptions): directory with presence; promote a T3 thread or a Claude Code terminal; pause/resume/retire; conversations; create group; add/remove members; per-recipient delivery states with `uncertain` highlighted; posting as a person with @mentions (shows who will be woken)
- [x] Phone layout: one pane at a time
- [x] Checked headless (Chrome + Playwright) against the local deployment; screenshots in `validation/m4/`
- [x] Connector resets Claude Code participants' presence to offline at start (stale "idle" seen in the check)
- Reaching it from Lee's phone needs a reachable deployment: M6

## M5: first milestone (local)
- [x] All M5 checks pass live (`validation/m5/README.md`): agent-initiated `comms send` from a Codex thread answered by native Claude and delivered back, no loop; Lee's group post to two agents, both linked, third not woken; typed-in → ambiguous → notice → the agent's own `comms reply`; busy wait and kill recovery from `validation/m3`
- [x] `comms` on PATH for this machine's agents: `~/.local/bin/comms` → `/srv/work/agent-comms` (main)
- [x] Connector on the default socket from the main checkout (unit `cedar-connector-m5`)

## M6: integration, then the cloud checkpoint
- [x] Hazel's mod merged; every part-D check passes on the real connector (her VALIDATION.md)
- [x] Shared acceptance check (local): every item passes on T3 and Claude Code (`validation/acceptance/README.md`)
- [ ] Cloud checkpoint: needs Lee (cloud Convex project under his account; the second machine and access to it)

## Capabilities pass (docs/04-capabilities.md, draft 5)
- [x] R0 contract (`validation/capabilities/r0/`): protocol `capabilities.ts` (system kind, reserved names, registry entries, waits with per-recipient results, `CLI_EXIT`, reminders, alerts, inbox, durations); loopback ops `await`, `ack`, `message-status`, `agents`, `agents-set`, `remind`, `reminders`, `reminder`, `reminder-update`, `send` `wait`/`waitMs`; errors `unsupported` (501), `unknown_reminder`; reminder-fire, fallback, report, ended and alert renderings; README contract section
- [x] R0 Convex: schema (system kind, ownerId, description, duties, presence.idleSince, message meta, delivery claimCount and fallback; tables inbox, waits, waitResults, reminders, reminderFires, alerts, alertConfig); web functions registry.list/setProfile, inbox.list/unreadCount/markRead, reminders.list/get/create/update, alerts.list/config/setConfig; promotion refuses `system`; idleSince moves only on the transition to idle
- [x] R0 connector and stub answer the new ops `unsupported` until built; a waiting send is refused, never sent unwaited
- [ ] Hazel's R0 review
- [ ] R1 registry, ownerId migration, reserved names, @owner, inbox
- [ ] R2 send-and-wait
- [ ] R3 reminders
- [ ] R4 alerts

### R0 decisions to review
- A wait result has a sixth state, `ended` (delivery failed or uncertain, or the recipient retired): the brief lists five, but "failed or uncertain: the wait ends for that recipient" needs a state that isn't `expired`.
- Wait results are their own table (`waitResults`) so the fallback pass can index answered results by age, and each compare-and-set touches one row.
- Exit 5 (`endedWithoutAnswer`) is separate from 4 (`pending`): "no answer is coming" vs "not yet".
- The web view creates reminders as a person (`reminders.create` takes `as`); the CLI creates them as the calling agent.
- `DEFAULT_WAIT_MS` is 100 s until Hazel's H0 numbers.
