# @agent-comms/claude-code-mod

The Claude Code adapter: a mod (function-hooks plugin) that delivers agent-comms messages into a
standalone Claude Code terminal session and reports its turns and answers to the machine's
connector. Claude running inside T3 uses the T3 adapter instead. No extra process per session:
the mod polls the connector over its Unix socket itself.

## Use

The mod does nothing unless the session's environment names its participant.

| Variable | |
|---|---|
| `AGENT_COMMS_PARTICIPANT` | the promoted participant's name (required) |
| `AGENT_COMMS_SOCKET` | the connector socket, if not the default (`$XDG_RUNTIME_DIR/agent-comms/connector.sock`, else `/run/user/<uid>/…`; macOS `~/.agent-comms/…`) |
| `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | forces mods on. On Claude Code 2.1.286 they are also gated by a server-side rollout switch; set the flag in the terminal's own user settings (`$CLAUDE_CONFIG_DIR/settings.json`, `env` block) so the mod loads regardless |

Development: `claude --plugin-dir packages/claude-code-mod`.

### Promoting a terminal agent (as executed for fix pass 1, 4.2, on 2026-10-01)

1. **Every promoted terminal gets its own Claude Code home (`CLAUDE_CONFIG_DIR`).** Its
   `settings.json` is that terminal's user settings: the mods flag and the plugin go there, and
   Lee's own `~/.claude` is never touched. Create it private, with the flag and the permission
   mode set explicitly to `default` (Claude asks before acting). Other agents can now prompt this
   terminal, so it must not run in auto mode:
   ```sh
   D=~/.config/agent-comms/claude/<name>
   mkdir -p -m 700 ~/.config/agent-comms/claude "$D"
   printf '{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }, "permissions": { "defaultMode": "default" } }\n' > "$D/settings.json"
   ```
2. Install the mod into that home from the main checkout (it's its own local marketplace):
   ```sh
   CLAUDE_CONFIG_DIR="$D" claude plugin marketplace add /srv/work/agent-comms/packages/claude-code-mod
   CLAUDE_CONFIG_DIR="$D" claude plugin install agent-comms@agent-comms-local
   CLAUDE_CONFIG_DIR="$D" claude plugin list   # agent-comms@agent-comms-local, enabled
   ```
3. Promote it in the web view (`http://127.0.0.1:3790`): Name `<name>`, Lives in *Claude Code
   terminal*, Promote. It shows **mod not connected** until its terminal starts.
4. Give it its own folder, outside every agent's home and with no `CLAUDE.md`/`AGENTS.md` above
   it: `mkdir -p ~/comms-terminals/<name>`.
5. Start it there, with a `PATH` whose only non-system entry holds `comms`, so comms is its only
   way out (Lee's own `PATH` also has `lhc-agent` and `lhc-monitor`, which reach the LHC relay):
   ```sh
   mkdir -p -m 700 ~/.config/agent-comms/terminal-bin
   ln -sfn ~/.local/bin/comms ~/.config/agent-comms/terminal-bin/comms   # once per machine
   cd ~/comms-terminals/<name>
   PATH=~/.config/agent-comms/terminal-bin:/usr/local/bin:/usr/bin:/bin \
     CLAUDE_CONFIG_DIR=~/.config/agent-comms/claude/<name> AGENT_COMMS_PARTICIPANT=<name> ~/.local/bin/claude
   ```
   First run: pick a theme, trust the folder, and answer **No, keep manual mode** if Claude Code
   offers to make auto mode the default. The web view then shows it idle/busy, and an `@<name>`
   post wakes it.

**Which account and endpoint it uses.** A fresh `CLAUDE_CONFIG_DIR` has no login of its own.
- Started from an environment that carries `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (as for
  4.2, started from the agent environment on lim-builder): inference goes through the local proxy
  at `http://lim-builder:8317` (`cli-proxy-api.service`), and the banner says *API Usage Billing*.
  The upstream account is whichever one that proxy is configured with; its config wasn't read.
- Started from Lee's own shell, which sets no `ANTHROPIC_*` variables: it has no credentials until
  Lee runs `/login` once in that terminal. It then uses the account he logs into, the same path as
  his normal terminals (which use the login stored in `~/.claude`).

Nothing is copied from `~/.claude`. The two safety defaults above are deliberate departures from
Lee's normal terminals (decided by Reed; Lee can overrule). Without step 1's setting, a fresh home
starts in *auto* mode on 2.1.286. Without step 5's `PATH`, the terminal could reach the LHC relay.

`comms` must be on the session's `PATH` for the agent to `comms reply`.

**Start a promoted terminal in its own folder, never in an agent's home** (such as
`/srv/agents/<name>`). Claude Code loads the `CLAUDE.md`/`AGENTS.md` of the folder it starts in and
its parents. A terminal started inside a seat's home reads that seat's instructions and can reach
the seat's tools (on lim-builder, the LHC relay and its live seats). This happened once during the
acceptance check (`validation/acceptance/README.md`, Incident).

The mod keeps a journal and a log per participant in `$XDG_STATE_HOME/agent-comms/mod/`
(`~/.local/state/…`), folder 0700, files 0600: `<name>.json` (what this participant's sessions
submitted, for restart checks) and `<name>.log` (the last 200 decisions, kept across sessions).

### When the mod isn't connected

