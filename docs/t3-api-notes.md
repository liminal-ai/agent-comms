# T3 v0.0.44 API notes for the T3 adapter

For Cedar, from Hazel. Checked against the v0.0.44 source (`packages/contracts/src/orchestration.ts`,
`rpc.ts`, `environmentHttp.ts`; server `orchestration/decider.ts`, `ProviderCommandReactor.ts`,
`ProjectionPipeline.ts`, `ws.ts`; web `ChatView.tsx`, `queuedMessageStore.ts`) and live runs on the
fresh install at `http://127.0.0.1:3780` on 2026-09-30. Raw event recordings are in
`/srv/agents/hazel/t3code-v044/validation/runs/` (named below); the client that produced them is
`validation/probe/{t3.ts,cli.ts,scenario.ts}` in the same checkout.

## Summary: what changes for the adapter

1. **A user message never carries a turn id.** `thread.message-sent` for a user message always has
   `turnId: null`, in the live event and in every later snapshot. The turn your message went into
   is only visible through the session: the `thread.session-set` events after it (`activeTurnId`)
   and `latestTurn`. The plan's "message-sent carries messageId and turnId" holds for assistant
   messages only.
2. **`thread.turn.start` on a busy thread steers, on all three providers.** Accepted (a receipt,
   never a rejection), the message joins the running turn, same `turnId`, one combined answer.
3. **Lee typing in the web UI during our turn usually lands in our turn.** The composer's default
   "queue" mode sends the held message as a steer as soon as any tool call finishes after it was
   typed; it waits for the turn to end only if no tool call follows.
4. **An interrupted turn looks completed.** Session goes `ready` (Claude then `stopped`),
   `latestTurn.state` is `completed`. A steered message is dropped by the interrupt.
5. **Claude starts turns with no user message** when a background task it launched finishes. The
   real result of a request can arrive in such a turn after ours has ended.
6. You can do everything over plain HTTP except live events: `POST /api/orchestration/dispatch`,
   `GET /api/orchestration/threads/:threadId`. Events need the WebSocket `subscribeThread`.

## 1. Connecting and authenticating from an outside process

- Auth policy on this install: `loopback-browser`. Outside processes use a **bearer access token**.
- **Long-lived credential for the connector:** `t3 auth session issue` with the server's own CLI,
  against the same home. It writes to the auth store the running server reads, so it works at once:
  ```
  cd /srv/agents/hazel/t3code-v044
  node apps/server/dist/bin.mjs auth session issue --base-dir ~/.t3code-v044 \
    --ttl 365d --label agent-comms-connector --subject agent-comms --token-only > <0600 file>
  ```
  Scopes: `orchestration:read orchestration:operate terminal:operate review:write relay:read
  relay:write access:read access:write`. List without secrets: `auth session list`; revoke:
  `auth session revoke`. One is already minted: `~/.config/agent-comms/t3-3780.token` (0600, one
  line, expires 2027-09-30).
- The pairing route also exists (one-time pairing token, 5-minute TTL, `POST /oauth/token` →
  bearer; `bootstrapRemoteBearerSession` in `@t3tools/client-runtime/authorization`), but the
  pairing URL is printed to the server log, so prefer `auth session issue`.
- **HTTP:** `Authorization: Bearer <token>`. `GET /api/auth/session` verifies it.
- **WebSocket:** `POST /api/auth/websocket-ticket` with the bearer returns a short-lived ticket;
  connect to `ws://127.0.0.1:3780/ws?wsTicket=<ticket>`. `resolveRemoteWebSocketConnectionUrl`
  does both steps. RPC is Effect RPC over JSON (`RpcClient.make(WsRpcGroup)`, i.e.
  `makeWsRpcProtocolClient` from `@t3tools/client-runtime/rpc`). Mint a new ticket per
  (re)connect. Never log the token or the ticket URL.
- Ids (`ThreadId`, `MessageId`, `CommandId`, …) are any trimmed non-empty string. **You choose the
  `messageId`**, so it can carry the delivery id; T3 stores it verbatim. The `imported-agent-session`
  namespace is reserved.

## 2. Methods

| What | WebSocket RPC | HTTP |
|---|---|---|
| Dispatch a command | `orchestration.dispatchCommand` | `POST /api/orchestration/dispatch` |
| Thread snapshot | first item of `orchestration.subscribeThread` | `GET /api/orchestration/threads/:threadId` → `{ snapshotSequence, thread }` |
| Live thread events | `orchestration.subscribeThread { threadId, afterSequence? }` | none |
| All threads (shell) | `orchestration.subscribeShell` | `GET /api/orchestration/shell` |
| Providers | `server.getConfig` (`providers[]`) | |

- Dispatch returns `{ sequence }` when the command is accepted; a rejected command fails the call.
  Acceptance means persisted, not that the provider started.
- `subscribeThread { threadId }` sends one `snapshot` item, then `event` items. With
  `afterSequence: <snapshotSequence>` it replays persisted events after that point instead of a
  snapshot (bounded: 1000 events / a byte budget; past that, or for a recreated thread, you get a
  snapshot). That is the restart path: HTTP snapshot, then subscribe from its sequence.
