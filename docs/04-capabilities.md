# Capabilities pass: reminders, registry, send-and-wait, people, alerts

Draft 1 by Reed, 2026-10-01. Review: Cedar (Convex and local service), then Alder (scope) and Wrenn (references). Builds on `main` after fix pass 1 is signed off.

## Why

Fix pass 1 made comms safe to carry messages. Before Reed, Wrenn and Alder move onto it, it needs the relay abilities agents use every day: scheduled wake-ups, finding other agents, asking and getting the answer back in the same call, messaging a person, and being told when something is stuck. Phone access, urgent steering and interrupts are not in this pass.

## Design

All behaviour lives in Convex and the connector. Agents reach it through the `comms` CLI, which calls the connector's local API (`POST /v1/<op>` on the socket). An MCP endpoint or native tools in Claude Code terminals (`$.tool.register` in the mod) can be added later as thin callers of the same operations; nothing is implemented twice.

### System participants

A new participant kind, `system`, with no home and no presence. Two of them, created at deploy: `reminders` and `alerts`. They send messages; they are never addressed, never woken, and never get deliveries. Their messages render with a structured header so a model can't mistake them for a person typing.

### 1. Agent registry

- Participants gain `description` (one line) and `duties` (a few lines). Set at promotion, editable in the web view and with `comms agents set @name --description … --duty …` by the agent itself or its owner.
- `comms agents` lists every active participant: name, kind, state, presence, description, and harness (no thread ids or machines unless `--long`). `comms agents @name` shows one, with duties.
- "Agent registry" is the name in the CLI, the web view and the docs.

### 2. People and `@owner`

