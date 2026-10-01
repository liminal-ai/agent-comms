# Capabilities pass: reminders, registry, send-and-wait, people, alerts

Draft 2 by Reed, 2026-10-01, with Cedar's review of draft 1 against `main` `f2d55f0` folded in. Next review: Alder (scope) and Wrenn (references). Builds on `main` after fix pass 1 is signed off.

## Why

Fix pass 1 made comms safe to carry messages. Before Reed, Wrenn and Alder move onto it, it needs the relay abilities agents use every day: scheduled wake-ups, finding other agents, asking and getting the answer back in the same call, messaging a person, and being told when something is stuck. Phone access, urgent steering and interrupts are not in this pass.

## Design

All behaviour lives in Convex and the connector. Agents reach it through the `comms` CLI, which calls the connector's local API (`POST /v1/<op>` on the socket). An MCP endpoint or native tools in Claude Code terminals (`$.tool.register` in the mod) can be added later as thin callers of the same operations; nothing is implemented twice.

### System participants

- A new participant kind, `system`, with no home and no presence. Two are created at deploy: `reminders` and `alerts`.
- They send messages; they are never addressed, never woken, and never get deliveries:
  - `send` refuses `@reminders` and `@alerts`;
  - `post()` skips system recipients, as it already skips humans (`convex/lib/post.ts:73`);
  - collecting an answer never addresses a system requester (`convex/connector.ts:294`).
- Their messages render with a structured header so a model can't mistake them for a person typing.
- The kind is a contract change: `convex/validators.ts:7` and `packages/protocol/src/model.ts:30`, and so the mod's copy and the web view.

### 1. Agent registry

- Participants gain `description` (one line) and `duties` (a few lines). Set at promotion; editable in the web view and with `comms agents set @name --description … --duty …` by the agent itself or its owner.
- `comms agents` lists every active participant: name, kind, state, presence, description and harness (thread ids and machines only with `--long`). `comms agents @name` shows one, with duties.
- "Agent registry" is the name in the CLI, the web view and the docs.

### 2. People and `@owner`

- **Owner becomes a participant reference,** migrated in three steps, since `owner` is a string today (`schema.ts:21`) and changing its type in place fails validation on existing rows:
  1. add `ownerId: v.optional(v.id("participants"))`;
  2. backfill it with an internal mutation (every existing agent gets `lee`), and make promotion require it (`directory.ts:33, 50`);
  3. drop `owner`.
- **`@owner`** in any send resolves to the sending agent's owner. `owner` (and `all`, for later) become reserved names at promotion; they pass `NAME_PATTERN` today.
- **Inbox:** humans get no deliveries (`post.ts:67, 73`), and Convex can't index the `recipientIds` array, so there's a new `inbox` table `{humanId, messageId, readAt}`. `post()` writes it for each human recipient, and the web view clears it as messages are read. It gives the unread count cheaply. `@lee` keeps working as an ordinary name.

### 3. Send and wait

