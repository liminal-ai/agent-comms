# T3 orchestration protocol v2: porting reference for adapter-t3

Source: T3 Code at `8ed276c` (v0.0.46 nightly), checkout `/srv/work/t3code-v2-stock`. Read from source only; nothing was run, no server touched, no token read.
Paths below are relative to that checkout unless they start with `/srv/agents`. "unverified" marks anything I inferred rather than read.

Short version of what changes:

1. **There is no HTTP dispatch any more.** Starting a turn is a WebSocket RPC (`orchestration.dispatchCommand`). HTTP only reads snapshots.
2. **Our message now links to its run explicitly**: `run.userMessageId === <our messageId>`. The positional "our message, then the turn that started" inference, `startedBy()` and the `requestedAt` clock comparison are all unnecessary.
3. **A dispatch on a busy thread is queued as its own run by default** (`start_immediately`). It only steers if the caller asks. So "joined a running turn" can no longer happen by accident.
4. **Interrupts, failures and cancellations are real run states**, not a `completed` turn that happens to look odd.
5. **Tool/command output text is removed on the wire** (stricter than the old 84-char preview).
6. The dispatch result is only `{ sequence }`. Run and attempt ids come from the event stream or a snapshot, never from the result.

---

## 1. Transport and auth

### What exists

| Purpose | Route | Notes |
|---|---|---|
| Environment descriptor | `GET /.well-known/t3/environment` (`packages/contracts/src/environmentHttp.ts:430`) | Field `orchestrationProtocolVersion` (`packages/contracts/src/environment.ts:205`, optional Int). Absent means a pre-negotiation server, treated as 1 (`packages/client-runtime/src/connection/compatibility.ts:13`). |
| Session check | `GET /api/auth/session` (`environmentHttp.ts:437`) | Bearer. |
| WS ticket | `POST /api/auth/websocket-ticket` (`environmentHttp.ts:459`) | Bearer in, ticket out. Same as today. |
| Pairing exchange | `POST /oauth/token` (`environmentHttp.ts:451`) | One-time pairing token to access token. |
| Thread snapshot (full) | `GET /api/orchestration/threads/:threadId` (`environmentHttp.ts:535`) | Returns `OrchestrationV2ThreadDetailSnapshot` = `{ snapshotSequence, projection, historyCursor?, hasMoreHistory?, latestLocalTurnOrdinal? }` (`packages/contracts/src/orchestrationV2.ts:3001-3017`). Handler returns only `snapshotSequence` and `projection` (`apps/server/src/orchestration-v2/http.ts:184-196`). It is the full thread, not windowed (`loadThreadSnapshot`, `http.ts:108-126`, uses `getThreadSnapshot`). |
| Thread snapshot (bounded) | `GET /api/orchestration/threads/:threadId/bounded` (`environmentHttp.ts:543`) | Recent window plus `historyCursor` (`orchestrationV2.ts:3024-3038`). Full control-plane arrays (`runs`, `attempts`, `providerTurns`), windowed timeline rows (`visibleTurnItems`). |
| History page | `GET /api/orchestration/threads/:threadId/history?cursor=` (`environmentHttp.ts:551`) | Older timeline rows only. |
| Shell | `GET /api/orchestration/shell` (`environmentHttp.ts:528`) | |
| **Dispatch** | **WebSocket only**: RPC `orchestration.dispatchCommand` | `ORCHESTRATION_V2_WS_METHODS` (`orchestrationV2.ts:2867-2879`), defined `packages/contracts/src/rpc.ts:1497-1501`. There is no `/api/orchestration/dispatch` route in `EnvironmentOrchestrationHttpApi` (`environmentHttp.ts:526-558`). |
| Thread events | WebSocket RPC `orchestration.subscribeThread` (stream) | `rpc.ts:1574-1579`. |
| Snapshot over WS | `orchestration.getThreadProjection` | **Windowed** (`apps/server/src/ws.ts:1853-1884`, row limit `THREAD_HISTORY_SNAPSHOT_ROW_LIMIT`). Prefer the HTTP full snapshot for restart checks. |

### Authentication

- Bearer access token, unchanged in shape: `Authorization: Bearer <token>` on HTTP; WS uses `wsTicket` from `/api/auth/websocket-ticket`. The server reads the ticket from the upgrade URL (`apps/server/src/auth/EnvironmentAuth.ts:1075-1095`, param name at `:517`). Client-side recipe: `resolveRemoteWebSocketConnectionUrl` (`packages/client-runtime/src/authorization/remote.ts:201-224`).
- Scopes (`apps/server/src/auth/RpcAuthorization.ts:25-35`): `dispatchCommand` needs `AuthOrchestrationOperateScope`; `subscribeThread` and `getThreadProjection` need `AuthOrchestrationReadScope`. HTTP thread routes need the read scope (`http.ts:187`).
- Long-lived token: `auth session issue` still exists (`apps/server/src/cli/auth.ts:162-188`) and grants `AuthAdministrativeScopes`. Whether the 0.0.44 token in `~/.config/agent-comms/t3-3780.token` is valid on a 0.0.46 server depends on whether it shares the auth store/home (unverified). Plan to issue a new one against the new home.

