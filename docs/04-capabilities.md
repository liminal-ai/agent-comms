# Capabilities pass: reminders, registry, send-and-wait, people, alerts

Draft 5 by Reed, 2026-10-01: Cedar's review of draft 1, Alder's and Wrenn's reviews of drafts 2 and 3, folded in. Builds on `main` after fix pass 1 is signed off.

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
  - A separate pass over the work stream matches pending answer deliveries against the waits this connector holds, ignoring busy state and serial order. Add each answer delivery's `inReplyTo` to the work query for this (`convex/connector.ts:105-116` doesn't carry it today).
  - **One Convex mutation consumes it,** and only while that recipient's result is still open. A wait holds one result per addressed agent (`open`, `answered`, `expired`); the first answer in a group closes only its own result. The mutation compare-and-sets that result from `open` to `answered`, storing the answer's message id. In the same transaction it sets the delivery from `pending` to `delivered`, with detail "returned to the waiting send". It must not be a claim followed by `delivered`, which would race the normal path.
  - **The CLI reads answers from the stored results, not from the connector's memory.** If the connector dies between consuming and returning, the CLI reconnects and `await` finds them.
  - **The answer is never lost; it may be shown twice.** A result ends by compare-and-set, `open` to `answered` or `open` to `expired` (when the CLI's bound or `until` passes). An answer that arrives after `expired` goes into the thread as normal. An `answered` result is held for the waiting call, and:
  - after printing, the CLI acknowledges it with an `ack` operation. **An ack counts only while the waiter's turn is still running** (its participant is busy in the turn that ran the CLI). Printed isn't seen: Claude Code moves a shell command past its timeout to the background and usually ends the turn, and a Codex agent that stops polling its shell session never reads the output (Hazel, H0). An ack after the turn has ended is ignored, and the fallback delivers the answer into the thread;
  - a result not acknowledged within a set time (default 2 minutes) gets **one** automatic fallback into the requester's thread, as a normal answer marked "may already have been returned to a waiting send". The fallback is idempotent: keyed on the result, so a retry or a second connector can't send it twice, and an `ack` racing the fallback is decided by the same compare-and-set (`answered` to `acknowledged`, or `answered` to `fell-back`);
  - the answer stays readable through `await` and `comms status <id>` in every case.
  
  Duplicate presentation is possible: if the CLI printed the answer and died before acknowledging, the agent sees it again in its thread.
  - **What ends the wait, per recipient:**
    - `replied`: the collected answer, or a `comms reply` that completes the delivery, is returned.
    - `ambiguous`: keep waiting, since the agent will finish it with `comms reply`.
    - `failed` or `uncertain`: the wait ends for that recipient and reports the state.
    - Later follow-ups go into the thread as normal.
  - **People:** a human recipient never answers like an agent. For a human, the send is complete once the message is in their inbox, and `comms send @owner` returns at once with that. In a mixed group, the wait covers only the agents; humans are listed as "in inbox".
  - The overview's definition of `delivered` ("the harness accepted our message") gains this one exception; the overview is updated to say so.
- **Late answers.** If the CLI's bound is reached first, it prints the message id and current state and exits with a distinct code. An answer arriving after that is delivered into the requester's thread as normal.
- **Default bound.** Below the shortest default shell-command timeout of the harnesses agents run in. Claude Code's Bash tool defaults to 120 s and caps foreground commands at 600 s; Hazel measures Codex's shell in T3 (H0), and the default is set from the two, likely around 100 s. The usage text names three patterns:
  - **short asks:** the default;
  - **medium asks:** raise the shell timeout and pass `--wait 9m`; this ties up the turn's shell for that long;
  - **long asks:** `--continue`, or in Claude Code run `comms send` as a background shell command. Its completion arrives as a task notification: inside the same turn if the turn is still running (the mod links it as the turn's own work), or as a new turn if the turn has ended. That's no worse than `--continue`, but not free.
- **Usage text, from H0:** Claude Code agents set the Bash timeout above the wait bound for any `--wait` over 100 s (maximum 600 s in the foreground). Codex agents keep polling the shell session until `comms` exits; a Codex command has no time limit but hands back control after 10 s.
- **H0 measures behaviour, not just numbers:** for each harness, whether a long shell command finishes, times out (and what the agent sees), or is moved to the background, so we know send-and-wait returns inside the same turn.
- **Several recipients.** A wait on a group request returns when every addressed agent's delivery is final, or at the bound with what has arrived.
- **No mutual waits.**
  - A `waits` table `{participantId, messageId, until}`, indexed by participant.
  - The check and the insert happen in the same mutation as the send. Convex's serializable transactions then order two simultaneous sends, so the second sees the first's wait.
  - **The rule is "the target is busy waiting", not cycle detection.** A waiting send to a participant that is itself in an active wait, on anyone, doesn't wait: it falls back to `--continue` and tells the agent "@B is waiting on another request; your message is queued, check with `comms status <id>`." That's broader than a cycle, which is fine since B can't answer until its own wait ends, and it closes every cycle, including A→B→C→A, without timing out.
  - **Waits stop being active, but their results stay.** When every result is final, or at `until`, the wait stops counting as "busy waiting" (so a crashed CLI's wait ends on its own). The wait and its per-recipient results are kept for `comms status`, not deleted; R0 sets how long.
- `comms status <message-id>` shows each addressed recipient's delivery state, and the answer text if there is one. `comms status` with no argument keeps showing the connector's own status.

### 4. Reminders

- `comms remind @agent "text" --every <duration>` or `--at <time>`, plus `--name`, `--idle-for <duration>`, `--watch @participant`, `--max <n>`, `--report-to @participant`, `--expires <duration>`.
- `comms reminders` lists them; `comms reminder <id>` shows one with its history; `comms reminder pause|resume|done|cancel <id>`; `comms reminder blocked <id> "reason"`. Allowed for the reminder's creator, its target, and the target's owner.
- **Storage:** a `reminders` table (target, text, name, created by, schedule, options, state, fire count, next fire time, expiry), indexed on `(state, nextFireAt)`, and a `reminderFires` table keyed by message id (reminder, delivery id, fired at, collected answer).
- **Firing:** one Convex cron each minute fires due reminders through that index. That's simpler to recover and pause than chained per-reminder jobs.
- **A fire is an ordinary request** from `reminders` to the target, in a DM between them, so delivery, matching and recovery are the ones we just hardened. Rendered as `Reminder: <name> (id …), set by @lee, every 30m.`, then the text, then how to mark it done or blocked.
- **No pile-up:** a fire is skipped while the previous fire's delivery isn't final. Final means not `pending`, `claimed` or `delivered`. An `ambiguous` fire counts as not final for one interval, since `comms reply` can still complete it, and as final after that, so a reminder can't stall forever. Every skip is logged on the reminder with its reason.
- **`--idle-for`:** fires only once a participant has been idle at least that long; otherwise it retries next minute. By default that's the reminder's own target, which covers what `lhc-monitor` does.
- **`--watch @x`:** the idle condition is checked on `@x` instead of the target. "Wake Reed once Hazel has been idle for 20 minutes" is `comms remind @reed "check on Hazel" --watch @hazel --idle-for 20m`.
- **Idle needs `presence.idleSince`,** which changes only on the transition to idle, since `presence.at` moves on every write, including each mod re-registration and the connector's reset at start (`connector/src/connector.ts:96`). A stale presence (connector not heard from) never counts as idle, for the target and for a `--watch` participant alike, so a sleeping Mac doesn't read as "idle for hours".
- **Pausing or cancelling stops future fires only.** A turn already running from an earlier fire runs to its end, and its answer is still recorded.
- **`--max` and expiry:** stops after n fires. Every reminder expires (default 7 days, maximum 30), and its creator is told.
- **States:** `active`, `paused`, `blocked`, `done`, `cancelled`, `expired`. Only `active` fires.
- **Reports:** collecting an answer looks up `reminderFires` by the request's message id and records the answer there. With `--report-to`, it's also posted to that participant from `reminders`, with the agent's name.

### 5. Alerts

Posted by `alerts` to the affected agent's owner, from a Convex cron:

- a delivery entering `uncertain`;
- a machine with homed agents whose connector hasn't been heard from for a set time;
- a reminder `blocked` for a set time, or expired;
- a delivery claimed more than a set number of times. This needs a claim counter on the delivery (`convex/connector.ts:176`).

**Once per incident, not once forever.** An `alerts` table records incidents keyed by `(cause, subject id)`, with `openedAt` and `resolvedAt`. An alert is sent when an incident opens. The incident closes when the condition clears (the connector is heard from again, the delivery leaves `uncertain`, the reminder leaves `blocked`), and a later recurrence opens a new incident and a new alert. So down, recovered, down gives two alerts. Recovery itself isn't announced in this pass. Alerts carry the delivery, participant or reminder id. Thresholds live in one config record.

## Split: two agents

- **Cedar:** Convex, connector, CLI and protocol. Contract first (R0), then R1 to R4.
- **Hazel:** the harness timeout measurement first (it sets the wait default), then the web view parts and the mod's protocol sync, and the live acceptance with Cedar. `apps/web` moves to Hazel for this pass; Cedar owns every Convex function it calls.

It's worth splitting because the web view and the measurements are independent once R0 is committed, and Hazel already holds the live test setup (term-a, 3780). Cedar remains the only owner of `packages/protocol` and Convex.

## Plan

**Prerequisite:** Alder signs off fix pass 1 on `main`.

**H0 (Hazel, first):** Claude Code's Bash tool is known: 120 s default, 600 s foreground maximum. Confirm that in T3 and in a terminal, and measure Codex's shell in T3. For each, record whether a long command finishes, times out (and what the agent sees), or is moved to the background. Commit the results to `docs/t3-api-notes.md` with how each was measured.

**R0 (Cedar, contract):**
- schema: the `system` kind, `description`, `duties`, `ownerId`, `presence.idleSince`, and the `waits`, `inbox`, `reminders`, `reminderFires` and `alerts` tables, plus the delivery claim counter;
- the new loopback operations and their JSON, including `await`, and the CLI's JSON output and exit codes for `send`, `await` and `status` (a distinct code for "bound reached, still pending"), since the mod and any later MCP wrapper build on them;
- the reminder and alert renderings in `render.ts`;
- **every** Convex query and mutation the web view will call: registry edit, inbox, reminders and alerts.
- the wait contract: per-recipient results (`open`, `answered`, `expired`, `ended` for a recipient whose delivery failed, became uncertain or was retired, `acknowledged`, `fell-back`), `ack`, the acknowledgement window and its single idempotent fallback into the thread, and how long results are kept.

Hazel reviews R0 before R1.

**R1 (Cedar):** the registry, `ownerId` and its migration, reserved names, `@owner`, the inbox.

**R2 (Cedar):** send-and-wait (`await`, the consuming pass and mutation), `--continue`, `comms status <id>`, the waits table (open, answered, expired, with the stored answer) and the busy-waiting rule.

**R3 (Cedar):** reminders, including system-recipient handling, `idleSince`, `--watch`, and the stale-presence rule for both the target and the watched participant.

**R4 (Cedar):** alerts.

**W (Hazel, after R0):** the web view's registry (descriptions, duties, editing), the reminders list and controls, the human inbox with unread count, and alerts. Sync the protocol into the mod, check that reminders render correctly in term-a, and bump the mod version.

Rules as before: a failing test before each behaviour, one progress file per lane, raw evidence committed, and a report to Reed by relay at the end of each step.

## Acceptance (live, on the installed services; raw output in `validation/capabilities/`)

1. `comms agents` lists the agents with descriptions; `comms agents @x` shows duties.
2. `comms send` from a T3 agent to term-a, and from term-a to a T3 agent, returns the answer in the call, and the requester gets no extra turn.
3. A wait that runs out prints the id; the late answer arrives as a normal message; `comms status <id>` shows it.
4. A waits on B, then B sends to A: B's send falls back to `--continue` at once with the "busy waiting" message, and both requests complete. The same for two simultaneous sends, and for a three-agent cycle A→B→C→A.
5. A group request waited on by one agent returns both answers; a group with Lee in it returns the agents' answers and lists Lee as "in inbox".
6. `comms send @owner` from an agent returns at once and reaches Lee's inbox in the web view, unread until opened.
7. **Restart while waiting:**
   - the connector is killed after consuming an answer and before the CLI gets it: the CLI reconnects and gets the stored answer;
   - the CLI is killed mid-wait: its wait expires and later answers go into the thread;
   - the CLI is killed after the answer is stored and before it acknowledges: the answer reaches the thread after the acknowledgement window, and stays readable with `comms status`.
8. **Answer at the bound, and ack racing fallback:** an answer arriving as the wait expires is never lost (forced by fault injection); an `ack` arriving at the moment the fallback fires produces at most one fallback, and the result ends either `acknowledged` or `fell-back`. In a group wait, one recipient answering doesn't close the others' results.
9. A reminder every 2 minutes to a T3 agent fires, arrives labelled as a reminder from `reminders` with its creator, collects the answer, and reports to `@lee`. A slow answer causes skipped fires, not a pile-up; an ambiguous fire stops blocking after one interval.
10. `--idle-for` defers a fire while the target is busy; `--watch` defers it on another agent's activity; `--max 3` stops after three; `done` and `blocked` stop it; a short expiry ends it and tells the creator. Pausing or cancelling while a fire's turn is running stops later fires and lets that turn finish.
11. An injected `uncertain` delivery and a stopped connector each produce exactly one alert to the owner. Stopping the connector, restarting it, and stopping it again produces two alerts.
12. No system participant ever receives a delivery.

## Not in this pass

Urgent steering, interrupts, `@all`, a phone connection, MCP or native tools, cloud Convex, moving agents over.
