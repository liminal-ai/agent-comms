#!/usr/bin/env bash
# Fix pass section 4 scale run, against the SCRATCH deployment only (scale-convex.sh).
set -uo pipefail
C=/srv/agents/cedar/tmp/scale-convex.sh
T=$(cat /srv/agents/cedar/tmp/scale-admin-token)
run() { "$C" run "$@" 2>&1 | grep -v '^$'; }
ts() { date -u +%H:%M:%S.%3N; }
echo "== setup $(ts)"
run directory:registerMachine "{\"adminToken\":\"$T\",\"machineId\":\"m1\",\"secret\":\"scratch-m1-secret-000000\"}" >/dev/null
run directory:promote "{\"adminToken\":\"$T\",\"name\":\"lee\",\"kind\":\"human\"}" >/dev/null
for n in a b; do run directory:promote "{\"adminToken\":\"$T\",\"name\":\"$n\",\"kind\":\"agent\",\"owner\":\"lee\",\"home\":{\"machine\":\"m1\",\"harness\":\"t3\",\"locator\":\"$n\"}}" >/dev/null; done
run directory:upgrade "{\"adminToken\":\"$T\",\"defaultOwner\":\"lee\"}"
echo "== seeding $(ts)"
seed() { local kind=$1 total=$2; for ((o=0; o<total; o+=500)); do run scaleSeed:seed "{\"kind\":\"$kind\",\"n\":500,\"offset\":$o}" >/dev/null || echo "seed $kind $o failed"; done; }
seed answers 5000; seed replied 2000; seed uncertain 1500; seed reminders 3000; seed alerts 2000; seed waits 2000
echo "== counts after seeding $(ts)"
run scaleSeed:counts
echo "== new items to find among the history $(ts)"
exp=$(run reminders:create "{\"adminToken\":\"$T\",\"as\":\"lee\",\"target\":\"a\",\"text\":\"expires now\",\"everyMs\":3600000,\"expiresMs\":60000}" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).reminder.id))')
due=$(run reminders:create "{\"adminToken\":\"$T\",\"as\":\"lee\",\"target\":\"b\",\"text\":\"fires\",\"everyMs\":60000}" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).reminder.id))')
run scaleSeed:fresh
echo "waiting 75 s for the reminders to come due (and for the crons to run on their own too)"
sleep 75
run connector:heartbeat '{"machine":{"id":"m1","secret":"scratch-m1-secret-000000"}}' >/dev/null
for f in reminders:tick alerts:scan waits:sweep; do
  s=$(date +%s%3N); out=$(run $f '{}'); e=$(date +%s%3N)
  echo "$f -> $out ($((e - s)) ms including the CLI)"
done
echo "== results $(ts)"
run scaleSeed:stateOf "{\"reminderIds\":[\"$exp\",\"$due\"]}"
