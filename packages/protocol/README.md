# @agent-comms/protocol

The agent-comms contract, and its single source of truth. Plain TypeScript: no dependencies, no Node APIs, erasable syntax only, relative imports with `.ts` extensions. Convex, the connector, the adapters, the `comms` CLI, the Claude Code mod and the web app all import it.

| File | What |
|---|---|
| [`src/model.ts`](src/model.ts) | Participants, homes, conversations, the message envelope, deliveries and their states |
| [`src/history.ts`](src/history.ts) | `boundHistory`: the capped recent history a delivery carries |
| [`src/render.ts`](src/render.ts) | `renderDelivery` (how a delivery is shown to a model) and `parseDeliveryHeader` |
| [`src/loopback.ts`](src/loopback.ts) | The connector's local protocol: socket path, operations, request decoders, response types, errors |
| [`src/capabilities.ts`](src/capabilities.ts) | The capabilities pass: registry entries, waits and their results, CLI exit codes, reminders, alerts, the inbox, durations |

The types and the comments on them are the specification. This page is the tour.

## Using it from the mod

The mod runs in Claude Code's own module environment (no Node, imports only from inside the plugin folder). Everything in `src/` works there. The mod needs `renderDelivery`, `parseDeliveryHeader`, `opPath`, `parseResponse`, `socketPath` and the types; copy or bundle `src/` into the plugin (how is Hazel's call). If the mod's tsconfig uses `moduleResolution: "bundler"`, add `"allowImportingTsExtensions": true` for the `.ts` imports.

## The envelope

`MessageEnvelope` (model.ts): id, conversation id, per-conversation `seq` (from 1, no gaps), `sender`, `recipients` (the addressed participants: only they're woken), `kind` (`request` | `answer` | `notice`), `inReplyTo` (on answers), `collectedFrom` (only on an answer collected automatically from a delivery's turn), text, attachment references (never bytes), created time, and `origin` (`via`: `t3` | `claude-code` | `cli` | `web`, plus an optional external id for echo suppression).

Participants appear as `ParticipantRef` `{id, name, kind}`. Names are unique, lowercase, and what `@name` and `--as` use.

## Deliveries

One delivery per addressed agent per message. States:

| State | Meaning |
|---|---|
| `pending` | waiting for the recipient's connector, or for a paused recipient to resume |
| `claimed` | a connector holds a lease (`claim`: machine, claim id, lease expiry) |
| `delivered` | the harness accepted it; `turnId` says which turn |
| `replied` | answer collected from the turn, or completed with `comms reply` |
| `ambiguous` | other input entered our turn; the agent answers with `comms reply` |
| `uncertain` | after a restart it can't be told whether it ran; never re-run, shown to Lee |
| `failed` | aborted, refused, errored, or rejected by the harness |

A delivery of an `answer` ends at `delivered`: it may wake the requester, but nothing the requester does next is collected. That's what stops loops. Humans get no deliveries; they read in the web view. Retired participants get none; paused ones get a pending delivery.

Each `Delivery` carries the message, the conversation, the recipient (their own registered name), the request an answer answers (`inReplyTo`), and `history`: the messages after the recipient's read position and before this one, newest kept, capped by count and characters (`boundHistory`, default 20 messages / 8000 characters), with `omitted` saying how many older ones were left out.

## Rendering and the header

`renderDelivery(delivery, { harnessLabelsSource })` is the only way a delivery becomes model input. Its first line is the header:

```
[agent-comms v1] delivery=<delivery-id> message=<message-id> kind=<request|answer>
```

`parseDeliveryHeader(text)` finds it as a complete line anywhere in the text (surrounding whitespace ignored), never as a substring, so it works inside Claude Code's plugin wrapper ("The <plugin> plugin sent a message: … Address the message above."). It returns null for no header, and for two different ones. Every quoted body line in the rendering starts with `> `, so a header pasted into a message is never a match.