- `comms send @agent "…"` waits for the answer by default and prints it. `--continue` returns the message id at once (today's behaviour). `--wait <duration>` sets the bound.
- **Two operations, not one long call.** The loopback server ends requests after 120 s (`connector/src/loopback.ts:71`). So:
  - `send` with `wait: true` registers the wait and returns at once;
  - the CLI then repeatedly calls a held operation, `await(messageId, waitMs ≤ 25 s)`, on the same pattern as the mod's poll (`MAX_POLL_WAIT_MS`, `protocol/src/loopback.ts:46`), until it gets the answer or hits its bound;
  - if the connector restarts, the CLI re-registers the wait.
- **The answer returns to the call, not as a new turn.**
  - It's handled outside the per-participant delivery loop. The requester is mid-turn while its CLI waits, so the dispatcher treats it as busy and works its in-flight delivery first (`dispatcher.ts:348, 358-364`); the answer would never be looked at.
  - A separate pass over the work stream matches pending answer deliveries against the waits this connector holds, ignoring busy state and serial order. The work query exposes each answer delivery's `inReplyTo` for this (`convex/connector.ts:105-116`).
  - One Convex mutation consumes it: a compare-and-set from `pending` to `delivered`, with detail "returned to the waiting send", that returns the answer text. It must not be a claim followed by `delivered`, which would race the normal path.
  - **Which answer ends the wait:** the collected answer, or a `comms reply` that completes the delivery. Later follow-ups go into the thread as normal.
  - The overview's definition of `delivered` ("the harness accepted our message") gains this one exception; the overview is updated to say so.
- **Late answers.** If the CLI's bound is reached first, it prints the message id and current state and exits with a distinct code. An answer arriving after that is delivered into the requester's thread as normal.
- **Default bound.** Below the shortest shell-command timeout of the harnesses agents run in. Hazel measures those first (H0), and the default is set from her numbers. The usage text tells agents that a waiting send ties up their turn's shell for up to the bound, and to raise their shell timeout to match.
- **Several recipients.** A wait on a group request returns when every addressed agent's delivery is final, or at the bound with what has arrived.
- **No mutual waits.**
  - A `waits` table `{participantId, messageId, until}`, indexed by participant.
  - The check and the insert happen in the same mutation as the send. Convex's serializable transactions then order two simultaneous sends, so the second sees the first's wait.
  - A waiting send to a participant that is itself in an active wait doesn't wait: it falls back to `--continue` and says why. That closes any cycle, including A→B→C→A, without timing out.
  - Waits are removed on completion or timeout, and expire at `until`, so a crashed CLI's wait ends on its own.
- `comms status <message-id>` shows each addressed recipient's delivery state, and the answer text if there is one. `comms status` with no argument keeps showing the connector's own status.

### 4. Reminders

- `comms remind @agent "text" --every <duration>` or `--at <time>`, plus `--name`, `--idle-for <duration>`, `--max <n>`, `--report-to @participant`, `--expires <duration>`.
- `comms reminders` lists them; `comms reminder <id>` shows one with its history; `comms reminder pause|resume|done|cancel <id>`; `comms reminder blocked <id> "reason"`. Allowed for the reminder's creator, its target, and the target's owner.
- **Storage:** a `reminders` table (target, text, name, created by, schedule, options, state, fire count, next fire time, expiry), indexed on `(state, nextFireAt)`, and a `reminderFires` table keyed by message id (reminder, delivery id, fired at, collected answer).
- **Firing:** one Convex cron each minute fires due reminders through that index. That's simpler to recover and pause than chained per-reminder jobs.
- **A fire is an ordinary request** from `reminders` to the target, in a DM between them, so delivery, matching and recovery are the ones we just hardened. Rendered as `Reminder: <name> (id …), set by @lee, every 30m.`, then the text, then how to mark it done or blocked.
- **No pile-up:** a fire is skipped while the previous fire's delivery isn't final. Final means not `pending`, `claimed` or `delivered`. `ambiguous` counts as not final, since `comms reply` can still complete it.
- **`--idle-for`:** fires only once the target has been idle at least that long; otherwise it retries next minute. Needs a new `presence.idleSince` that changes only on the transition to idle, since `presence.at` moves on every write, including each mod re-registration and the connector's reset at start (`connector/src/connector.ts:96`). A stale presence (connector not heard from) doesn't count as idle. This covers what `lhc-monitor` does.
- **`--max` and expiry:** stops after n fires. Every reminder expires (default 7 days, maximum 30), and its creator is told.
- **States:** `active`, `paused`, `blocked`, `done`, `cancelled`, `expired`. Only `active` fires.
- **Reports:** collecting an answer looks up `reminderFires` by the request's message id and records the answer there. With `--report-to`, it's also posted to that participant from `reminders`, with the agent's name.

### 5. Alerts

Posted by `alerts` to the affected agent's owner, from a Convex cron:

- a delivery entering `uncertain`;
- a machine with homed agents whose connector hasn't been heard from for a set time;
- a reminder `blocked` for a set time, or expired;
- a delivery claimed more than a set number of times. This needs a claim counter on the delivery (`convex/connector.ts:176`).

"Once per cause" is an `alerts` table unique on `(cause, subject id)`. Alerts carry the delivery, participant or reminder id. Thresholds live in one config record.

## Split: two agents

- **Cedar:** Convex, connector, CLI and protocol. Contract first (R0), then R1 to R4.
- **Hazel:** the harness timeout measurement first (it sets the wait default), then the web view parts and the mod's protocol sync, and the live acceptance with Cedar. `apps/web` moves to Hazel for this pass; Cedar owns every Convex function it calls.

It's worth splitting because the web view and the measurements are independent once R0 is committed, and Hazel already holds the live test setup (term-a, 3780). Cedar remains the only owner of `packages/protocol` and Convex.

## Plan

**Prerequisite:** Alder signs off fix pass 1 on `main`.

**H0 (Hazel, first):** measure the default and maximum shell-command timeouts for Claude Code's Bash tool (in T3 and in a terminal) and Codex's shell in T3. Commit them to `docs/t3-api-notes.md` with how each was measured.

**R0 (Cedar, contract):**
- schema: the `system` kind, `description`, `duties`, `ownerId`, `presence.idleSince`, and the `waits`, `inbox`, `reminders`, `reminderFires` and `alerts` tables, plus the delivery claim counter;
- the new loopback operations and their JSON, including `await`;
- the reminder and alert renderings in `render.ts`;
- **every** Convex query and mutation the web view will call: registry edit, inbox, reminders and alerts.

Hazel reviews R0 before R1.

**R1 (Cedar):** the registry, `ownerId` and its migration, reserved names, `@owner`, the inbox.

**R2 (Cedar):** send-and-wait (`await`, the consuming pass and mutation), `--continue`, `comms status <id>`, the waits table and mutual-wait rule.

**R3 (Cedar):** reminders, including system-recipient handling and `idleSince`.

**R4 (Cedar):** alerts.

**W (Hazel, after R0):** the web view's registry (descriptions, duties, editing), the reminders list and controls, the human inbox with unread count, and alerts. Sync the protocol into the mod, check that reminders render correctly in term-a, and bump the mod version.

Rules as before: a failing test before each behaviour, one progress file per lane, raw evidence committed, and a report to Reed by relay at the end of each step.

## Acceptance (live, on the installed services; raw output in `validation/capabilities/`)

1. `comms agents` lists the agents with descriptions; `comms agents @x` shows duties.
2. `comms send` from a T3 agent to term-a, and from term-a to a T3 agent, returns the answer in the call, and the requester gets no extra turn.
3. A wait that runs out prints the id; the late answer arrives as a normal message; `comms status <id>` shows it.
4. A waits on B, then B sends to A: B's send falls back to `--continue` at once, and both requests complete. The same for two simultaneous sends.
5. A group request waited on by one agent returns both answers.
6. `comms send @owner` from an agent reaches Lee's inbox in the web view, unread until opened.
7. A reminder every 2 minutes to a T3 agent fires, arrives labelled as a reminder from `reminders` with its creator, collects the answer, and reports to `@lee`. A slow answer causes skipped fires, not a pile-up.
8. `--idle-for` defers a fire while the target is busy; `--max 3` stops after three; `done` and `blocked` stop it; a short expiry ends it and tells the creator.
9. An injected `uncertain` delivery and a stopped connector each produce exactly one alert to the owner.
10. No system participant ever receives a delivery.

## Not in this pass

Urgent steering, interrupts, `@all`, a phone connection, MCP or native tools, cloud Convex, moving agents over.
