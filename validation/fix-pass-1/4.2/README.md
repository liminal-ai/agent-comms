# 4.2: one real terminal by the documented procedure (2026-10-01, Hazel)

Procedure as written in `packages/claude-code-mod/README.md` ("Promoting a terminal agent"), option A
(approved by Reed for Lee): the terminal's own `CLAUDE_CONFIG_DIR`, Lee's `~/.claude` untouched.

| Step | Evidence | Result |
|---|---|---|
| 1-2 Own Claude Code home, mods flag in its user settings, plugin installed by `claude plugin marketplace add` + `install` from `/srv/work/agent-comms` (main) | `install.txt` | `agent-comms@agent-comms-local` enabled at user scope of `~/.config/agent-comms/claude/term-a` (0700) |
| 3 Promoted from the web view | `promote.mjs`, `web.jsonl` (step `promoted`), `web-promoted.png` | `@term-a promoted. Start its terminal with AGENT_COMMS_PARTICIPANT=term-a.`; row shows **mod not connected** |
| 4-5 Started in its own folder `~/comms-terminals/term-a` | `start-term.sh`, `terminal.txt`, `mod-log.txt` | first-run theme + trust; `registered as @term-a`; web row then `dot idle` (`web.jsonl` step `connected`, `web-connected.png`) |
| Lee posts in a web-view group, addressing it | `post.mjs`, `web.jsonl` (step `post`), `web-post.png`, `mod-log.txt` | `wakes @term-a`; `delivered` → `replied`; answer `42` shown in the group |

Inference path for this terminal: inherited `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (names only
were inspected; values never read) → local proxy `http://lim-builder:8317` (`cli-proxy-api.service`);
banner *API Usage Billing* (`terminal.txt`). Lee's own shells set no `ANTHROPIC_*` variables
(checked by name), so a terminal he starts needs a one-time `/login` in its home and then uses his
account. `start-term.sh` is the launcher used here: it passes Lee's interactive-shell `PATH` and
drops this agent session's own variables; credentials are inherited, never put on a command line.

## Safety defaults (Reed, 2026-10-01), applied to term-a

- `permissions.defaultMode: "default"` in the terminal's own settings (`safety-defaults/term-a-settings.json`); at start Claude Code offered to make auto mode the default and was answered *No, keep manual mode*; the status line then reads "manual mode on".
- Launcher `PATH` is `~/.config/agent-comms/terminal-bin` (only `comms`) plus `/usr/local/bin:/usr/bin:/bin` (`start-term.sh`).
- Re-check (`safety-defaults/`): request 1 answered `42` (replied); request 2 ran `command -v lhc-agent comms` after a permission prompt (`permission-prompt.txt`, approved once) and answered `/home/leemoore/.config/agent-comms/terminal-bin/comms exit=1`, i.e. `lhc-agent` isn't reachable.