### Protocol version negotiation (three places, all must say 2)

`ORCHESTRATION_PROTOCOL_VERSION = 2`, text `"2"`, query param `orchestrationProtocol`, header `x-t3-orchestration-protocol` (`packages/contracts/src/environment.ts:13-16`).

1. **WS upgrade URL must carry `?orchestrationProtocol=2`** (together with `wsTicket`). Otherwise the server answers HTTP **426** with JSON `{ code: "orchestration_protocol_incompatible", message, orchestrationProtocolVersion: 2 }` (`apps/server/src/ws.ts:3733-3741`; check at `ws.ts:508-513`). Our `wsTicket` URL builder (`adapter-t3/src/t3/client.ts:51-59`) needs `url.searchParams.set("orchestrationProtocol", "2")`. Reference: `appendOrchestrationProtocol` (`client-runtime/src/connection/compatibility.ts:26-30`).
2. **HTTP `/api/orchestration/*` requires header `x-t3-orchestration-protocol: 2`** (schema literal, `environmentHttp.ts:65-70`, applied to all four orchestration endpoints `:529,536,544,552`). Missing or wrong value fails request decoding; the exact status code is unverified.
3. Descriptor field `orchestrationProtocolVersion` (above). Use it as a preflight: fail with a clear "server speaks protocol N" instead of a 426 or decode error.

### What our code does today

`packages/connector/src/t3.ts` is only an 18-line shim from `T3Adapter` to `HarnessAdapter`; it has no transport. The transport is `packages/adapter-t3/src/t3/client.ts`:

- `startTurn` does `POST ${baseUrl}/api/orchestration/dispatch` with a `thread.turn.start` body (`client.ts:128-153`). **Dead on v2.**
- `getThread` does `GET /api/orchestration/threads/:id[?turnLimit=N]` and reads `{ snapshotSequence, thread }` (`client.ts:116-125`). **Changes**: no `turnLimit` param, no `thread` key, needs the protocol header.
- WS: ticket, then `/ws?wsTicket=…`, then Effect RPC JSON, call `orchestration.subscribeThread` with `{ threadId, requestCompletionMarker: true, afterSequence? }` (`client.ts:46-59, 100-110, subscribe at ~150`). The RPC name and input are unchanged; add the protocol query param and decode the new item shape.
- Header comment `client.ts:3-6` and `t3/wire.ts:6-12` document the old routes; both need rewriting.

---

## 2. `message.dispatch`

### Exact shape (`packages/contracts/src/orchestrationV2.ts:2629-2665`)

```ts
{
  type: "message.dispatch",
  commandId: CommandId,           // required
  threadId: ThreadId,             // required
  messageId: MessageId,           // required, you choose it
  text: string,                   // required
  attachments: ChatAttachment[],  // required (send [])
  createdBy: "user"|"agent"|"system",                    // required (OrchestrationV2CreationFields, :85-88)
  creationSource: "web"|"mobile"|"mcp"|"provider"|"server", // required
  dispatchMode:                   // required
    | { type: "start_immediately" }
    | { type: "queue_after_active" }
    | { type: "defer_start" }                              // internal "preparing" flow
    | { type: "steer_active",   targetRunId: RunId }
    | { type: "restart_active", targetRunId: RunId },
  // optional: deliveryIntent: "auto"|"steer"|"restart", modelSelection, context, titleSeed,
  //           sourcePlanRef, scheduledTaskId, senderThreadId, notification, delegatedCompletion,
  //           restartContinuationOfRunId, usageLimitContinuationOfRunId, manualContinuationOfRunId,
  //           usageLimitRecoveryRequestId
}
```

- No `runtimeMode`, `interactionMode`, `createdAt` or `role` on the command. Those are thread settings now (`thread.runtime-mode.set`, `thread.interaction-mode.set`, `orchestrationV2.ts:2604-2615`). Drop them from `startTurn`.
- Reference client builds the same thing: `packages/client-runtime/src/operations/commands.ts:684-704` (`"start"` mode is exactly `{ type: "start_immediately" }`).
- **Provenance is forced**: the WS handler overwrites `createdBy` with `"user"` and keeps the `creationSource` you sent (`ws.ts:1759-1763`, `ThreadManagementService.ts:44-58`). The fields must be present and valid, but you cannot mark messages as agent-created through this RPC. Mark ours by `messageId` convention instead. `"mcp"` is the honest `creationSource`.
- Attachments: `ThreadMessageIntake.dispatchCommand` claims pending uploads for `message.dispatch` (`apps/server/src/orchestration-v2/ThreadMessageIntake.ts:126-163`). `[]` is fine.
- Side effect: dispatching to a settled or snoozed thread un-settles / un-snoozes it and emits `thread.unsettled` / `thread.unsnoozed` (`Orchestrator.ts:4194-4237`).

