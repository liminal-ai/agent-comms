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

## Part C: review M0 — sent 2026-09-30 (relay job fec293ed to Cedar)

M0 was committed (with M1-M3). Change requests sent to Cedar:
- T3 adapter: link via `latestTurn.requestedAt === our createdAt` (verified live); drop the
  "first output after ours" rule (Claude starts turns with no user message; interrupted Claude
  turns have no answer); detect foreign input from event order, not client-clock `createdAt`;
  interrupts show as `completed`; web queue mode steers at the next tool completion.
- Contract: `outcome failed/rejected` without `turnId` (a dropped plugin prompt has no turn);
  clip over-long answers instead of `bad_request`; `check-result found:yes completed` without
  an outcome for answer deliveries. Question: how a T3 agent learns it must `comms reply`.
- Awaiting Cedar's decisions; Part D proceeds on the current contract.

## Part D: Claude Code mod — acceptance against the stub done 2026-09-30

- `packages/claude-code-mod` (commits b06bbb9, 021f3aa, db880b6, 8a46f6a). README and
  VALIDATION.md there.
- Every acceptance check in 02 part D passed live on Claude Code 2.1.286 against the stub (Sonnet,
  and Opus for the ten requests), plus Claude Code ↔ Claude Code through an installed plugin.
- Answers to the plan's open questions: task-notification rows do carry `toolUseId`; text typed
  during our turn enters it (so ambiguous, then `comms reply`); the flag works from the user
  settings layer, and mods are also gated by a server rollout switch (on for this account now).
- Added beyond the plan: the mod tells the agent when its reply couldn't be matched, and reminds it
  to `comms reply` when background work from an already-answered request finishes.
- Needs Cedar: merge branch hazel; regenerate `pnpm-lock.yaml` for the new package (root file,
  not committed by me); decisions on the three contract edges from Part C.
- Against the real connector: every check passes, including SIGKILL recovery (VALIDATION.md).

## Shared acceptance check (local) — passes in full 2026-09-30

- Write-up: validation/acceptance/README.md (Cedar, main 9de3a0c); my Claude Code rows checked,
  no corrections. Incident recorded there: a test terminal under /srv/agents/hazel loaded my
  CLAUDE.md and tried lhc-agent (nothing sent). Test terminals now run in /tmp/hazel-mod-work
  with a PATH holding only comms and node.
- Next: M6 cloud checkpoint, waiting on Lee.

## Fix pass 1 (docs/03-fix-pass.md)

### Section 1, mod items 1.5-1.9 — done 2026-10-01
- Failing tests first: 12c9bd3 (`test/fix-pass-1.test.ts`, `test/fix-pass-1-mod.test.ts`, named by item;
  12 of 13 failed on that commit). Fixes: a280186. 35 tests pass, typecheck clean, plugin validates.
- Linking by identity uses shapes captured live on 2.1.286: notification `<task-id>`/`<tool-use-id>`,
  Bash `backgroundTaskId` and Agent `agentId` in tool results, `agent.spawn` `parentAgentId`.
- Found while doing it: a background helper's hand-back arrives as a `peer` prompt
  (`<agent-message from="<agentId>">`). It's linked to our turn only if that agent is ours; otherwise other input.
- 1.9 needed no protocol change: the report keeps 49 entries plus `+N more`.

### Section 3, my items — done 2026-10-01
- Mod 3.8, 3.8a, 3.9, 3.10: 9db5e24. 39 mod tests pass. Live: folder 0700 and files 0600 after
  loosening; the log kept across sessions; deliveries still collected.
- T3 3.11-3.15: t3code-v044 `lhc-provider` 43c935261c and 5790b946b2. Evidence in
  `validation/fix-pass-1/` there. 3780 restarted on it; LHC recall still works from the same store,
  now derived from the T3 home in code.
- Depends on Cedar 3.1: the mod's start deadline only surfaces as `uncertain` if the connector sends a
  check for a Claude Code delivery that never reports `delivered`. Asked (relay ff7d6d1b).

### Section 4.2 and section 5 (Claude Code side) — done 2026-10-01
- 4.2: term-a by the documented procedure, option A (own CLAUDE_CONFIG_DIR), plus Reed's safety
  defaults (permission mode default, PATH with only comms). Evidence `validation/fix-pass-1/4.2/`.
- Section 5, Claude Code side, in `validation/fix-pass-1/5/claude-code/`: 1.6 concurrent helper,
  1.7 typed mid-turn, ten requests each on Sonnet and Opus (model view per request), crash window
  with the fault hook on cc-a and on term-a (one turn, one answer each), shared rerun 2b, 4, 5, 8.
