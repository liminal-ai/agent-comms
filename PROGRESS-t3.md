# PROGRESS: T3 lane (Hazel)

## Part A: clean T3 v0.0.44 + claude-lhc — done 2026-09-30

- Checkout `/srv/agents/hazel/t3code-v044`, branch `lhc-provider` on upstream `v0.0.44`.
  Patch inventory: `LHC-PATCH.md` there; review with `git diff v0.0.44 lhc-provider`.
- Sidecar: npm `claude-lhc@0.1.1` (pin `lhc/sidecar.json`, staged by `lhc/stage-sidecar.sh`).
- Service: `t3code-3780.service` (user unit, `MemoryMax=6G`), `http://127.0.0.1:3780`,
  `T3CODE_HOME=~/.t3code-v044`, LHC store `~/.t3code-v044-lhc`. 3773 untouched.
- Validation (`validation/README.md` in the checkout): typecheck and lint clean, focused tests pass;
  live native Claude, Claude-LHC and Codex turns; LHC manual and auto compaction (trigger fitted to
  the model window), planted fact recalled after compaction.
- Handoff to Cedar: base URL, auth, test thread ids (below).

### For Cedar
- Base URL `http://127.0.0.1:3780` (loopback only), WebSocket at `/ws?wsTicket=…`.
- Auth: long-lived bearer (365 days, label `agent-comms-connector`) in
  `~/.config/agent-comms/t3-3780.token` (0600, one line). Exchange it for a websocket ticket with
  `POST /api/auth/websocket-ticket` (`resolveRemoteWebSocketConnectionUrl` in
  `@t3tools/client-runtime/authorization` does this). Never log the token or the ticket URL.
  Mint another: `node apps/server/dist/bin.mjs auth session issue --base-dir ~/.t3code-v044 --ttl 365d --label <l> --token-only > <0600 file>`.
- Test threads (project `proj-bacff64b-618b-40a7-87c1-8b89205d3d9e`):
  native Claude `thr-2b9246c9-4806-4d5d-bff5-3dca6ede7d49`,
  Claude-LHC `thr-36b7d422-6756-4668-b4fa-96e40d3679b6`,
  Codex `thr-abad70c6-298e-445d-9570-aae607cea3fb`.
- Working reference client: `validation/probe/{t3.ts,cli.ts}` in the checkout.

## Part B: T3 API notes — done 2026-09-30

- `docs/t3-api-notes.md`: auth (long-lived bearer via `auth session issue`), methods (WS and HTTP),
  the event sequence of a turn, busy-thread `thread.turn.start` (steers on all three providers),
  UI typing (default queue mode steers at the next tool completion), interrupt (looks completed;
  steered message dropped), Claude turns with no user message, restart lookup, gaps.
- Corrections to the plan: user `message-sent` carries `turnId: null`; an interrupt is not visible
  as such on the stream.

## Part C: review M0 — not started
## Part D: Claude Code mod — not started
