# @agent-comms/protocol

The agent-comms contract, and its single source of truth. Plain TypeScript: no dependencies, no Node APIs, erasable syntax only, relative imports with `.ts` extensions. Convex, the connector, the adapters, the `comms` CLI, the Claude Code mod and the web app all import it.

| File | What |
|---|---|
| [`src/model.ts`](src/model.ts) | Participants, homes, conversations, the message envelope, deliveries and their states |
| [`src/history.ts`](src/history.ts) | `boundHistory`: the capped recent history a delivery carries |
| [`src/render.ts`](src/render.ts) | `renderDelivery` (how a delivery is shown to a model) and `parseDeliveryHeader` |
| [`src/loopback.ts`](src/loopback.ts) | The connector's local protocol: socket path, operations, request decoders, response types, errors |

The types and the comments on them are the specification. This page is the tour.

## Using it from the mod

The mod runs in Claude Code's own module environment (no Node, imports only from inside the plugin folder). Everything in `src/` works there. The mod needs `renderDelivery`, `parseDeliveryHeader`, `opPath`, `parseResponse`, `socketPath` and the types; copy or bundle `src/` into the plugin (how is Hazel's call). If the mod's tsconfig uses `moduleResolution: "bundler"`, add `"allowImportingTsExtensions": true` for the `.ts` imports.

## The envelope

`MessageEnvelope` (model.ts): id, conversation id, per-conversation `seq` (from 1, no gaps), `sender`, `recipients` (the addressed participants: only they're woken), `kind` (`request` | `answer`), `inReplyTo` (on answers), `collectedFrom` (only on an answer collected automatically from a delivery's turn), text, attachment references (never bytes), created time, and `origin` (`via`: `t3` | `claude-code` | `cli` | `web`, plus an optional external id for echo suppression).

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
| `send` | CLI | `as`, `to[]`, `conversationId?`, `text`, `attachments?` | `message`, `deliveries`, `skipped` |
| `reply` | CLI | `as`, `messageId`, `text`, `attachments?` | as `send`, plus `completed?` |
| `read` | CLI | `as`, `conversationId`, `before?`, `limit?` (≤ 100) | `conversation`, `messages` (oldest first), `hasMore` |
| `list` | CLI | `as` | `conversations` (most recent first) |

Rules that matter to clients:

- **Register** again with the same `sessionId` after the connector restarts: any call answering `unknown_session` means register, then retry that call. A different session for the same participant supersedes the old one, whose polls then fail with `session_superseded`: stop polling.
- **Poll** is held until there's an item or the wait passes, then answered, possibly with no items. The bound is the connector's, because the mod's fetch has no timeout. One outstanding poll per session; a second fails with `poll_in_progress`. If the client disconnects, nothing is handed out on that poll.
- **Serial per participant:** a participant gets its next delivery only after the previous one is finished (a request replied, ambiguous, failed or uncertain; an answer delivered).
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
| `unknown_conversation`, `unknown_message`, `unknown_delivery` | 404 | no such id |
| `unknown_session` | 404 | session not registered here: register again |
| `session_superseded` | 409 | a newer session took over this participant: stop |
| `poll_in_progress` | 409 | this session already has a poll outstanding |
| `conflict` | 409 | the delivery isn't this session's, or the state change doesn't fit |
| `unavailable` | 503 | the connector can't reach Convex right now: retry later |
| `internal` | 500 | anything else, including a malformed response (`parseResponse`) |

## Not in the contract

Automatic identity (stock T3 gives an agent no way to learn its own thread id), per-agent credentials, exactly-once execution, and delivery of a message the connector hadn't yet written to Convex when it crashed. See `docs/00-overview.md`, Delivery guarantees.