### Ids and idempotency

- **`commandId` is the idempotency key.** Receipts are stored per command id (`CommandReceiptStore.ts:51-60`). `dispatchWithReceiptEffect` (`Orchestrator.ts:9278-9338`), under the per-thread lock (`:9465-9466`):
  - existing *accepted* receipt for the same thread: returns the original `resultSequence`, does not re-run (`:9298-9338`). Safe to retry blindly.
  - existing *rejected* receipt: fails with `OrchestratorCommandPreviouslyRejectedError` "Command X was previously rejected: …" (`:9300-9306`, class `:183-194`). A rejected commandId stays rejected: mint a new `commandId` to try again (the `messageId` can stay, nothing was committed).
  - same commandId on a different thread: `OrchestratorCommandIdConflictError` (`:9310-9318`, class `:196-208`).
  - a command that plans zero events fails ("Command produced no domain events", `:9340-9353`) and is recorded as rejected (`:9354-9388`).
- **`messageId` is stored verbatim** as `ConversationMessage.id` and `Run.userMessageId`. I found no server-side dedupe on `messageId` for ordinary messages (the only `messageId` duplicate check is for delegated completions, `Orchestrator.ts:4339-4340`). So duplicate detection must rely on `commandId`; use `messageId` for finding the message afterwards.
- Recommended: derive `commandId` deterministically from the delivery id (e.g. `agent-comms:<deliveryId>`), reuse it on every retry of the same attempt, and use a new one only after a rejection. Re-sending the same `commandId` after a lost response is the safe, definitive "did it run?" check; it returns `{ sequence }` if it ran and a "previously rejected" error if it did not.
- The wire error does **not** let you tell "not accepted" from "uncertain". The handler maps every failure to one tag (`ws.ts:1769-1778`): `OrchestrationV2DispatchCommandError { commandId, commandType, message, detail?, cause? }` (`orchestrationV2.ts:3118-3127`); auth failures are `EnvironmentAuthorizationError`. (The server itself knows the difference, `ThreadMessageIntake.ts:14-30`, but does not expose it.) Treat any error or transport loss as uncertain and replay the same `commandId`. Our old "HTTP 4xx = refused" rule goes away.

### Busy thread

Decided under the thread lock from server state (`Orchestrator.ts:4276-4280`, `CommandPolicy.ts:119-165`):

| `dispatchMode` / `deliveryIntent` | Thread idle | Thread has a blocking run (`preparing`/`starting`/`running`/`waiting`, `Orchestrator.ts:395-402`) |
|---|---|---|
| `start_immediately` | New run, status `starting` | **Queued as a new run** (`Orchestrator.ts:4479-4484`, `CommandPolicy.ts:469-478`). Needs provider `queued_messages` capability, else policy error `CommandPolicyCapabilityUnsupportedError` (`CommandPolicy.ts:92-105`, `ensureQueuedMessages`). |
| `queue_after_active` | New run | Same queued run. |
| `steer_active` + `targetRunId` | Fails (`CommandPolicyUnsupportedError`, `CommandPolicy.ts:400-410`) | Message joins the running run (`Orchestrator.ts:4444-4472`, `dispatchSteerIntoRun` `:3372`). Run must be `running` (`:3447-3453`), else error. |
| `restart_active` | Fails | Interrupts the provider turn and starts a **new attempt** of the same run, reason `steering_restart` (`Orchestrator.ts:3683-3700`, `:3935`). |
| `deliveryIntent: "auto"` | `start_immediately` | Server picks steer if the provider session `supportsActiveSteering`, else queue, else restart (`CommandPolicy.ts:141-164`). |

- Late-steer fallback: a steer aimed at a run whose provider turn has just completed is converted to `start_immediately` instead of failing (`Orchestrator.ts:4281-4299`).
- `/compact` and `/logout` cannot be steered (`:3416-3438`).
- **For the adapter: send `{ type: "start_immediately" }` after waiting for idle.** If you lose the race, the message becomes its own queued run behind the other one, and never gets mixed into someone else's turn. Decide explicitly what "queued" means for the delivery state machine (see section 7).

### Result and run/attempt identity

- Result is only `{ sequence: NonNegativeInt }` (`orchestrationV2.ts:2958-2961`; handler `ws.ts:1768`). The stored events are dropped at the wire. `sequence` is the thread-event sequence of the command's receipt: use it as a replay cursor (`afterSequence = sequence - 1`, or just subscribe from a snapshot).
- Run id is **derived**, not caller-supplied: `run:thread:<threadId>:ordinal:<n>`, where `n = runs.length + 1` (`IdAllocator.ts:404`, `Orchestrator.ts:303-305`). Attempt id: `run-attempt:run:<runId>:attempt:<k>` (`IdAllocator.ts:405-408`). Don't parse them or predict them; read them from events or a snapshot.

