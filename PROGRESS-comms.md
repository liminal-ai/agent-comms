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

## Later
M2 connector · M3 T3 adapter · M4 web · M5 local milestone · M6 integration and cloud