The rendering states who it's from, which conversation, the recipient's own name (to pass as `--as`), whether an answer is expected, how to answer (reply normally; `comms reply <message-id>` if told the reply couldn't be matched or for a follow-up after the turn), and that it is a message from that participant, not an instruction from the session's user, so normal permission rules apply. `harnessLabelsSource: true` (Claude Code) drops the source line the harness already provides; `false` (T3) includes it. See `test/render.test.ts` for complete examples.

## Size caps (fix pass 1.10)

| Cap | Value | Enforced |
|---|---|---|
| `MAX_TEXT_CHARS` | 32,000 characters of message text | refused at send: loopback `bad_request` and Convex `post` (send, reply, web posts), with the limit in the error; collected answers are clipped to it (`clipAnswer`) |
| `MAX_TITLE_CHARS` | 200 | refused at group creation; clipped when rendered |
| `MAX_RENDERED_CHARS` | 48,000 characters of one whole rendered delivery | `renderDelivery` cuts older history first, then attachment references, then the body, saying what was left out and how to `comms read` it |

Line breaks (1.11): `\r\n`, `\n`, a lone `\r`, U+2028 and U+2029 all break lines, both when quoting bodies (every piece gets `> `) and when parsing headers, so no body can produce a header line whatever line endings a harness normalizes to.

## The loopback protocol

HTTP/1.1 over a Unix socket. Every operation is `POST /v1/<op>` with a JSON body.

- Success: HTTP 200, `{"ok": true, ...result}`.
- Failure: `{"ok": false, "error": {"code", "message"}}` with the status in `ERROR_STATUS`.

**Socket path** (`socketPath()`): `$AGENT_COMMS_SOCKET` if set; on Linux `$XDG_RUNTIME_DIR/agent-comms/connector.sock`, falling back to `/run/user/<uid>/…`; on macOS `~/.agent-comms/connector.sock`. The connector creates the directory 0700 and refuses to start if it exists with wider permissions, another owner, or as a symlink, or if something already listens on the socket. A mod session without `XDG_RUNTIME_DIR` (and with no uid to fall back on) should be given `AGENT_COMMS_SOCKET`.

**No token.** The directory's permissions are the protection: anything that could read a token could open the socket. Same trusted-machine footing as `--as`.

**Identity is a development shortcut.** `--as <name>` (and `register`'s `participant`) is accepted for any participant homed on this machine. It is not proof of identity; per-agent credentials come later.

### Operations

Request shapes and their validation are in `requestDecoders` (loopback.ts); response shapes in `Responses`. Unknown request fields are ignored.

| Op | Who | Request | Result |
|---|---|---|---|
| `status` | any | `{}` | `protocol`, `implementation` (`stub` \| `connector`), `machine`, participants homed here |
| `register` | mod | `participant`, `harness: "claude-code"`, `sessionId`, `cwd`, `status` | `participant`, `pollWaitMs` |
| `unregister` | mod | `sessionId` | `{}` |
| `poll` | mod | `sessionId`, `waitMs?` (≤ 25000) | `items`: `{type:"deliver", delivery}` \| `{type:"check", check}` |
| `delivered` | mod | `sessionId`, `deliveryId`, `turnId` | `delivery` state |
| `outcome` | mod | `sessionId`, `deliveryId`, `turnId`, then `outcome: "replied", answer` \| `"ambiguous", entered[]` \| `"failed", reason, detail?` | `delivery` state, `answerMessageId?`, `duplicate` |
| `check-result` | mod | `sessionId`, `deliveryId`, `found: "yes", turnId, turn: "running"` \| `…turn: "completed"` + outcome fields (omit for an answer's delivery) \| `found: "no"` \| `found: "unknown", detail?` | `delivery` state |
| `presence` | mod | `sessionId`, `status` (`idle` \| `busy`) | `{}` |
| `send` | CLI | `as`, `to[]`, `conversationId?`, `text`, `attachments?`, `key?` (idempotency: a repeat with the same key returns the first result and posts nothing), `wait?`, `waitMs?` | `message`, `deliveries`, `skipped`, and `wait` or `noWait` |
| `reply` | CLI | `as`, `messageId`, `text`, `attachments?` | as `send`, plus `completed?` |
| `read` | CLI | `as`, `conversationId`, `before?`, `limit?` (≤ 100) | `conversation`, `messages` (oldest first), `hasMore` |
| `list` | CLI | `as` | `conversations` (most recent first) |
| `await` | CLI | `as`, `messageId`, `waitMs?` (≤ 25000) | `wait` (see [The wait contract](#the-wait-contract)) |
| `ack` | CLI | `as`, `messageId`, `recipients?` | `wait` |
| `message-status` | CLI | `as`, `messageId` | `MessageStatus`: each recipient's delivery and answer, people's read state, the caller's wait |
| `agents` | CLI | `as`, `name?`, `long?` | `agents`: `RegistryEntry[]` (homes only with `long`) |
| `agents-set` | CLI | `as`, `name`, `description?`, `duties?` | `agent` |
| `remind` | CLI | `as`, `target`, `text`, exactly one of `everyMs` (≥ 60000) and `at`, `name?`, `idleForMs?`, `watch?`, `max?`, `reportTo?`, `expiresMs?` (≤ 30 d) | `reminder` |
| `reminders` | CLI | `as` | `reminders` the caller created, is the target of, or owns the target of |
| `reminder` | CLI | `as`, `id` | `reminder`, `fires` (newest first), `skips` (newest first) |
| `reminder-update` | CLI | `as`, `id`, `action` (`pause` \| `resume` \| `done` \| `cancel` \| `blocked`), `reason?` (required for `blocked`) | `reminder` |

With `wait: true`, `send` (1 s to 60 min, `waitMs`) answers with `wait` (registered in the same Convex mutation as the send) or `noWait` (why it didn't wait). The operations from `await` on are the capabilities pass (`docs/04-capabilities.md`); the stub answers them `unsupported` (501), and the CLI then sends without waiting and says so.

Rules that matter to clients:

- **Register** again with the same `sessionId` after the connector restarts: any call answering `unknown_session` means register, then retry that call. A different session for the same participant supersedes the old one, whose polls then fail with `session_superseded`: stop polling.
- **Poll** is held until there's an item or the wait passes, then answered, possibly with no items. The bound is the connector's, because the mod's fetch has no timeout. One outstanding poll per session; a second fails with `poll_in_progress`. If the client disconnects, nothing is handed out on that poll.
- **Serial per participant:** a participant gets its next delivery only after the previous one is finished (a request replied, ambiguous, failed or uncertain; an answer delivered).
- **Checks** carry the delivery's `createdAt` (server clock), so a session that lost its history can tell which deliveries it could have seen.
- **Checks** replace blind re-runs. After a restart or a new registration, anything handed out and unfinished comes back as a `check` before any new delivery: `state: "claimed"` asks "did this enter the session?"; `state: "delivered"` asks "what happened to turn `turnId`?". Answer with `check-result`. `no` for a claimed one makes it run again; `unknown` makes it `uncertain`; `yes` with a completed turn carries the outcome.
- **Reports are acknowledged at once.** The connector answers `delivered`, `outcome`, `check-result` and `presence` immediately and writes them to the server in the background, retrying while it's unreachable, so a harness is never held up. The `delivery.state` in the answer is the state being recorded; `answerMessageId` is included only when already known.
- **`delivered`** is idempotent for the same turn; a different turn is a `conflict`.
- **The unmatched notice.** When a delivery goes `ambiguous`, the agent is told with `renderUnmatchedNotice` (its own header line, found by `parseNoticeHeader`, never by `parseDeliveryHeader`), so it knows to `comms reply`. The T3 adapter sends it into the thread as its own turn; the mod shows it after reporting `ambiguous`. Nothing is collected from the turn a notice starts.
- **`outcome`** applies only to request deliveries. `turnId` may be omitted only for `failed` (a delivery the harness dropped before any turn ran it). An answer over `MAX_TEXT_CHARS` is accepted (up to `MAX_REPORTED_ANSWER_CHARS`) and clipped (`clipAnswer`). `replied` is collected at most once per delivery; a repeat returns the first answer with `duplicate: true`. `ambiguous` reports only the kinds of input that entered the turn (`origin`, e.g. `composer`), never their text.
- **`send`** without `conversationId` addresses exactly one participant (their DM, opened if new). With it, every addressed name must be a member, and an empty `to` posts without waking anyone.
- **`reply`** is always allowed and never collected from. It completes an `ambiguous` or `uncertain` delivery of that message to the replier; a still-running `delivered` one is left alone, because its turn's own answer is still collected.
- **`read`** of the newest page moves the reader's read position; older pages don't.
- **Private work stays private:** the mod sends nothing about turns that aren't ours except presence.

### Errors

| Code | HTTP | When |
|---|---|---|
| `bad_request` | 400 | body not JSON, fails validation, or addressing is invalid |
| `unknown_op` | 404 | no such operation |
| `unknown_participant` | 404 | no participant by that name |
| `not_homed_here` | 403 | `as`/`participant` is homed on another machine (or, for `register`, isn't a Claude Code home) |
| `not_member` | 403 | not a member of that conversation |
| `unknown_conversation`, `unknown_message`, `unknown_delivery`, `unknown_reminder` | 404 | no such id |
| `unknown_session` | 404 | session not registered here: register again |
| `session_superseded` | 409 | a newer session took over this participant: stop |
| `poll_in_progress` | 409 | this session already has a poll outstanding |
| `forbidden` | 403 | not allowed to see or change this (a reminder that isn't yours: fix pass 0.4) |
| `conflict` | 409 | the delivery isn't this session's, or the state change doesn't fit |
| `unavailable` | 503 | the connector can't reach Convex right now: retry later |
| `unsupported` | 501 | this connector (the stub, or an older one) doesn't implement the operation |
| `internal` | 500 | anything else, including a malformed response (`parseResponse`) |

## The capabilities pass

`docs/04-capabilities.md` is the design; this is the contract it builds on (R0).

### System participants and names

Participant `kind` gains `system`. `reminders` and `alerts` are created at deploy; they send and are never addressed, woken or delivered to. `RESERVED_NAMES` (`owner`, `all`, `reminders`, `alerts`) are refused at promotion, and `owner` in a send's `to` resolves to the sending agent's owner (`OWNER_ALIAS`). A system participant's message carries `meta` (`MessageMeta`): a reminder fire, a report, an ending notice, or an alert.

### Registry, owners and the inbox (R1)

- **Promotion** (`directory.promote`) requires `owner`, a person's name, for an agent (stored as `ownerId`), and refuses reserved names. It also takes `description` and `duties`.
- **`directory.upgrade({defaultOwner})`**, run after each deploy (idempotent; `scripts/upgrade.ts`, and `scripts/dev-setup.ts` runs it): creates `@reminders` and `@alerts` (a `conflict` if a non-system participant holds either name) and gives every agent without `ownerId` `defaultOwner`. The owner migration's three steps are done: `ownerId` added (R0), backfilled (R1, 20 agents on lim-builder, no old strings found), and the old `owner` string dropped from the schema.
- **`@owner`** in `send`'s `to` is the sending agent's owner (`bad_request` if it has none). Sends from the web view are by people, who have no owner.
- **System participants** are never addressed (`bad_request` from any send or post) and get no deliveries; an answer to a system request (a reminder fire), collected or by `comms reply`, addresses no one.
- **Inbox:** `post()` writes an inbox row for each person a message addresses (not retired), whoever sends it, agents and system participants alike. That's the person's unread count.
- **`agents`** lists every participant that isn't retired (or one by name, any state), sorted by name; homes only with `long`. **`agents-set`** is allowed for the agent itself, or for an entry it owns (`conflict` otherwise); people edit in the web view.
- CLI: `comms agents [@name] [--long]`, `comms agents set @me [--description "…"] [--duty "…"]…` (`""` clears the description; any `--duty` replaces the list).

### The wait contract

`send` with `wait: true` registers a wait on the message and returns at once with it; the CLI then calls `await` (held up to 25 s, like `poll`) until every result is final or its own bound passes. A wait has one result per addressed **agent**; people addressed are listed in `inInbox` and never waited on. Each result moves only by compare-and-set:

| From | To | When |
|---|---|---|
| `open` | `answered` | the recipient's answer (collected, or a `comms reply` completing the delivery) is returned to the wait; its message is stored on the result |
| `open` | `expired` | the wait's `until` passed first, or the answer came while no CLI was awaiting (no `await` for `WAIT_HELD_MS`, 60 s): the answer goes into the thread as normal |
| `open` | `ended` | the delivery ended `failed` or `uncertain`, or the recipient was retired: no answer is coming. *Not in the brief's list;* it's what "failed or uncertain: the wait ends for that recipient" needs as a state |
| `answered` | `acknowledged` | the harness confirmed the agent saw it (fix pass 0.1, below): a tool result of the main turn the wait was created in carried the answer's complete proof markers. The CLI's `ack` is provisional and only records `printedAt` |
| `answered` | `fell-back` | not confirmed within `ACK_WINDOW_MS` (2 min) **after the wait ended** (fix pass 0.2): delivered **once** into the requester's thread, as a delivery with `fallback: true` that renders "may already have been returned to your waiting `comms send`" |

**Where an answer is taken (R2).** In the same Convex mutation that collects it (or that completes an `ambiguous` delivery with `comms reply`): if the wait holds an open result for that delivery and its CLI is awaiting, the result goes `open` → `answered` and the answer's delivery to the waiter is created and finished (`delivered`, detail "returned to the waiting send") in that one transaction. It's never pending, never claimed, never seen by the dispatcher, so the waiter's busy state and serial order don't matter. A connector restart loses nothing: the CLI keeps calling `await`, which reads the stored results. Before a waiting send and an `ack`, the connector refreshes the waiter's presence from T3 (its poll is every 20 s), so `busySince` is current. A minute cron (`waits.sweep`) does the fallbacks, expires waits past `until`, and deletes ended ones after the retention period.

`ambiguous` keeps a result `open` (the agent will finish it with `comms reply`).

**Two things an agent should know (fix pass 3):**
- **The 60-second hold.** The waiting CLI checks in with `await` every 25 s at most. If it hasn't checked in for 60 s (`WAIT_HELD_MS`), it's taken to be gone: the wait ends, its open results expire, and an answer arriving after that goes into the thread as a normal message, not into the call.
- **Codex.** A Codex command has no time limit but hands control back after about 10 s; the result reaches the model only if the agent keeps polling the shell session until `comms` exits. An agent that stops reading its shell may never see an answer printed there. Nothing is lost: T3 waits are never confirmed (0.1), so the answer is also delivered into the thread once, about 2 minutes after the wait ends. An `ack` and the fallback race on the same compare-and-set, so a result ends `acknowledged` or `fell-back`, and the fallback is sent at most once. `await` reads answers from the stored results, so a restarted connector serves them. A wait stops counting as busy waiting once no result is `open` (answered ones included) or at `until`; it and its results are kept `WAIT_RETENTION_MS` (7 days) after that for `await` and `comms status`. A waiting send to an agent that is itself in an active wait doesn't wait (`noWait.reason: "busy-waiting"`, naming them); with no agent to wait for it's `"nobody-to-wait-for"`.

`DEFAULT_WAIT_MS` is 100 s, under Claude Code's 120 s Bash default (H0 confirmed; Codex has no shell limit); `MAX_WAIT_MS` is 60 min. The usage text says: Claude Code agents raise the Bash timeout above the bound for any `--wait` over 100 s (600 s foreground maximum); Codex agents keep polling the shell session until `comms` exits.

### Reminders (R3)

- **Firing:** a minute cron (`reminders.tick`) handles expiries, then fires due `active` reminders (index `state, nextFireAt`). A fire is an ordinary request from `@reminders` to the target in their DM (`origin.via: "system"`, `meta.type: "reminder"`), so delivery, matching and recovery are the usual ones; the answer is collected and addresses no one, and is recorded on the fire (`reminderFires`, by the request's message id).
- **Skips** (kept on the reminder, newest 50): `previous-fire-not-final` (the last fire's delivery is pending, claimed or delivered, or ambiguous for less than one interval): the next fire is the next scheduled slot, so a slow answer skips fires and never piles them up. `not-idle` and `presence-stale` (with `idleForMs`, checked on `watch` or else the target; a machine not heard from for `PRESENCE_STALE_MS` never counts as idle): retried the next minute.
- **Stopping:** `--max n` ends it `done` after n fires; an `--at` reminder is `done` ("fired once") after its fire; every reminder expires (default 7 d, at most 30 d), active, paused or blocked alike; a retired target cancels it. Pausing or cancelling stops future fires only: a running fire's turn finishes and its answer is recorded.
- **Telling people:** when a reminder ends (done, cancelled, expired), its creator is told by `@reminders` (`renderReminderEnded`, `meta.type: "reminder-ended"`), unless they ended it themselves. With `reportTo`, each answer is posted to that participant (`renderReminderReport`, `meta.type: "reminder-report"`). These are **notices** (`kind: "notice"`, agreed with Hazel): only system participants post them; people get them in their inbox, agents a delivery that, like an answer's, ends at `delivered` and is never collected. The header says `kind=notice`; the rendering says no reply is expected and has no `comms reply` line. A notice's restart check is answered like an answer's (`found: yes, turn: completed`, no outcome). Alerts are notices too.
- **Who may change one:** its creator, its target, and the target's owner (`forbidden` otherwise). Who may view one: those, and its report-to (fix pass 0.4).
- **Lists (follow-up c):** `reminders` and the web list show every live reminder (active, paused, blocked) and only the most recent finished ones (per source for `reminders`; 15 of each finished state on the web, or the newest 50 when filtering by one), never the whole history.
- **Refused at creation (follow-up b):** a reminder that couldn't fire before it expires (`--at` must be at least a minute before the expiry; `--every` shorter than the time to expiry); a retired `--report-to`. A name made from the text drops control characters. A report-to retired later gets no report, and the fire records why (`reportError`).
- CLI: `comms remind @agent "text" (--every <d> | --at <time>) [--name] [--idle-for <d>] [--watch @x] [--max n] [--report-to @x] [--expires <d>]`, `comms reminders`, `comms reminder <id>`, `comms reminder pause|resume|done|cancel <id>`, `comms reminder blocked <id> "why"`.

### Alerts (R4)

A minute cron (`alerts.scan`) checks each condition, and opens an incident keyed by (cause, subject, owner) when one starts, posting one alert from `@alerts` to the owner (`renderAlert`, `meta.type: "alert"`; owners are people, so it lands in their inbox). An incident resolves when its condition clears; a recurrence is a new incident and a new alert (down, recovered, down: two). Recovery isn't announced.

| Cause | Holds while | Owner |
|---|---|---|
| `uncertain-delivery` | a delivery is `uncertain` | the recipient's |
| `connector-silent` | a machine with homed, unretired agents hasn't heartbeated for `connectorSilentMs` (10 min) | each owner of those agents |
| `reminder-blocked` | a reminder has been `blocked` for `reminderBlockedMs` (60 min) | the target's |
| `reminder-expired` | a one-off: alerted once when a reminder expires | the target's |
| `delivery-reclaimed` | an in-flight delivery has been claimed more than `maxClaims` (5) times (`claimCount`, counted by `claim`) | the recipient's |

Thresholds are the one `alertConfig` row (`alerts.setConfig`), defaults otherwise.

### The CLI: JSON and exit codes

`CLI_EXIT`, shared by the CLI and anything wrapping it:

| Code | Name | Meaning |
|---|---|---|
| 0 | `ok` | done; for a waiting `send` or `await`, every awaited answer arrived. Also 0 when the send went out without waiting: people only (in their inbox), `--continue`, or an addressee itself busy waiting (`noWait`); the output says which, and `comms status <id>` follows it |
| 1 | `refused` | the connector refused (the error code and message are on stderr) |
| 2 | `usage` | bad arguments |
| 3 | `unreachable` | no connector on the socket |
| 4 | `pending` | the bound was reached with results still open (or `expired`); the message id is printed and later answers go to the thread |
| 5 | `endedWithoutAnswer` | every result is final and none is pending, but at least one `ended` (failed, uncertain, retired) without an answer |

With `--json` each command prints exactly one JSON object on stdout, the connector's response (`{"ok": true, ...}`):

- `comms send` (waiting, the default from R2): the `send` result with `wait` replaced by the wait as it stood when the CLI stopped; answers are acknowledged after the object is printed. With `--continue`, the `send` result as before. A connector that answers a waiting send `unsupported` (older, or the stub) gets it again without waiting, and the CLI says so on stderr.
- `comms await <message-id>`: wait on a send that's still waiting, from another shell (a send run in the background, say), until the send's own bound; prints the final `await` result. It takes no `--wait`. After exit 4 the wait has ended (contract 0.2) and the remaining answers arrive in the thread; `comms status <id>` shows them.
- `comms status <message-id>`: the `message-status` result. `comms status` with no id is unchanged.

Durations on the command line are `<n>s|m|h|d` (`parseDuration`, `formatDuration`). `comms remind --at` takes ISO 8601 with a time (`2026-10-01T14:30Z`; no zone means local) or `HH:MM`, the next time it's that time locally (`parseAt`); a date alone is refused. `reminder-update` with `blocked` needs a non-blank `reason` (the decoder refuses it otherwise).

### Renderings

- A **reminder fire** is an ordinary request from `@reminders` in the target's DM with it, rendered by `renderDelivery` with a `Reminder: <name> (id …), set by @x, every 30m. Fire n.` line (`formatSchedule`: `every 30m`, or `once at 2026-10-01 14:30 UTC`) and how to `comms reminder done` or `blocked` it.
- The **fallback** answer delivery (`fallback: true`) says it may already have been returned to the waiting send.
- `renderReminderReport`, `renderReminderEnded` and `renderAlert` are the texts `@reminders` and `@alerts` post.

### Convex functions the web view calls

All take `adminToken`. Errors are `ConvexError`s with `{code, message}` as above.

| Function | Args | Returns |
|---|---|---|
| `registry.list` | — | `{agents: RegistryEntry[]}`: every participant, any state, with homes |
| `registry.setProfile` | `name`, `description?`, `duties?` (empty clears) | `{agent}` |
| `inbox.list` | `human`, `unreadOnly?`, `limit?` (≤ 200), `cursor?` (the previous page's `nextCursor`: opaque, exact even when items share a timestamp) | `{items: InboxItem[], unread, hasMore, nextCursor?}`, newest first |
| `inbox.unreadCount` | `human` | `{unread}` |
| `inbox.markRead` | `human`, exactly one of `messageIds` and `conversationId` | `{marked, unread}` |
| `reminders.list` | `state?` | `{reminders}`, newest first, each with `lastFire` (message, delivery state, fired at) and `lastSkip` |
| `reminders.get` | `id` | `{reminder, fires, skips}` |
| `reminders.create` | `as` (a person), then as `remind` | `{reminder}` |
| `reminders.update` | `id`, `action`, `reason?` | `{reminder}` |
| `alerts.list` | `openOnly?`, `limit?` | `{alerts: Alert[]}`, newest first, each with the `conversationId` of its DM (and `subject.conversationId` for a delivery) |
| `alerts.config` | — | `AlertConfig` (defaults until set) |
| `alerts.setConfig` | any of `connectorSilentMs`, `reminderBlockedMs`, `maxClaims` | `AlertConfig` |

`directory.list` and the conversation functions are unchanged. Presence in a `RegistryEntry` is `null` for people and system participants, and `stale` when the agent's machine hasn't heartbeated for `PRESENCE_STALE_MS` (90 s); `idleSince` and `busySince` move only on the transition to idle and busy.

## Fix pass contract (section 0, `docs/06-capabilities-fix-pass.md`)

This replaces the R2 ack rule (busy, not stale, `busySince`), which a T3 turn ending and another starting within one presence poll defeated (Reed's and Alder's reproductions).

### 0.1 Proof the agent saw an answer

- **The waiter's turn.** A waiting send by a Claude Code agent is stamped with its current **main** turn, from the mod's `presence` (`turnId`, sent at every main turn's start, even while already busy) or `register` (`turnId`, for a session re-registering mid-turn after a connector restart); the connector adds it to the Convex `send` as `waiterTurnId`. Waits by any other agent (T3, Codex), or whose turn isn't known, have none: nothing can confirm them, and their answers fall back once.
- **The markers** (`proof.ts`). For each answer it prints, the waiting CLI (`send` and `await`, text mode) prints `renderAnswerWithProof`: the heading, a begin line, the answer indented by two spaces, and an end line carrying the length of the indented answer. Both lines carry the wait id, the answer's message id and the result's **proof token**: 32 random hex characters, made when the result becomes `answered`, returned only in the waiter's own `send` and `await` responses (`WaitResult.proofToken`), and never in `message-status`, `read`, the web view or the thread. So a status listing, a `comms read` or quoted text can't carry a proof, and no answer line can be a marker.
- **`findAnswerProofs`** is the one parser: both lines whole, at column 0, matching wait, message and token, with exactly `chars` characters between them. A missing end line (truncation at the end) or a cut middle (Claude Code's "[… characters truncated]") is no proof.
- **The harness confirms; the CLI doesn't.** The tool result only exists after the CLI exits, so the CLI's `ack` is provisional (`printedAt`). Confirmation is the new loopback operation `answer-seen {sessionId, turnId, proofs[]}`:
  - **Claude Code (the mod):** on each `tool.call` of the main loop (no `e.agentId`: a helper subagent's results never reach the main model), run `findAnswerProofs` on the text `next(e)` resolves with (the result as the model reads it, after Claude Code's own truncation), and if it finds any, queue `answer-seen {sessionId, turnId: the running main turn, proofs: [{waitId, messageId, token}]}`. A backgrounded call's text is the "moved to the background" message, with no markers, so it doesn't confirm.
  - **T3: never confirms, so every T3 answer arrives twice (follow-up 10).** A T3 agent's waiting `comms send` gets the answer in the call, and the same answer again in its thread about 2 minutes after the wait ends, marked "may already have been returned to your waiting `comms send`". That's the rule, not a fault: T3 can't show us that the agent saw the call's output. T3 (v0.0.44) shows the adapter only a one-line preview of each tool's output, clipped to 84 characters before it's stored, so an end marker can never reach it; and Codex's output can be attached to a later turn that no model read (Hazel, `validation/capabilities-fix/t3-tool-output/`, `docs/t3-api-notes.md` section 11). So every T3 waiting send falls back once, Claude and Codex alike. The adapter sends nothing.
  - **Harness-neutral:** the Convex side (`connector.answerSeen`) takes the waiter, a turn id and proofs, whoever found them; it doesn't know which harness reported. A later, weaker T3 proof (if Lee accepts one) would be the adapter calling the same thing and stamping T3 waits with a turn; nothing else changes. Not built now.
  - **Where each check happens (follow-up 8).** The **connector's loopback** binds the report to a session: `answer-seen` is accepted only from a live, current session (`unknown_session` or `session_superseded` otherwise), and the participant it reports for is that session's own, never one named in the request. The waiter's turn comes from the same place (`presence` and `register` from that session). **Convex** (`connector.answerSeen`) then confirms each proof only if: the connector's machine is the participant's home; that participant is the wait's waiter; `turnId` equals the wait's `waiterTurnId`; the token matches; and the result is still `answered` (compare-and-set to `acknowledged`; a result that already fell back stays `fell-back`). Convex doesn't know about sessions. Anything else is ignored, not an error, so a stale or replayed report is harmless.
- **No proof, falls back:** a backgrounded CLI, any T3 agent (Claude or Codex), a helper's call, truncated output, `--json` (below), and **any answer over about 30,000 characters in Claude Code** (it shows the model a persisted 2 KB preview instead: Hazel, `validation/capabilities-fix/claude-code-tool-output/`). A stale `waiterTurnId` (the new turn's `busy` not yet arrived) never matches the real turn's proof, so that falls back too. The cost is an occasional duplicate, never a lost answer.

### 0.2 When the fallback timer starts

- A wait's `endedAt` is set **once** when it ends: no result is `open` (answered counts as not open), `until` passes, or its CLI stops checking in. Stopped checking in means no `await` for `WAIT_HELD_MS` (60 s); then `endedAt` is the last check-in plus `WAIT_HELD_MS`, the wait stops being active, and its open results expire.
- A result still `answered` at `endedAt + ACK_WINDOW_MS` falls back once (the minute sweep, over `answered` results only, so finished history isn't scanned). Not counted from when the answer arrived: an early answer in a group wait doesn't fall back while the CLI is still waiting for the others.
- A crashed CLI can't postpone it, and a CLI reconnecting afterwards (`await` on an ended wait) doesn't move `endedAt`. The due fallback still happens, once.

### 0.3 `--json`

One JSON object, printed after the wait ends; the provisional `ack` follows the printing. `--json` carries no proof markers, so a `--json` waiting send is never confirmed and each answer falls back once after the window (a wrapper that wants no duplicates reads the text output).

### 0.4 Reminder detail access

`reminder` (the detail: text, fires, answers) and `reminders` (the list, which shows text) return only reminders the caller created, is the target of, owns the target of, or is the report-to of. Anyone else gets `forbidden` (403, new). `reminder-update` keeps its rule (creator, target, target's owner) and now refuses with `forbidden` instead of `conflict`. The web view (admin) sees all.

## Not in the contract

Automatic identity (stock T3 gives an agent no way to learn its own thread id), per-agent credentials, exactly-once execution, and delivery of a message the connector hadn't yet written to Convex when it crashed. See `docs/00-overview.md`, Delivery guarantees.