---

## 3. Runs and attempts

### Run (`orchestrationV2.ts:510-546`)

`{ id, threadId, ordinal, providerInstanceId, modelSelection, providerThreadId, userMessageId, rootNodeId, activeAttemptId, status, queuePosition?, queueHeld?, requestedAt, startedAt, completedAt, checkpointId, ... }`

- `status` (`:445-456`): `preparing | queued | starting | running | waiting | completed | interrupted | failed | cancelled | rolled_back`.
- **`userMessageId`** is the message that created the run. For a run you start, it equals your `messageId`.
- **`waiting` is post-terminal**: when the provider turn finishes `completed`, the run is persisted as `waiting` with `completedAt: null` (`RunExecutionService.ts:633-644`), and flips to `completed` (with `checkpointId`, `completedAt`) when the checkpoint capture lands (`CheckpointCaptureService.ts:209-216`). The agent's turn is over at `waiting` (comment at `Orchestrator.ts:404-408`). `interrupted`, `failed` and `cancelled` are written final immediately. `waiting` still counts as busy for dispatch.
- Queue: a queued run has `status: "queued"`, `queuePosition`, and `activeAttemptId` already set (attempt `pending`) (`Orchestrator.ts:4581-4626`). When the blocking run ends, `startNextQueuedRun` starts it (`:1115`) with the **same run id** and `status: "starting"`.
- `queueHeld`: after a `run.interrupt` with `holdQueue: true`, or restart recovery, queued runs stop starting until `queue.resume` (`orchestrationV2.ts:2699, 2709-2712`).

### Attempt (`orchestrationV2.ts:548-571`)

`{ id, runId, attemptOrdinal, rootNodeId, providerThreadId, providerTurnId|null, reason, status, startedAt, completedAt }`

- `reason`: `initial | steering_restart | retry | provider_recovery`.
- `status`: `pending | running | completed | interrupted | failed | cancelled | superseded`.
- A run normally has attempt 1 (`initial`). More attempts appear on `restart_active` steering, provider retry, or provider recovery. The current one is `run.activeAttemptId`. `superseded` marks an attempt replaced by a later one.
- Provider turn (`OrchestrationV2ProviderTurn`, `orchestrationV2.ts:900-919`) links by `runAttemptId`; its status mirrors the attempt's.

### "Our message started run R"

```
R = runs.find(r => r.userMessageId === ourMessageId)
```

- Present as a `run.created` event (payload = the Run) or in `projection.runs`.
- Run created by our message: `userMessageId === ourMessageId` and the `user_message` turn item has `inputIntent: "turn_start"` (immediate start) or `"queued_turn"` (queued) (`orchestrationV2.ts:1202-1207`; set at `Orchestrator.ts:5031, 5720, 1490, 4751`).
- Message **steered into** an existing run: the `message.updated` for our id has `runId = R` but `R.userMessageId !== ourMessageId`, and the turn item has `inputIntent: "steer"` (`Orchestrator.ts:3583-3587`). You only get this if you asked for steering.
- Message not present anywhere: never accepted.
- Every user `ConversationMessage` has a `runId` (`orchestrationV2.ts:1018`, filled at `Orchestrator.ts:4655` and `3550`), so "which run did this message land in" is a lookup, not an inference. No clock comparison (`requestedAt` is server time, `orchestrationV2.ts:524`).

---

## 4. Observing

### Snapshot (the `getThread` equivalent)

`OrchestrationV2ThreadProjection` (`orchestrationV2.ts:1621-1641`):

```
thread, runs[], attempts[], nodes[], subagents[], providerSessions[], providerThreads[], providerTurns[],
runtimeRequests[], messages[], plans[], turnItems[], checkpointScopes[], checkpoints[],
contextHandoffs[], contextTransfers[], visibleTurnItems[], updatedAt
```

- Old `session` / `latestTurn` / `activities[]` have no counterpart. Idle/busy = no run in a blocking state (also `queued`). The shell status helper is `"idle" | RunStatus` (`orchestrationV2.ts:1643-1647`).
- "Active run" = `runs.find(r => preparing|starting|running|waiting)`; "latest run" = highest `ordinal` (`runs` is ordered; the server itself uses `findLast`, `CommandPolicy.ts:127`).
- Message: `{ id, threadId, runId|null, nodeId|null, role, text, attachments, streaming, createdAt, updatedAt, createdBy, creationSource, ... }` (`orchestrationV2.ts:1010-1034`).
- Via HTTP the snapshot is wire-projected (tool output stripped, section 6) (`http.ts:108-126`; `WireProjection.ts:119-140`).

### Event stream: `orchestration.subscribeThread`

Input (`orchestrationV2.ts:2984-2999`): `{ threadId, afterSequence?, requestCompletionMarker?, acceptBoundedSnapshot? }`. Default (no `acceptBoundedSnapshot`) gives a **full** snapshot (`ws.ts:726-736`).

