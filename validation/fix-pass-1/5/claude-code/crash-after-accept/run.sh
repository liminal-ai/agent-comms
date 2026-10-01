#!/usr/bin/env bash
# Section 5 crash window, Claude Code side, with Cedar's fault hook: a connector that SIGKILLs
# itself right after the mod acks `delivered`, before Convex records it. Then the service comes
# back and recovery asks the session. Count turns, not messages.
set -u
export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
E=/srv/agents/hazel/agent-comms/validation/fix-pass-1/5/claude-code/crash-after-accept
mkdir -p "$E"
log=$HOME/.local/state/agent-comms/mod/cc-a.log
mark() { echo "$(date -u +%FT%T.%3NZ) $*" | tee -a "$E/steps.txt"; }
: > "$E/steps.txt"
t0=$(date -u +%FT%T)
since=$(date '+%Y-%m-%d %H:%M:%S')
tmux clear-history -t cca

mark "stop agent-comms-connector"
systemctl --user stop agent-comms-connector
systemctl --user reset-failed hazel-fp1-faulty 2>/dev/null
mark "start fault unit hazel-fp1-faulty (AGENT_COMMS_FAULT=crash-after-accept)"
systemd-run --user --unit=hazel-fp1-faulty --working-directory=/srv/work/agent-comms \
  --setenv=AGENT_COMMS_FAULT=crash-after-accept --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
  "$(command -v node)" packages/connector/src/main.ts --config "$HOME/.config/agent-comms/connector.json"
for i in $(seq 1 60); do comms status >/dev/null 2>&1 && break; sleep 1; done
mark "fault connector up; waiting for cc-a to re-register"
n0=$(grep -c "registered as @cc-a" "$log")
for i in $(seq 1 60); do [ "$(grep -c "registered as @cc-a" "$log")" -gt "$n0" ] && break; sleep 1; done
mark "cc-a re-registered"

res=$(comms send --as cc-b @cc-a "Fix pass 5 crash window: what is 6 * 7? Reply with just the number." --json)
did=$(echo "$res" | python3 -c "import json,sys;print(json.load(sys.stdin)['deliveries'][0]['id'])")
mid=$(echo "$res" | python3 -c "import json,sys;print(json.load(sys.stdin)['message']['id'])")
conv=$(echo "$res" | python3 -c "import json,sys;print(json.load(sys.stdin)['message']['conversationId'])")
mark "request sent: delivery=$did message=$mid"

for i in $(seq 1 120); do systemctl --user is-active --quiet hazel-fp1-faulty || break; sleep 1; done
mark "fault connector is $(systemctl --user is-active hazel-fp1-faulty) (exit: $(systemctl --user show hazel-fp1-faulty -p ExecMainStatus --value))"
mark "start agent-comms-connector"
systemctl --user start agent-comms-connector

for i in $(seq 1 600); do grep -q "$did: outcome" "$log" && break; sleep 1; done
sleep 10
mark "outcome: $(grep -o "$did: outcome [a-z]*" "$log" | tail -1)"

awk -v t0="$t0" '$1 >= t0' "$log" > "$E/mod-log.txt"  # the log keeps 200 lines: cut by time
tmux capture-pane -p -t cca -S -3000 > "$E/terminal.txt"
journalctl --user -u hazel-fp1-faulty --since "$since" --no-pager -o short-iso > "$E/journal-fault-unit.txt" 2>&1
journalctl --user -u agent-comms-connector --since "$since" --no-pager -o short-iso > "$E/journal-connector.txt" 2>&1
comms read --as cc-b "$conv" --limit 4 > "$E/conversation.txt" 2>&1
{
  echo "delivery: $did"
  echo "mod 'delivered' reports for it: $(grep -c "$did: delivered" "$E/mod-log.txt")"
  echo "turns started with its header (terminal): $(grep -c "delivery=$did" "$E/terminal.txt")"
  echo "connector journal lines naming it: $(cat "$E"/journal-*.txt | grep -c "$did")"
  echo "answers in the conversation to $mid: $(grep -c "answer to $mid" "$E/conversation.txt")"
} | tee "$E/counts.txt"
