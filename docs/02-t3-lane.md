# T3 lane, then the Claude Code mod

For the T3 builder. Read [`00-overview.md`](./00-overview.md) first. Four parts, in order:

- **A:** a clean T3 with the claude-lhc provider.
- **B:** T3 API notes for the comms builder.
- **C:** review the comms contract.
- **D:** build the Claude Code mod.

You own the T3 checkout and install, and `packages/claude-code-mod` in `agent-comms`. The contract in `packages/protocol` belongs to the comms builder: propose changes, don't make them.

## Part A: a clean T3 v0.0.44 with the claude-lhc provider

**Goal:** a T3 that is stock v0.0.44 plus one provider, running beside the current setup and touching none of it.

1. **Checkout:**
   - clone upstream `pingdotgg/t3code` at tag `v0.0.44` into `/srv/work/t3code-v044`, and work on a branch `lhc-provider`. Alder's `/srv/work/t3code-control-plane-v044` is the untouched reference copy; don't modify it.
   - Keep a list of every file you change, in `LHC-PATCH.md` at the checkout root. The whole patch should stay reviewable in one sitting.
2. **Isolation:**
   - its own port (3780) and its own data folder, via T3's home setting (e.g. `~/.t3code-v044`);
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
   - Record in `validation/` in the checkout.
5. **Give the comms builder:** the base URL, how an outside process authenticates (a bearer token or pairing, never printed into logs), and the three test thread ids.

## Part B: T3 API notes for the comms builder

Write `docs/t3-api-notes.md` in `agent-comms`. Check each point against the v0.0.44 contracts (`packages/contracts/src/orchestration.ts`, `rpc.ts`) and a live run, not memory. Reference client: `/srv/work/long-horizon-context/packages/t3code-inject`.

- Connecting and authenticating from an outside process: WebSocket RPC, bearer, and how to get a long-lived credential for the connector.
- `orchestration.subscribeThread`: the events for:
  - a user message appended, whether typed in the UI or injected;
  - a turn started, with its turn id;
  - the final assistant message;
  - a turn completed or interrupted;
  - session status (idle or busy).
- `thread.turn.start` on an **idle** thread, and on a **busy** thread, separately for:
  - native Claude;
  - Claude-LHC;
  - Codex.
  
  For each: does it steer the running turn, queue, or get rejected? Does v0.0.44 have any server-side follow-up queue?
- **Matching a reply to a request:** given the user message id the adapter sent, how does it identify that turn's final answer? How does it detect that another user message entered the same turn?
- `thread.turn.interrupt`, and what happens to a queued or steered message.
- **How an agent inside a stock T3 thread can learn its own thread id,** for `comms send`: an environment variable, T3's MCP server, or the cwd. The fork added this with a patch. If stock T3 has nothing, say so; don't patch it.
- Anything the adapter needs that v0.0.44 doesn't expose.

## Part C: review the comms contract

Once part A is done, check whether the comms builder has committed M0: `packages/protocol` and `packages/connector-stub`.

- **If it's committed:** review the envelope, the model-facing rendering and the loopback protocol against what you learned in parts A and B, and against the mod facts below. Send concrete change requests to the comms builder, and wait for them to land or be declined before building on them.
- **If it isn't:** tell Reed. Then review whatever draft exists instead of starting the mod.

## Part D: the Claude Code mod (`packages/claude-code-mod`)

The adapter for standalone Claude Code terminal sessions: it delivers comms messages into the session, and reports turns and answers back. Claude running inside T3 doesn't use it.

**Known from Wrenn's spike** (`/scratch/wrenn/mods-inbox`, with an event log in `work/mod-events.jsonl`; ask Wrenn for anything unclear):

- **Loading and layout:**
  - mods only run with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the session's environment;
  - plugin layout: `.claude-plugin/plugin.json`, `hooks/hooks.json` containing `{ "modules": ["./register.ts"] }`, and a module exporting `register(on)`;
  - types come in the plugin's `.claude-plugin/types`, and `claude plugin validate` checks the plugin. Wrenn to confirm the exact load and install command.
- **Events:** `session.start`, `prompt.submit` (its `origin.kind` is `composer` for typed input and `plugin` for ours), `turn.start`, and `turn.complete`. `turn.complete` carries `reason` (`answer | aborted | refusal | error`) and the answer text in **`answer`**; the spike logged `text`, which is empty.
- **`$.prompt.submit({ text })`** wakes an idle session immediately. On a busy session it waits until the turn ends, then runs as its own turn. There's no mid-stream insertion.
- **`$.process.spawn`** runs a child for the session's life and streams its output (CLI sessions only). `$.http.fetch` can use `socketPath` for a Unix socket, but reads the whole body. `$.clock.every` and `$.session.id()` are available.
- **Framing:** Sonnet treated bare `[from: …]` injections as suspicious. Use the protocol's rendering function; fix problems in the protocol, not in the mod.

**Build against the stub connector:**

1. **On `session.start`:**
   - register the participant and session over the loopback protocol, then spawn `comms attach` to receive deliveries;
   - which participant this session is comes from configuration: an environment variable or plugin setting naming the participant. Promoting a terminal agent sets it.
2. **For each delivery:**
   - render it with the protocol's function, `$.prompt.submit` it, and ack delivered;
   - dedupe by delivery id.
3. **Reply matching:** track the turn your submit started.
   - If a `composer` `prompt.submit` arrives while it's running, mark that delivery ambiguous.
   - Otherwise, on `turn.complete` with reason `answer`, report replied with `answer`.
   - Deliveries of kind `answer` are delivered but never collected.
   - Aborted, refusal and error become failed, with the reason.
4. **Presence:** busy between `turn.start` and `turn.complete`, idle otherwise.
5. **Reconnect:** if the connector restarts or the attach child exits, re-register and resume; no duplicate prompts.

**Acceptance, against the stub, then the real connector:**

- An idle terminal is woken by a delivery, and its answer is reported as replied.
- A delivery during a long turn runs as the next turn, and is matched correctly.
- Lee types into the terminal while an injected turn runs: the delivery is ambiguous, and the agent's `comms send` answer goes out.
- An answer delivered in is never collected, and doesn't loop.
- The connector restarts mid-session: the mod reconnects, with no lost or duplicated deliveries.
- The model treats rendered deliveries as legitimate. No refusals across ten mixed deliveries on Sonnet and Opus.
- Nothing the session does outside comms turns is sent to the connector.

Then join the comms builder for M6 and the shared acceptance check in the overview.

## Don't

- Don't touch the running T3 on 3773 or any live seat.
- Don't use Claude Code's internal cross-session socket, and don't read its binary. Use the mods API and its published types only.
- Don't print credentials. Use dummy values in tests.
- Don't edit `packages/protocol` yourself.
