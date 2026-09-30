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
- [x] `packages/adapter-t3`: T3's own client runtime (linked read-only from a v0.0.44 checkout by `link-deps.sh` into `src/t3/node_modules`), promise API, no T3 or Effect types across the boundary
- [x] Deliver: courtesy wait for idle, `thread.turn.start` with message id `comms-<delivery id>`, the thread's own runtime and interaction modes (never forced full access), T3 rendering with source line
- [x] Match from T3's records. v0.0.44 user messages carry `turnId: null` (Hazel, live), so our turn is: the first turn-tagged message after ours, else the session's active turn, else the latest turn requested at our message's timestamp. Any other user message inside that turn's window → ambiguous (origin only, no text); final assistant message → answer; interrupted/error → failed; a stale `latestTurn` never ends our turn; a later turn starting does
- [ ] Confirm the turn-linking rule against Hazel's `docs/t3-api-notes.md` event sequence (especially typed-in and steered messages per provider)
- [x] Restart check: our message id in the whole thread → absent / running / completed with outcome
- [x] Connector loads it when the config lists `"adapters": ["t3"]` with a `t3` section (`baseUrl`, `authFile`)
- [x] 11 tests against a fake T3 (idle, busy wait, typed-into, raced steer, later turn, interrupt, error, stale latestTurn, refusals, idempotent handoff, restart check)
- [ ] Live against Hazel's T3 on 3780: needs her handoff (base URL, how to get a bearer, test thread ids) and her API notes to confirm busy-thread and typed-in behavior per provider
- [ ] Presence from T3 session state (idle/busy)

## Later
M4 web · M5 local milestone · M6 integration and cloud
