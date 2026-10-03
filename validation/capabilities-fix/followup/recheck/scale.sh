#!/usr/bin/env bash
# Follow-up re-check at volume, against the SCRATCH deployment only (scale-convex.sh, 127.0.0.1:3212).
set -uo pipefail
C=/srv/agents/cedar/tmp/scale-convex.sh
T=$(cat /srv/agents/cedar/tmp/scale-admin-token)
run() { "$C" run "$@" 2>&1 | grep -v '^$'; }
ts() { date -u +%H:%M:%S; }
echo "== upgrade (marks the scratch's existing history: 1,500 old uncertain, the expired reminders) $(ts)"
run directory:upgrade "{\"adminToken\":\"$T\",\"defaultOwner\":\"lee\"}"
until run directory:markAlertHistory "{\"adminToken\":\"$T\"}" | grep -q '"done": true'; do :; done
echo "== item 2 volume: 600 in-flight deliveries (claimCount 1); 600 open uncertain incidents $(ts)"
run scaleFollowup:seed '{"kind":"inflight","n":600}' >/dev/null
run scaleFollowup:seed '{"kind":"open-uncertain","n":600}' >/dev/null
echo "== item 2 and 3: a reclaimed delivery, a cleared incident, an uncertain delivery 2 h old never reported $(ts)"
F=$(run scaleFollowup:fresh)
echo "$F"
args=$(echo "$F" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(b))))')
for i in 1 2; do echo "scan $i: $(run alerts:scan '{}' | tr -d '\n ')"; done
echo "outcome: $(run scaleFollowup:outcome "$args" | tr -d '\n ')"
echo "== item 4: 60 expiring + 50 due reminders of 32,000 CJK characters, real limits $(ts)"
text=$(node -e 'process.stdout.write("界".repeat(32000))')
ids=()
for i in $(seq 1 60); do ids+=("$(run reminders:create "{\"adminToken\":\"$T\",\"as\":\"lee\",\"target\":\"a\",\"text\":\"$text\",\"everyMs\":3600000,\"expiresMs\":60000}" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).reminder.id))')"); done
for i in $(seq 1 50); do ids+=("$(run reminders:create "{\"adminToken\":\"$T\",\"as\":\"lee\",\"target\":\"b\",\"text\":\"$text\",\"everyMs\":60000}" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).reminder.id))')"); done
echo "created ${#ids[@]} reminders; waiting 70 s for them to come due $(ts)"
sleep 70
for i in 1 2 3 4 5 6; do echo "tick $i: $(run reminders:tick '{}' | tr -d '\n ')"; done
idsjson=$(printf '%s\n' "${ids[@]}" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.stringify({reminderIds:b.trim().split("\n")})))')
run scaleSeed:stateOf "$idsjson" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const s=JSON.parse(b).reminders;const c={};for(const r of s){const k=r.state+(r.fires>0?"+fired":"");c[k]=(c[k]||0)+1}console.log("reminder outcomes:",JSON.stringify(c))})'
echo "== item 5: 300 inbox items with one timestamp, pages of 50, both views $(ts)"
run scaleFollowup:seed '{"kind":"inbox-same-time","n":300}' >/dev/null
for view in false true; do
  cursor=""; seen=0; pages=0
  while :; do
    a="{\"adminToken\":\"$T\",\"human\":\"lee\",\"limit\":50,\"unreadOnly\":$view${cursor:+,\"cursor\":\"$cursor\"}}"
    page=$(run inbox:list "$a")
    n=$(echo "$page" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const p=JSON.parse(b);console.log(p.items.filter(i=>i.message.text.startsWith("same tick")).length+" "+(p.hasMore?p.nextCursor:""))})')
    seen=$((seen + ${n%% *})); pages=$((pages+1)); cursor=${n#* }
    [[ -z "$cursor" || $pages -gt 40 ]] && break
  done
  echo "unreadOnly=$view: $seen of 300 'same tick' items reached in $pages pages"
done
echo "== done $(ts)"