- Snapshots are the full thread unless you pass `turnLimit` (then paged with `beforeCursor`).

### Commands you need

```ts
{ type: "thread.turn.start", commandId, threadId,
  message: { messageId, role: "user", text, attachments: [] },
  runtimeMode: "full-access" | "auto" | "auto-accept-edits" | "approval-required",
  interactionMode: "default" | "plan", createdAt }
{ type: "thread.turn.interrupt", commandId, threadId, turnId?, createdAt }
```
`project.create` and `thread.create` (`modelSelection: { instanceId, model }`) for fixtures.

## 3. Events on `subscribeThread`

Only six event types are streamed: `thread.message-sent`, `thread.session-set`,
`thread.activity-appended`, `thread.proposed-plan-upserted`, `thread.turn-diff-completed`,
`thread.reverted`. **`thread.turn-start-requested` (the one that carries our messageId next to the
turn request) is not streamed.**

Observed sequence for one turn (`runs/codex-1.jsonl`, `runs/native-1.jsonl`):

```
thread.message-sent   role=user  messageId=<ours>  turnId=null  streaming=false
thread.session-set    status=starting  activeTurnId=null
thread.session-set    status=running   activeTurnId=T          ← turn started
thread.activity-appended  tool.started / tool.completed / task.started …  turnId=T
thread.message-sent   role=assistant  messageId=assistant:…  turnId=T  streaming=true  text=<chunk>
thread.message-sent   role=assistant  (same id)  turnId=T  streaming=false  text=""   ← message final
thread.activity-appended  context-window.updated
thread.session-set    status=ready  activeTurnId=null            ← turn over
```

- **User message appended:** `message-sent` with `role: "user"`, `turnId: null`. UI-typed and
  injected messages are the same event; the only difference is the `messageId` (the web client
  mints its own).
- **Turn started:** first `session-set` with `status: "running"` and a new `activeTurnId`.
- **Assistant text:** `message-sent` `role: "assistant"`, streamed as chunks; the final event for a
  message has `streaming: false` and **empty `text`**; concatenate the chunks, or read the snapshot
  afterwards. A turn can have several assistant messages; the answer is the last one
  (`latestTurn.assistantMessageId` in the snapshot). `role: "system"` messages
  (`reasoning:summary:…`) are reasoning summaries, not answers.
- **Turn over:** `session-set` with `activeTurnId: null` and `status` `ready` (completed or
  interrupted), `interrupted` (runtime `turn.aborted`), `error` (failed; `lastError` set) or
  `stopped` (session gone). Snapshot `latestTurn = { turnId, state, requestedAt, startedAt,
  completedAt, assistantMessageId }`.
- **Session status:** busy = `starting` or `running`; idle = `ready`, `interrupted`, `stopped`,
  `error`, or no session. Several `session-set` events repeat the same state; dedupe.
- **Turn start failed:** `activity-appended` with `kind: "provider.turn.start.failed"` whose
  payload `requestId` is **our messageId** (also used for "compaction unavailable while a turn is
  running"). Useful to fail a delivery without waiting.

## 4. `thread.turn.start` on a busy thread

Live, same scenario on each provider (`runs/steer-{native,lhc,codex}.jsonl`): turn A runs a 25 s
shell command; 5 s in, turn B is dispatched.

| Provider | Receipt | Where B went | B's `message-sent` turnId | Result |
|---|---|---|---|---|
| native Claude (claude-sonnet-5-5) | accepted | into A (steer) | null | one answer in A: `FIRST-DONE SECOND-SEEN` |
| Claude-LHC (claude-sonnet-5-5) | accepted | into A (steer) | null | one answer in A: `FIRST-DONE SECOND-SEEN` |
| Codex (gpt-5.6-luna) | accepted | into A (steer) | null | one answer in A: `FIRST-DONE SECOND-SEEN` |

- Code: the Claude adapter treats a `sendTurn` while a non-synthetic turn runs as a steer (the
  message is queued into the live SDK loop, same turnId). LHC uses the same adapter; the sidecar
  holds prompts that arrive during a compact swap and replays them into the new generation.
- **Race at turn end** (seen once, native Claude, first attempt): B's `message-sent` arrived in the
  same millisecond as A's `session-set ready`; B then started a **new** turn. So "the session said
  running when my message was appended" does not prove the message went into that turn.
- The only server-side queue is during compaction: turn starts that arrive while a thread is
  compacting are held and sent after it (`turnsAfterCompaction`). A `/compact` while a turn runs is
  refused with a `provider.turn.start.failed` activity. Otherwise there is no follow-up queue
  (confirmed).

### How to tell which turn is ours

Given that the message carries no turn id, a rule that never guesses:

- Dispatch our turn only when the thread is idle (`activeTurnId: null`, status not
  `starting`/`running`).
- After our `message-sent`, the first `session-set` with `status: running` and an `activeTurnId`
  different from any turn seen before our message is our candidate turn T.
- If any other user `message-sent` (a messageId that is not ours) arrives between our message and
  T's end, the delivery is **ambiguous**, whichever turn it went into (it may have steered into T,
  or started a turn that raced ours).
