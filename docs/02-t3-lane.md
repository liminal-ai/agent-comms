# T3 lane, then the Claude Code mod

For Hazel. Read [`00-overview.md`](./00-overview.md) first. Four parts, in order:

- **A:** a clean T3 with the claude-lhc provider.
- **B:** T3 API notes for Cedar.
- **C:** review the comms contract.
- **D:** build the Claude Code mod.

You own the T3 checkout and install, `packages/claude-code-mod` in `agent-comms`, and `PROGRESS-t3.md`. Work in your own git worktree of `agent-comms`. The contract in `packages/protocol` and the repo root files belong to Cedar: propose changes, don't make them.

## Part A: a clean T3 v0.0.44 with the claude-lhc provider

**Goal:** a T3 that is stock v0.0.44 plus one provider, running beside the current setup and touching none of it.

1. **Checkout:**
   - clone upstream `pingdotgg/t3code` at tag `v0.0.44` into `/srv/agents/hazel/t3code-v044`, and work on a branch `lhc-provider`. Alder's `/srv/work/t3code-control-plane-v044` is the untouched reference copy; don't modify it.
   - Keep a list of every file you change in `LHC-PATCH.md` at the checkout root. The whole patch should stay reviewable in one sitting.
2. **Isolation:**
   - `T3CODE_PORT=3780` and `T3CODE_HOME=~/.t3code-v044`;
   - a separate claude-lhc store;
   - a memory-capped `systemd --user` unit, `t3code-3780.service`.
   - Never touch `t3code-3773.service`, `~/.t3code`, `~/.t3code-lhc`, or port 3773. Starts empty; no seats move this pass.
3. **Port the claude-lhc provider** from the t3code fork (`/srv/work/t3code`):
   - **Take:**
     - `apps/server/src/provider/Drivers/ClaudeLhcDriver.ts`, `ClaudeLhcSidecar.ts`, `apps/server/src/lhcVersion.ts`;
     - the sidecar pin, with the sidecar staged from npm `claude-lhc@0.1.1`;
     - whatever registration and settings they need.
   - Take limcode-1's fixes to that driver where they apply (`/srv/work/limcode-1`):
     - `d0968c5bd`: the LHC compaction trigger fits the model's context window;
     - `b27a97f1d` and `acd3dbb87`: LHC shows as unavailable instead of silently starting native;
     - `722852481`: LHC threads don't offer rewind.
   - **Leave out:**
     - the console proxy (`lhcConsoleGroupsProxy.ts`);
     - the groups, Roundtable and LHC sidebar UI;
     - relay and seat hooks;
     - LHC history import;
     - the fork's release scripts.
   - Use `scripts/migrate-claude-lhc-driver.py` as a map of what the driver touches, not as something to run blindly.
4. **Check:**
   - typecheck, plus focused tests for the driver;
   - live: a native Claude thread and a Claude-LHC thread each run turns. The LHC thread goes through at least one compaction, and recalls a fact planted before it;
   - a Codex thread runs, since the comms milestone needs one.
   - Live turns use the credentials already configured; never print them. Record in `validation/` in the checkout.
5. **Give Cedar:** the base URL, how an outside process authenticates (a bearer token or pairing, never printed into logs), and the three test thread ids.

## Part B: T3 API notes for Cedar

Write `docs/t3-api-notes.md` in `agent-comms`. Check each point against the v0.0.44 contracts (`packages/contracts/src/orchestration.ts`, `rpc.ts`) and a live run, not memory. Reference client: `/srv/work/long-horizon-context/packages/t3code-inject`.

Already established; confirm on the live install rather than re-researching:
- There is no server-side follow-up queue in v0.0.44.
- `thread.message-sent` carries `messageId` and `turnId`, so the adapter can find the turn its own message went into.
- Stock T3 gives an agent no way to learn its own thread id. Identity is `--as` for now.

To establish:
- Connecting and authenticating from an outside process: WebSocket RPC, bearer, and how to get a long-lived credential for the connector.
- `orchestration.subscribeThread` events for: a user message appended (typed in the UI or injected), a turn started, the final assistant message, a turn completed or interrupted, and session status (idle or busy).
- `thread.turn.start` on a **busy** thread, separately for native Claude, Claude-LHC and Codex: does it steer the running turn or get rejected? And what `turnId` does the resulting `thread.message-sent` carry?
- When a person types into a thread while our turn runs: does their message get our `turnId`, or a new one?
- `thread.turn.interrupt`, and what happens to a steered message.
- How to find a message by id in a thread, for the connector's restart check.
- Anything the adapter needs that v0.0.44 doesn't expose.

## Part C: review the comms contract

Once part A is done, check whether Cedar has committed M0: `packages/protocol`, `packages/comms-cli` and `packages/connector-stub`.

- **If it's committed:** review the envelope, the rendering and its parser, the loopback protocol and the CLI against what you learned in parts A and B, and against the mod facts below. Send concrete change requests to Cedar, and wait for them to land or be declined before building on them.
- **If it isn't:** tell Reed. Then review whatever draft exists instead of starting the mod.

## Part D: the Claude Code mod (`packages/claude-code-mod`)

The adapter for standalone Claude Code terminal sessions: it delivers comms messages into the session, and reports turns and answers back. Claude running inside T3 doesn't use it. No extra process per session: the mod polls the connector itself.

