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
| `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | forces mods on. On Claude Code 2.1.286 they are also gated by a server-side rollout switch; set the flag in the user settings' `env` block so the mod loads regardless |

Development: `claude --plugin-dir packages/claude-code-mod`.

A promoted terminal: install from this folder (it is its own local marketplace), then start the
terminal with the participant set:

```sh
claude plugin marketplace add /srv/work/agent-comms/packages/claude-code-mod
claude plugin install agent-comms@agent-comms-local
AGENT_COMMS_PARTICIPANT=<name> claude
```

`comms` must be on the session's `PATH` for the agent to `comms reply`.

The mod keeps a journal and a log per participant in `$XDG_STATE_HOME/agent-comms/mod/`
(`~/.local/state/…`): `<name>.json` (what this participant's sessions submitted, for restart
checks) and `<name>.log` (the last 200 matching decisions).

## What it does

- `session.start`: registers with the connector (`register`), then every 2 s keeps exactly one
  poll outstanding (the connector holds it up to 20 s).
- A delivery: rendered with the protocol's `renderDelivery` (`harnessLabelsSource: true`), recorded
  in the journal, then `$.prompt.submit`. On an idle session it runs at once; on a busy one Claude
  Code runs it as its own turn when the current one ends.
- `turn.start` whose text carries our header (found as a whole line inside Claude Code's plugin
  wrapper): our turn; `delivered` with its turn id. An answer delivery ends there.
- Our main-loop `turn.complete`: `replied` with `answer`, or `failed` (`aborted`, `refusal`,
  `error`, or an answer turn with no text), unless other input entered the turn.
- Other input in our turn makes it `ambiguous` (only the kind of input is reported):
  - a prompt submitted with our turn id (typed at the terminal, a peer, the bridge…), unless the
    next turn starts with that prompt's text within 3 s (then it waited for its own turn);
  - a task notification delivered into our turn, unless its transcript row names a tool call or a
    subagent our turn started (`toolUseId` or task id);
  - a turn whose text holds anything besides the wrapper and our rendering (merged prompts).
  After reporting `ambiguous`, the mod submits the protocol's unmatched notice
  (`renderUnmatchedNotice`) telling the agent to answer with `comms reply`. Its header is not a
  delivery header, so its turn is never collected.
- Follow-ups: a task notification for background work of a request whose turn already ended gets
  context telling the agent to send the result with `comms reply`.
- Presence: busy from any main-loop `turn.start` to its `turn.complete`. Nothing else about turns
  that aren't ours is sent.
- Restart checks: answered from the journal (same session: running, or completed with the outcome;
  an earlier session's unfinished one: `unknown`), else from the transcript (`$.session.messages`:
  found → `unknown`, absent → `no`). A check for a prompt still queued waits until its turn starts.
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

- Task rows are drawn only on a surface, so in a headless `claude -p` session a task notification
  inside our turn can't be linked and makes the delivery ambiguous.
- The merged-prompt check knows Claude Code 2.1.286's wrapper sentences; if they change, turns
  read as merged and go ambiguous (never mis-collected).
- Claude Code often ends a turn while a background shell or an async helper still runs; the turn's
  own (interim) answer is collected and the result arrives as a `comms reply` follow-up.