- If a turn was already running when our message was appended (we raced someone), or the session
  never showed a new turn, the delivery is **ambiguous**.
- A turn that starts with no user message (see §7) is never ours.

## 5. A person typing into the thread while our turn runs

Web client, `followUpBehavior` setting (client-side, default `"queue"`):

- **Steer mode** (or the alternate send in queue mode): the message is dispatched at once as
  `thread.turn.start` → steers into our turn, same turnId (§4).
- **Queue mode (default):** the message is held in the browser. It is sent (as a steer) as soon as
  a `tool.completed` activity appears after it was queued; if the turn ends first, it is sent as a
  new turn. So in a turn with tool calls, Lee's message almost always enters our turn. The held
  message lives only in that browser tab.
- Either way the connector sees a user `message-sent` with a foreign messageId while our turn is
  active or just ending → ambiguous by the rule above. A message sent after our turn's
  `session-set ready` cannot be in our turn.
- Its turnId is never ours to read: user messages have none.

## 6. `thread.turn.interrupt`

Live (`runs/interrupt-{native,lhc,codex}.jsonl`): A running, B steered in, interrupt 3 s later.

| Provider | Session events after interrupt | `latestTurn.state` | Steered B |
|---|---|---|---|
| native Claude | `ready` (activeTurnId null), then `stopped` 2 s later | `completed`; `assistantMessageId: null` here (interrupted before any text streamed) | dropped, never answered |
| Claude-LHC | `ready`, then `stopped` | `completed`, `assistantMessageId: null` (same) | dropped |
| Codex | `ready` | `completed`, assistant message = the partial text so far | dropped |

- The Claude adapter's interrupt stops the whole provider session; the next `thread.turn.start`
  starts a new one (the conversation resumes; LHC rebuilds from its store).
- **No streamed event says "interrupted"** for these providers: the runtime reports
  `turn.completed` with state `interrupted`, which the server maps to session `ready`. The
  projection even records the turn as `completed`. The adapter can only know it interrupted a turn
  if it issued the interrupt itself; a turn Lee stops from the UI looks like a completed turn
  whose last assistant message may be partial or absent. Correction from Cedar's live run
  (validation/m3 in his lane): a Claude interrupt after text started streaming is recorded as
  `completed` with `assistantMessageId` set to the partial message. The tell for Claude is the
  session going `ready` then `stopped` right after; his adapter watches for that. Codex has no tell.
- The `turnId` on the interrupt command is optional; without it the active turn is interrupted.

## 7. Claude turns with no user message

When Claude Code backgrounds a long command (it does so on its own after ~3 s, as a `local_bash`
task), the turn can end first; when the task finishes, Claude wakes and runs a **new turn with no
user message** (live: native `58654a40…`, LHC `1744a279…` and `032be7aa…`, in
`runs/steer-*` first attempts). The real result of a request can arrive there, after our turn's
answer was collected. Treat such turns as not ours (they are the follow-up case: the agent should
`comms reply`). Codex did not background in these runs.

## 8. Finding a message by id (restart check)

- `GET /api/orchestration/threads/:threadId` → `thread.messages[]` (`id`, `role`, `text`,
  `turnId`, `streaming`, `createdAt`), `thread.latestTurn`, `thread.session`, `thread.activities[]`
  (with `turnId`), `snapshotSequence`. Look for our `messageId` in `messages`.
- Found and nothing after it: delivered, turn not started or still running (check `session`).
- Found with later messages: the assistant messages after ours (by order) carry the turn id(s);
  the answer is the last assistant message of that turn; `latestTurn` tells whether it finished.
  The link from our message to that turn is positional, not recorded in the API (the server keeps a
  `pendingMessageId` on its turn projection but does not expose it).
- Not found: never delivered.
- Then `subscribeThread { threadId, afterSequence: snapshotSequence }` to continue without gaps.

## 9. What v0.0.44 doesn't expose (the adapter has to live with it)

1. The user message → turn link (`pendingMessageId` exists server-side, not in any API).
2. An interrupted-vs-completed distinction on the stream or in `latestTurn` for Claude and Codex.
3. `thread.turn-start-requested` on the stream.
4. The agent's own thread id: no env var, no T3 MCP tool (`t3-code` tools are device, preview and
   pull-request tools). Identity stays `--as` (confirmed).
5. A way to insert a message "for the next turn": every send while busy is a steer.
6. The web client's queued messages are invisible to the server until they are sent.

## Test fixtures on 3780

Project `proj-bacff64b-618b-40a7-87c1-8b89205d3d9e` (`/srv/agents/hazel/t3-workspace`):
native Claude `thr-2b9246c9-4806-4d5d-bff5-3dca6ede7d49`, Claude-LHC
`thr-36b7d422-6756-4668-b4fa-96e40d3679b6`, Codex `thr-abad70c6-298e-445d-9570-aae607cea3fb`.