Items (`orchestrationV2.ts:3091-3116`):

```
{ kind: "synchronized" }                                    // only if requestCompletionMarker
{ kind: "snapshot", snapshotSequence, projection, (historyCursor?, hasMoreHistory?, ...) }
{ kind: "event", sequence, event: OrchestrationV2DomainEvent }
{ kind: "unknown-event", sequence, eventType }              // decode-only: type this build doesn't know
```

`unknown-event` (`:3062-3089`) means a newer server sent an event type your schema lacks: skip it but advance the cursor. A known type with an undecodable payload still fails the subscription. Our wire decoder must tolerate this.

Event envelope (`:1470-1479`): `{ id, threadId, runId?, nodeId?, driver?, providerInstanceId?, rawEventId?, occurredAt, type, payload }`. The domain event union is at `:1481-1618`. Names that matter:

| Need | Event `type` | Payload |
|---|---|---|
| Run created (queued or starting) | `run.created` | `Run` |
| Run state change (starting → running → waiting → completed / failed / interrupted / cancelled) | `run.updated` | `Run` |
| Attempt created / changed | `run-attempt.created`, `run-attempt.updated` | `RunAttempt` |
| User or assistant message upsert | `message.updated` | `ConversationMessage` |
| Assistant text, tool calls, errors, interrupts | `turn-item.updated` | `TurnItem` (union `:1246-1443`) |
| Provider turn | `provider-turn.updated` | `ProviderTurn` |
| Root node | `node.updated` | `ExecutionNode` |
| Checkpoint done | `checkpoint.captured` | |
| Thread (un)settle etc. | `thread.unsettled`, `thread.unsnoozed`, `thread.metadata-updated`, ... | `AppThread` |

There are no `...completed` / `...failed` / `...interrupted` event names. Terminal state is `run.updated` (and `run-attempt.updated`) with `payload.status`.

