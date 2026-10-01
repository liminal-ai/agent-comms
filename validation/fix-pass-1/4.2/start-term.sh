#!/usr/bin/env bash
# start-term <name>: start a promoted terminal the documented way, in tmux (socket -L <name>):
# own folder ~/comms-terminals/<name>, own CLAUDE_CONFIG_DIR, and a PATH whose only non-system
# entry is ~/.config/agent-comms/terminal-bin (comms), so comms is the terminal's only way out.
# Auth: inherited from this process's environment (never placed on a command line).
name="$1"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
USER_PATH="$HOME/.config/agent-comms/terminal-bin:/usr/local/bin:/usr/bin:/bin"
unset_args=()
for v in $(env | cut -d= -f1 | grep -E "^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_EFFORT|CLAUDE_PID|CLAUDE_LHC_SIDECAR|CLAUDE_CONFIG_DIR|LHC_AGENT_ID|T3CODE_|AGENT_COMMS_|SSH_AUTH_SOCK|GIT_SSH_COMMAND)"); do unset_args+=(-u "$v"); done
tmux -L "$name" kill-server 2>/dev/null
env "${unset_args[@]}" PATH="$USER_PATH" systemd-run --user --scope --quiet -p MemoryMax=3G --unit="term-$name-$(date +%s)" \
  tmux -L "$name" new-session -d -s "$name" -x 180 -y 50 -c "$HOME/comms-terminals/$name" \
  "CLAUDE_CONFIG_DIR=\$HOME/.config/agent-comms/claude/$name AGENT_COMMS_PARTICIPANT=$name $HOME/.local/bin/claude; sleep 600"
echo "PATH: $USER_PATH"
