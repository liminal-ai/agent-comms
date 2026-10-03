#!/usr/bin/env bash
# Reed's scope items (a) and (c) at volume, against the SCRATCH deployment only.
set -uo pipefail
C=/srv/agents/cedar/tmp/scale-convex.sh
T=$(cat /srv/agents/cedar/tmp/scale-admin-token)
run() { "$C" run "$@" 2>&1 | grep -v '^$'; }
echo "== upgrade $(date -u +%T)"; run directory:upgrade "{\"adminToken\":\"$T\",\"defaultOwner\":\"lee\"}" | tr -d '\n '; echo
echo "== (a) 2,000 answered results not yet due, and one due"
D=$(run scaleFollowup:answeredNotDue '{"n":2000}' | tr -d '\n ')
echo "$D"
echo "sweep: $(run waits:sweep '{}' | tr -d '\n ')"
echo "due result: $(run scaleFollowup:dueOutcome "$D" | tr -d '\n ')"
echo "== (c) reminder lists over finished history: $(run scaleSeed:counts | tr -d '\n ')"
s=$(date +%s%3N); n=$(run reminders:list "{\"adminToken\":\"$T\"}" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const r=JSON.parse(b).reminders;console.log(r.length+" listed, states "+JSON.stringify(r.reduce((m,x)=>(m[x.state]=(m[x.state]||0)+1,m),{})))})'); echo "web list: $n ($(( $(date +%s%3N) - s )) ms)"
n=$(run reminders:list "{\"adminToken\":\"$T\",\"state\":\"expired\"}" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).reminders.length+" expired listed"))'); echo "web list, expired: $n"
n=$(run connector:reminders '{"machine":{"id":"m1","secret":"scratch-m1-secret-000000"},"as":"a"}' | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).reminders.length+" listed for @a"))'); echo "comms reminders (@a, the target of 3,000 finished): $n"