- `owner` becomes a reference to a human participant (today it's a free string). Promotion requires one; existing agents get `lee`.
- `@owner` in any send resolves to the sending agent's owner. `@lee` keeps working as an ordinary participant name.
- The web view shows an unread count and an inbox of messages addressed to the signed-in human, cleared as they're read.

### 3. Send and wait

- `comms send @agent "…"` now waits for the answer by default and prints it. `--continue` returns the message id straight away (today's behaviour). `--wait <duration>` sets the bound.
- **The answer returns to the call, not as a new turn.** While a send is waiting, the connector holds the request's message id. When the answer's delivery to the requester arrives, the connector hands it to the waiting call and marks the delivery `delivered` with detail "returned to the waiting send", without handing it to the harness. It must decide this before it would otherwise claim the delivery for handoff.
- **Late answers.** If the wait ends first, the CLI prints the message id and current state, and exits with a distinct code. Any answer arriving after that is delivered into the requester's thread as normal.
- **Default bound.** Below the shortest shell-command timeout of the harnesses agents run in. Hazel measures those first (Claude Code's Bash tool, Codex's shell in T3) and the default is set from her numbers, with the usage text telling agents to raise their shell timeout to match.
- **Several recipients.** A wait on a group request returns when every addressed agent's delivery is final, or at the bound with whatever has arrived.
- **No mutual waits.** Convex records each active wait (participant, request id, until). A waiting send to a participant that is itself in an active wait doesn't wait: it falls back to `--continue` and says why. That breaks A→B→A without timing out, across machines.
- `comms status <message-id>` shows each addressed recipient's delivery state, and the answer text if there is one. `comms status` with no argument keeps showing the connector's own status.

### 4. Reminders

- `comms remind @agent "text" --every <duration>` or `--at <time>`, plus `--name`, `--idle-for <duration>`, `--max <n>`, `--report-to @participant`, `--expires <duration>`.
- `comms reminders` lists them; `comms reminder <id>` shows one with its history; `comms reminder pause|resume|done|cancel <id>`; `comms reminder blocked <id> "reason"`. Allowed for the reminder's creator, its target, and the target's owner.
- **Storage and firing in Convex:** a `reminders` table (target, text, name, created by, schedule, options, state, fire count, last fire's message id, next fire time, expiry) and a scheduled function that fires due reminders.
- **A fire is an ordinary request** from `reminders` to the target, in a DM between them, so delivery, matching and recovery are the ones we just hardened. Rendered as: `Reminder: <name> (id …), set by @lee, every 30m. <text>`, with how to mark it done or blocked.
- **No pile-up:** a fire is skipped while the previous fire's delivery isn't final.
- **`--idle-for`:** fire only once the target has been idle at least that long; otherwise retry at the next tick. This covers what `lhc-monitor` does.
- **`--max` and expiry:** stop after n fires; every reminder expires (default 7 days, maximum 30) and its creator is told.
- **States:** `active`, `paused`, `blocked`, `done`, `cancelled`, `expired`. Only `active` fires.
- **Reports:** the target's collected answer to each fire is recorded on the reminder. With `--report-to`, it's also posted to that participant from `reminders`, with the agent's name.

### 5. Alerts

Posted by `alerts` to the affected agent's owner, once per cause, from a Convex scheduled function:

- a delivery entering `uncertain`;
- a machine with homed agents whose connector hasn't been heard from for a set time;
- a reminder `blocked` for a set time, or expired;
- a delivery claimed and re-claimed past a set number of leases.

Alerts carry the delivery, participant or reminder id. Thresholds live in one config record.

## Split: two agents

- **Cedar:** Convex, connector, CLI, protocol. Contract first (R0), then R1 to R4.
- **Hazel:** the harness timeout measurement first (it sets the wait default), then the web view parts and the mod's protocol sync, and the live acceptance with Cedar. `apps/web` moves to Hazel for this pass; Cedar owns its Convex queries.

Splitting is worth it because the web view and the measurements are independent once R0 is committed, and Hazel already holds the live test setup (term-a, 3780). Cedar remains the only owner of `packages/protocol` and Convex.

## Plan

**Prerequisite:** Alder signs off fix pass 1 on `main`.

**H0 (Hazel, first):** measure the default and maximum shell-command timeouts for Claude Code's Bash tool (in T3 and in a terminal) and Codex's shell in T3. Commit to `docs/t3-api-notes.md` with how each was measured.

**R0 (Cedar, contract):** schema changes (system kind, description, duties, owner reference, waits, reminders, alert records), new loopback operations and their JSON, the reminder and alert renderings in `render.ts`, and the Convex functions the web view will call. Hazel reviews before R1.

**R1 (Cedar):** registry and `@owner`, including migrating existing participants.

**R2 (Cedar):** send-and-wait, `--continue`, `comms status <id>`, the mutual-wait rule.

**R3 (Cedar):** reminders.

**R4 (Cedar):** alerts.

**W (Hazel, after R0):** the web view's registry (descriptions, duties, edit), the reminders list and controls, the human inbox with unread count, and alerts. Sync the protocol into the mod, check reminders render correctly in term-a, bump the mod version.

Rules as before: a failing test before each behaviour, one progress file per lane, raw evidence committed, report to Reed by relay at the end of each step.

## Acceptance (live, on the installed services; raw output in `validation/capabilities/`)

1. `comms agents` lists the agents with descriptions; `comms agents @x` shows duties.
2. `comms send` from a T3 agent to term-a and back returns the answer in the call, and the requester gets no extra turn.
3. A wait that runs out prints the id; the late answer arrives as a normal message; `comms status <id>` shows it.
4. A waits on B, B sends to A: B's send falls back to `--continue` immediately, and both requests complete.
5. A group request waited on by one agent returns both answers.
6. `comms send @owner` from an agent reaches Lee's inbox in the web view, unread until opened.
7. A reminder every 2 minutes to a T3 agent fires, arrives labelled as a reminder from `reminders` with its creator, collects the answer, and reports to `@lee`. A slow answer causes skipped fires, not a pile-up.
8. `--idle-for` defers a fire while the target is busy; `--max 3` stops after three; `done` and `blocked` stop it; a short expiry ends it and tells the creator.
9. An injected `uncertain` delivery and a stopped connector each produce one alert to the owner, not repeats.
10. No system participant ever receives a delivery.

## Not in this pass

Urgent steering, interrupts, `@all`, a phone connection, MCP or native tools, cloud Convex, moving agents over.