- Assistant message deltas: there are no delta events. `message.updated` (role `assistant`) and `turn-item.updated` (`type: "assistant_message"`, `streaming: boolean`) are **upserts of the whole row**. `streaming: true` while in flight, `false` when final. Take the latest upsert per message id; **do not concatenate** (the old protocol's chunk-plus-empty-final model is gone). Verified for Codex (`text: item.text`, `Adapters/CodexAdapterV2.ts:2884-2896`) and Claude (full result text, `streaming: false`, `Adapters/ClaudeAdapterV2.ts:2506-2517`); other adapters unchecked.

### Ordering, sequence numbers, cursors

- `sequence` on each `event` item is the thread's monotonically increasing store sequence (`latestAgentSequence(threadId)`, `ws.ts:767`); `snapshotSequence` is the same space. Gaps are normal (other event kinds and live coalescing of in-flight tool updates, `ThreadLiveEventCoalescer.ts:15-60`; terminal and lifecycle events are never coalesced). Treat it as an ordered cursor, not a counter.
- A command's events commit in one transaction (`commitCommand`, `Orchestrator.ts:9419-9440`); `run.created` and the user `message.updated` for one dispatch come from the same command. Because the run carries `userMessageId`, you don't depend on their relative order.
- **Replay**: `subscribeThread { afterSequence: N }` replays persisted events with sequence > N, then `synchronized` (if requested), then live (`ws.ts:766-834`). It falls back to a `snapshot` item first (so handle `snapshot` arriving in a resumed stream, as `adapter.ts:166` already does) when:
  - `afterSequence` > current high-water, e.g. DB replaced (`ws.ts:777-779`);
  - more than `THREAD_RESUME_MAX_REPLAY_EVENTS = 128` events, or raw payload over 1 MiB (`ThreadStream.ts:10-27`, `ws.ts:799-804`, also `ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES` 8 MiB at `ws.ts:457`);
  - the thread was recreated (`ws.ts:805-819`);
  - `decideThreadResume` says snapshot (encoded size) (`ws.ts:820-829`).
  The cap is 128 events, much lower than the old 1000, so long turns resume via snapshot more often. The snapshot-based check (find the run by `userMessageId`) must be the primary restart path, with replay as an optimization.
- Persist as the cursor: the last `sequence` you processed (events) or `snapshotSequence` (snapshots).

---

## 5. Collecting the answer; interrupts, errors, other input

### Final text for run R

- Candidates: `messages` where `role === "assistant" && runId === R.id`, and `turnItems` / `visibleTurnItems` with `type === "assistant_message" && item.runId === R.id`. There is **no** `latestTurn.assistantMessageId` equivalent on the Run. A run can have several assistant messages (text before and after tool calls). Take the last `assistant_message` turn item by `ordinal` (`OrchestrationV2TurnItemBaseFields.ordinal`, `:1223`) whose `streaming === false`; its `messageId` points at the message row. Whether to take only the last one or join them is a product decision (the old rule was "last").
- `reasoning` is its own turn item type (`:1272-1277`), not an assistant message. `role: "system"` messages still exist in the schema.
- Wait for the right moment: the answer is stable once `Run.status` is `waiting` (turn over) or `completed`. `completed` additionally means the checkpoint was captured. If you only need the text, `waiting` is enough, but background work can still be draining then (unverified how often a late assistant message lands in `waiting`); using `completed` is the conservative choice. On `failed`/`interrupted`/`cancelled` collect whatever the last non-streaming assistant item is, and report the state separately.

### Interrupt, failure, cancel (now explicit)

- **Run `status`** carries the outcome: `interrupted`, `failed`, `cancelled`, `rolled_back` are all distinct from `completed`. Provider-reported terminal statuses are `completed | interrupted | cancelled`, or `failed` with a failure object (`ProviderAdapter.ts:130-149`). The old "interrupt looks like completed, tell by session `ready` then `stopped`" heuristic is gone.
- **Failure detail**: a `turn-item.updated` with `type: "error"` and `failure: { class, message, code|null, retryable|null, resetAt? }` and optional `retry: { attempt, maxAttempts|null, retryDelayMs|null }` (`orchestrationV2.ts:1364-1369`, `OrchestrationV2ProviderFailure` `:1176-1184`; usage limits show up as `class === "usage_limit"`, see `Orchestrator.ts:4109-4137`). Provider auto-retry shows as another attempt with `reason: "retry"`.
- **Interrupt**: `turn-item.updated` of `type: "run_interrupt_request"` then `"run_interrupt_result"`, each with `message` (`orchestrationV2.ts:1349-1358`), emitted by `dispatchRunInterrupt` (`Orchestrator.ts:7688-7917`), plus run/attempt `interrupted`. Our own interrupt command: `{ type: "run.interrupt", commandId, threadId, runId, reason?, holdQueue? }` (`orchestrationV2.ts:2693-2700`, no turn id, run id required). `holdQueue: true` keeps queued runs from auto-starting after Stop. A human Stop in the UI produces the same states, so we can now tell it from completion without having sent it.
- **Cancel a queued message**: `queued-run.cancel { runId }` (`:2720-2725`) (`cancelled`).
- **Start failure**: no `provider.turn.start.failed` activity. A failure to start shows as an `error` turn item and run/attempt `failed`; a refusal at dispatch is a synchronous RPC error. Rejected dispatches are recorded as rejected receipts, not events.
- Rollback (`checkpoint.rollback`) can move a run to `rolled_back` later; treat as "outcome no longer valid".

### Other input while our run is active

What the server does depends on how the *other* sender asked (`dispatchMode` / `deliveryIntent`, table in section 2). The web client's own composer sends `deliveryIntent` = its mode (`"auto"`/`"steer"`/`"restart"`) or `queue_after_active` for "queue" (`packages/client-runtime/src/operations/commands.ts:728-766`); `followUpBehavior` default is `"queue"` (`packages/contracts/src/settings.ts:453-455`). How `ChatView.tsx` (`:8577`, `:9059`) maps the setting to a mode on a running thread was not traced; check it before relying on "Lee's message queues rather than steers".

Observable consequences:

- **Queued behind us**: a new `run.created` with `status: "queued"`, a different `userMessageId`, higher `ordinal`. It is not in our run. Our run's result is unaffected.
- **Steered into us**: a `message.updated` (role `user`) with `runId === R.id` and `id !== ourMessageId`, plus a `user_message` turn item with `inputIntent: "steer"` or `"promoted_queued_to_steer"` (a queued message promoted via `queued-message.promote-to-steer`, `orchestrationV2.ts:2701-2707`, `Orchestrator.ts:3583-3587`). That is the "something else entered the turn" signal: filter user messages with `runId === R.id` and `id !== ours`. A `restart_active` steer instead adds a new attempt (`steering_restart`) to R; the earlier attempt becomes `superseded`/`interrupted` and the answer comes from the later attempt.
- Compared with 0.0.44 the ambiguity is much smaller: nothing joins our run unless somebody explicitly steers, and the `preceded`/`joined`/`startedByUs` cases collapse to "does `run.userMessageId` equal our id?" and "is there a foreign user message with our `runId`?".
- Runs started with no user message (Claude background-task wakeups, delegated completions): a run still has a required `userMessageId`; wake-ups are server-created messages with `createdBy: "agent"`, `creationSource: "server"` and a `notification` / `delegatedCompletion` field (`orchestrationV2.ts:1001-1008, 1027-1033`; `Orchestrator.ts:4301-4312`, `:4316-4352`). They queue as their own runs (or steer into an active one if the delegated task asked for `completionWake: "always"`, `:4356-4388`). Treat them as not ours.

---

### What the adapter does: the `waiting` settle (`waitingSettleMs`, 30 s)

`packages/adapter-t3/src/v2/adapter.ts` reads our run's outcome when the run is `completed`, or after it has sat in `waiting` for `waitingSettleMs` (default 30 s), whichever comes first. The restart check (`check`) reads `waiting` as still running.

- **Why wait at all:** at `waiting` the agent's turn is over, but the checkpoint isn't captured yet and background work may still be draining; whether a late assistant message can land in `waiting` is unverified. `completed` is the state after which the run's records don't change (short of a rollback, which we report as uncertain).
- **Why not wait for `completed` only:** checkpoint capture can be slow or never land (a failed capture, a provider without checkpoints), and the requester would wait forever. 30 s covers a normal capture (seconds in the live checks) and bounds the worst case.
- **What it risks:** if an assistant message lands in `waiting` more than 30 s after the turn ended, the answer read earlier is the one collected. A rollback after we collected doesn't undo the collected answer.
- **Unit test:** "a run stuck in waiting (checkpoint never lands) is read after the settle window" (`test/v2-adapter.test.ts`). The value is a heuristic, not a T3 guarantee; revisit if T3 documents when `waiting` ends.

## 6. Tool output visibility

**Confirmed: command and tool output text is not available to a wire client, and v2 is stricter than 0.0.44's 84-char preview.** All wire paths go through `WireProjection.ts`: HTTP snapshots (`http.ts:156`), WS snapshots (`ws.ts:751`), and live events plus replay (`projectDomainEventForWire`, `ws.ts:682, 707`; `WireProjection.ts:142-150`).

| Turn item | What survives | What is removed |
|---|---|---|
| `command_execution` | `input` (the command), `status`, `exitCode`, `outputIndicatesFailure` | `output` is dropped entirely; only a failure boolean derived from it remains (`WireProjection.ts:74-84`) |
| `dynamic_tool` (MCP and custom tools) | `toolName`, `input` (summarized if over 16 KiB: `{ summary, truncated }`), `output` reduced to a compact envelope: `isError`, ids (`threadId`, `messageId`, `taskId`, `scheduledTaskId`), thread lists, `status: "rolled_back"` (`WireProjection.ts:98-106, 29-66`; `packages/shared/src/toolOutput.ts:98+`) | all other output text |
| `file_change` | file name, counts, `changes` | `diffStr`, `oldStr`, `newStr` (`WireProjection.ts:85-90`); full diffs go through `getTurnDiff` / `getFullThreadDiff` |
| `subagent` | prompt/progress/result truncated at 32 KiB (`WireProjection.ts:9, 91-97`) | beyond the cap |
| `handoff` / context handoff | | `summary` / `summaryText` / `history` |

Consequence for us: the CLI begin/end markers inside a command's output can never be seen, so "confirm the answer reached the model by reading tool output" is impossible, as noted in `docs/t3-api-notes.md` section 11. Only the `command_execution.input` (what was run) and its exit code / failure flag are visible. The server keeps full output in persistence; there is no client read path for it that I found (RPC list `orchestrationV2.ts:2867-2879`).

---

## 7. What a port of the adapter has to change

### Old to new map

| 0.0.44 | v2 |
|---|---|
| `POST /api/orchestration/dispatch` with `thread.turn.start` | WS RPC `orchestration.dispatchCommand` with `message.dispatch` |
| `{ messageId, role, text, attachments }` nested `message` | flat `messageId`, `text`, `attachments` on the command |
| `runtimeMode`, `interactionMode`, `createdAt` on the command | gone (thread settings) |
| `createdAt` for ordering | server time only; `requestedAt` on Run |
| dispatch result `{ sequence }` | same, but no run id in it |
| turn id (`activeTurnId`, `latestTurn.turnId`) | `RunId` (`run.id`); attempt id is a second level |
| `latestTurn.state` running/completed/interrupted/error | `Run.status` (10 values) |
| `latestTurn.requestedAt` | `Run.requestedAt`; no longer needed to link anything |
| `latestTurn.assistantMessageId` | no field; last `assistant_message` turn item of the run |
| `session.status` (starting/running/ready/interrupted/error/stopped) | derived from runs; none of these strings exist |
| `thread.message-sent` | `message.updated` (+ `turn-item.updated` for the timeline) |
| `thread.session-set` | `run.updated` / `run-attempt.updated` / `provider-turn.updated` |
| `thread.activity-appended` (`provider.turn.start.failed`) | `error` turn item + `failed` run |
| user message `turnId: null` | user message `runId` always set |
| assistant chunks plus empty final | whole-row upserts with `streaming` |
| `thread.turn.interrupt { turnId? }` | `run.interrupt { runId }` |
| HTTP snapshot `{ snapshotSequence, thread }` with `?turnLimit` | `{ snapshotSequence, projection }`; `/bounded` for a window |
| `subscribeThread` replay up to 1000 events | 128 events / 1 MiB, else snapshot |
| steer on busy thread (always) | queued by default; steer only on request |

### Concrete work items

1. **`t3/client.ts`**: add `orchestrationProtocol=2` to the WS URL; add `x-t3-orchestration-protocol: 2` to HTTP reads; replace `startTurn` with an RPC call on the existing WS client (same `s.client[...]` mechanism as `subscribe`, but a plain call, not a stream); swap `{thread}` for `{projection}`; drop `turnLimit`. Optionally preflight `GET /.well-known/t3/environment`.
2. **`t3/wire.ts` and `model.ts`**: re-derive the wire slice from `OrchestrationV2ThreadProjection` / `OrchestrationV2ThreadStreamItem`. Slice what you read: `runs[]` (`id, ordinal, userMessageId, status, activeAttemptId, queuePosition, requestedAt, completedAt`), `attempts[]`, `messages[]` (`id, role, runId, streaming, text` for assistant only), and the turn items `assistant_message` / `error` / `run_interrupt_*` / `user_message.inputIntent`. Add a skip path for `unknown-event`. Keep the privacy rule: the stream now carries user message `text` and `context` in every `message.updated` and `user_message` item; the slice must not retain them (`model.ts` header comment).
3. **`TurnTracker` (`model.ts:~110-230`) shrinks**: busy/active-turn tracking, `preceded`, `joined`, `sawStarting`, `startedBy()` (`model.ts:234`) all go. New rules:
   - accepted: a `run.created`/`run.updated` with `payload.userMessageId === ours` gives `runId` (and status);
   - foreign input into our run: user `message.updated` with `runId === ours.runId` and `id !== ours`;
   - end: `run.updated` for our `runId` reaching `waiting`/`completed` (answer ready) or `interrupted|failed|cancelled|rolled_back`;
   - answer: latest finished `assistant_message` for the run (section 5).
4. **`adapter.ts` states**: the `accepted` result (`adapter.ts:38`) used to mean "a turn started". Now there is an extra state: our run exists but is `queued`/`preparing` (thread became busy after the idle check, or a restart-held queue). Decide if that counts as accepted (it will run, cancelable via `queued-run.cancel`) and how long to wait for `starting`. `turnId` in `Check`, `Outcome`, and `encodeCursor(…, turnId)` (`adapter.ts:57-58, 355`) becomes the run id; keep it a string. Saved cursors from 0.0.44 are not valid in the new sequence space or id space, so version the cursor.
5. **`check()` after restart (absent / running / completed)** from one full snapshot (HTTP `/api/orchestration/threads/:id` + protocol header):
   - `run = runs.find(r => r.userMessageId === messageId)`;
   - no run, but `messages` contains the id: it was steered or otherwise attached to `message.runId`; report as running/ambiguous per the run's status and flag it foreign-joined;
   - neither: **absent**. Or the dispatch was never accepted. If unsure whether the command was sent but not committed, replay the same `commandId` (section 2) instead of treating absent as final;
   - `queued|preparing|starting|running|waiting` (until `completed`): **running**;
   - `completed`: **completed**, answer from run items;
   - `interrupted|failed|cancelled|rolled_back`: completed with that outcome (now distinguishable).
   Then subscribe with `afterSequence = snapshotSequence`.
6. **Wait-for-idle**: idle means no run in `preparing|queued|starting|running|waiting`. Include `queued` and `waiting` (old code looked at session status only). It is now a courtesy, not a correctness requirement, because the dispatch queues if we lose a race.
7. **Interrupt (ours)**: use `run.interrupt { runId }`; no more "session `ready` then `stopped`" tell (`docs/t3-api-notes.md` section 6).
8. **Failure on start**: replace the `provider.turn.start.failed` activity match (`turnStartFailures` in `T3Thread`) with the run going `failed` plus its `error` item / synchronous dispatch rejection.
9. **Docs**: `docs/t3-api-notes.md` is wrong for v2 in sections 1 to 9 and 11 (routes, ids, steer-on-busy, interrupt look, tool preview). Add a header pointing at this file.

### Things I did not verify (check before relying on them)

- Exact HTTP status for a missing/wrong protocol header on `/api/orchestration/*`.
- Whether 0.0.44-issued bearer tokens are accepted by the new server's auth store.
- Event order inside one start command beyond "same transaction" (read only the queued-run path in full: `Orchestrator.ts:4581-4716`, and the started-run run record at `~4907-4960`).
- That every provider adapter's `message.updated` assistant text is cumulative (Codex and Claude checked).
- Whether a late `message.updated`/assistant item can still arrive while a run is `waiting`.
- How the web composer maps `followUpBehavior` to `dispatchMode` while a run is active (`ChatView.tsx:8577, 9059`), i.e. whether Lee's typing steers or queues by default.
- Provider support for `queued_messages` / `active_steering` per adapter; the `start_immediately`-on-busy path fails with `CommandPolicyCapabilityUnsupportedError` where `queued_messages` is unsupported (`CommandPolicy.ts:92-105`, `:469-478`).
- Nothing was exercised against a running 0.0.46 server.