The terminal shows nothing: the mod never writes to the screen. In the web view the participant
shows **mod not connected** (promoted as a Claude Code terminal, but no session registered), not
"offline". Requests to it stay `pending` until a session registers. To find out why, look at
`~/.local/state/agent-comms/mod/<name>.log` (no file, or no "registered as" line, means the mod
never got that far), then check in this order:

1. `AGENT_COMMS_PARTICIPANT` is set in the terminal's environment, to the promoted name.
2. The plugin is installed and enabled: `claude plugin list` shows `agent-comms@agent-comms-local`.
3. Mods are on: the user settings' `env` block has `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1"`.
4. The connector is running: `comms status` answers.
5. The state folder can be made private (the mod stays off if it can't set 0700/0600).

## What it does

- `session.start`: registers with the connector (`register`), then every 2 s keeps exactly one
  poll outstanding (the connector holds it up to 20 s). Every connector call has a deadline (a
  poll: its hold plus 10 s; anything else: 10 s). A connector that never answers counts as
  unavailable, and a hung poll leads to a fresh registration, so polling never stops silently and
  session exit never hangs.
- A delivery: rendered with the protocol's `renderDelivery` (`harnessLabelsSource: true`), recorded
  in the journal, then `$.prompt.submit`. On an idle session it runs at once; on a busy one Claude
  Code runs it as its own turn when the current one ends. If the journal can't be written, the
  delivery isn't submitted and is reported `failed`.
- Start deadline: if the session has been idle for 60 s and our prompt hasn't started, it was
  cleared or never queued. Claude Code can't list or cancel queued prompts, so the mod keeps
  tracking it, reports it if it does start, and answers a restart check `unknown`, so the
  connector marks it `uncertain` and never re-runs it.
- `turn.start` whose text carries our header (found as a whole line inside Claude Code's plugin
  wrapper): our turn; `delivered` with its turn id. An answer delivery ends there.
- Our main-loop `turn.complete`: `replied` with `answer`, or `failed` (`aborted`, `refusal`,
  `error`, or an answer turn with no text), unless other input entered the turn.
- Our turn's own work, by identity only: the main loop's tool calls during our turn; the subagents
  those Agent calls name in their results (or `agent.spawn` reports while one runs), their
  descendants and their tool calls; and the background shells our calls started
  (`backgroundTaskId`).
- Other input in our turn makes it `ambiguous` (only the kind of input is reported, at most 50
  entries, the last saying `+N more`):
  - any prompt submitted with our turn id: typed at the terminal, a peer, the bridge, the SDK,
    another plugin;
  - except a task notification whose every `<task-id>`/`<tool-use-id>` names our own work, and a
    subagent hand-back (`<agent-message from="…">`) from one of our own subagents;
  - a turn whose text holds anything besides the wrapper and our rendering (merged prompts).
  After reporting `ambiguous`, the mod submits the protocol's unmatched notice
  (`renderUnmatchedNotice`) telling the agent to answer with `comms reply`. Its header is not a
  delivery header, so its turn is never collected.
- Follow-ups: a task notification for background work of a request whose turn already ended gets
  context telling the agent to send the result with `comms reply`. The note says what actually
  happened to that turn's reply (sent, not sent because of other input, or no answer).
- Presence: busy from any main-loop `turn.start` to its `turn.complete`. Nothing else about turns
  that aren't ours is sent.
- Restart checks: answered from the journal, re-read from disk at check time (another session of
  the participant may have written it). Same session: running, or completed with the outcome. An
  earlier session's unfinished one: `unknown`. `no` only when the journal was read whole, never
  dropped ids, and doesn't name it (it's written before every submission). The transcript only ever
  proves presence (`unknown`), since a compacted transcript can't prove absence. A check for a
  prompt still queued waits until its turn starts, or until the start deadline (then `unknown`).
- Reconnect: any `unknown_session` means register again and retry; `session_superseded` stops the
  mod.

## Files

- `hooks/register.ts`: binds the engine's `$` and events.
- `hooks/core/mod.ts`: registration, polling, submission, checks, reports (retried), presence, journal.
- `hooks/core/tracker.ts`: reply matching, pure.
- `hooks/protocol/`: a copy of `packages/protocol/src` (a hooks module imports only files inside
  its plugin). `node scripts/sync-protocol.ts` refreshes it; `typecheck` and `test` fail if stale.
- `.claude-plugin/`: manifest and local marketplace. `types/` is written by Claude Code on load.

## Tests

`pnpm --filter @agent-comms/claude-code-mod test`: the tracker, and the mod against the real
connector stub over a Unix socket. `claude plugin validate packages/claude-code-mod` checks what
the engine will accept (it requires literal `$.env.get` names).

## Known limits

- Notifications are linked by the ids in their text, so headless `claude -p` sessions link them
  too. Task rows (drawn only on a surface) only add task-id-to-call mappings.
- A queued plugin prompt can't be cancelled; past the start deadline it stays tracked, and a late
  start is reported (the connector may refuse it if the delivery already went `uncertain`; the mod
  then tells the agent to `comms reply`).
- The merged-prompt check knows Claude Code 2.1.286's wrapper sentences; if they change, turns
  read as merged and go ambiguous (never mis-collected).
- Claude Code often ends a turn while a background shell or an async helper still runs; the turn's
  own (interim) answer is collected and the result arrives as a `comms reply` follow-up.