**Known facts** (Wrenn's spike at `/scratch/wrenn/mods-inbox`; Reed's flag check at `/scratch/reed/modflag`; the types in the plugin's `.claude-plugin/types`):

- **Loading:**
  - mods only run with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Verified: setting it in a settings file's `env` block (`claude --settings <file>`) is enough; the mod loaded. Setting it in the user's `~/.claude/settings.json` `env` block is the same mechanism but not yet tried; confirm it first.
  - Dev: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir packages/claude-code-mod`.
  - Install for a promoted terminal: `claude plugin marketplace add <local path>`, then `claude plugin install <name>@<marketplace>`.
  - Layout: `.claude-plugin/plugin.json`, `hooks/hooks.json` containing `{ "modules": ["./register.ts"] }`, and a module exporting `register(on)`. `claude plugin validate` checks it.
  - Mods fire in `claude -p` print sessions too.
- **Events:**
  - `turn.start` carries the prompt `text` and mints the `turnId`. For a plugin-submitted prompt that text is wrapped by Claude Code: "The <plugin> plugin sent a message:", our text, then a closing sentence (Wrenn, captured live). The protocol's parser handles that.
  - The `tool.call` hook exposes `tool_use_id`. Subagents' tool calls pass through it too; tell them apart by `agentId`.
  - `prompt.submit` origins: `composer` (typed), `plugin` (ours), `bridge`, `sdk`, `peer`, `task-notification`, `scheduled-trigger` and others. Input delivered into a running turn carries that turn's `turnId`.
  - `turn.complete` carries `turnId`, `reason` (`answer | aborted | refusal | error`) and the answer text in **`answer`**. With an `agentId` it is a subagent's turn.
  - A `task-notification` row carries its task: `id` (a subagent's `agentId`) and, when the notification includes it, `toolUseId`, the call that started the task.
- **`$.prompt.submit({ text })`** wakes an idle session immediately. On a busy session it waits until the turn ends, then runs as its own turn. There's no mid-stream insertion.
- **`$.http.fetch`** takes `socketPath` for a Unix socket, reads the whole body, and has **no timeout option**. `$.clock.every`, `$.env.get`, `$.fs` (confined to the session's folder) and `$.session.id()` are available.
- **Configuration, verified** (Reed, `/scratch/reed/modflag`): the mod read `AGENT_COMMS_PARTICIPANT` with `$.env.get`, and reached a socket under `/run/user/<uid>/` with `socketPath`, outside the session folder. No token file is needed (see 01, M0).

**Build against the stub connector:**

1. **Participant:** which participant this session is comes from `AGENT_COMMS_PARTICIPANT` in the session's environment. Promoting a terminal agent in the web view creates the participant; Lee starts that terminal with the variable set. No variable: the mod does nothing.
2. **On `session.start`:** register the participant and session with the connector.
3. **Polling:** `$.clock.every` (about 2s) issues a poll only if none is outstanding, so a slow poll never overlaps the next tick.
4. **For each delivery:** dedupe by delivery id, render it with the protocol's function, and `$.prompt.submit` it.
5. **Matching:**
   - On `turn.start`, parse the text with the protocol's parser. If it carries our delivery id, that `turnId` is ours; ack delivered with it.
   - Record the tool-use ids of main-turn tool calls (no `agentId`) and the subagent ids started during our turn.
   - Any other input delivered into our turn (any `prompt.submit` or notification carrying our `turnId`) makes the delivery ambiguous, **except** a task notification whose `toolUseId` or task `id` matches work our turn started. If the notification can't be linked, it counts as other input.
   - On `turn.complete` for our `turnId` with no `agentId`: reason `answer` reports replied with `answer` (unless ambiguous); aborted, refusal or error report failed with the reason.
   - If the real result only arrives after our turn ended, that's a follow-up, not ambiguity: the rendered delivery tells the agent to send it with `comms reply`. The turn's own answer is still collected; the follow-up is a separate message with the same `inReplyTo`.
   - Deliveries of kind `answer` are delivered, never collected.
6. **Presence:** busy between our session's main `turn.start` and `turn.complete`, idle otherwise.
7. **Restart check:** answer the connector's "do you have delivery X, and what happened to its turn" by looking in the session's messages for the delivery header and that turn's answer.
8. **Reconnect:** if the connector restarts, re-register and resume polling; the connector's lease and restart rules prevent duplicate prompts.

**Acceptance, against the stub, then the real connector:**

- The user settings `env` block enables the mod (first check).
- An idle terminal is woken by a delivery, and its answer is reported as replied.
- A delivery during a long turn runs as the next turn, and is matched correctly.
- A delivery whose answer uses a background shell task and a helper subagent is collected normally, not ambiguous; the helper's own answer is never reported as the reply.
- Whether task notifications carry `toolUseId` in practice. If not, they count as other input, and this case is ambiguous instead; record which.
- Lee types into the terminal while an injected turn runs: if the typed text enters our turn, the delivery is ambiguous and the agent's `comms reply` goes out; if it waits for the next turn, the reply is collected normally. Record which happens.
- An answer delivered in wakes the agent, and nothing it does next is collected; no loop.
- The connector restarts mid-session: the mod reconnects, with no delivery run twice.
- A slow connector never leads to overlapping polls.
- The model handles ten benign rendered requests correctly on Sonnet and Opus, as it actually sees them (inside Claude Code's plugin wrapper), with normal permission prompts still applying.
- A follow-up sent with `comms reply` after the turn's own answer was collected is accepted as a second message on the same request.
- Nothing the session does outside comms turns is sent to the connector.

Then join Cedar for M6 and the shared acceptance check in the overview.

## Don't

- Don't touch the running T3 on 3773 or any live seat.
- Don't use Claude Code's internal cross-session socket, and don't read its binary. Use the mods API and its published types only.
- Don't spawn a per-session helper process from the mod.
- Don't print credentials. Unit tests use dummy values.
- Don't edit `packages/protocol` or the repo root files yourself.
