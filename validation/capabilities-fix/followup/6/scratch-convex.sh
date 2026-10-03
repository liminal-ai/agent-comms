#!/usr/bin/env bash
# Runs a convex CLI command against Hazel's SCRATCH deployment (127.0.0.1:3216), never the live one.
# The admin key is read from the scratch state's config and passed by env file only.
set -euo pipefail
cd /srv/agents/hazel/tmp/scratch-wt
dir=.convex/local/default
envfile="$(mktemp)"; chmod 600 "$envfile"; trap 'rm -f "$envfile"' EXIT
node -e 'const c=require(require("path").resolve(process.argv[1])); console.log("CONVEX_SELF_HOSTED_URL=http://127.0.0.1:"+c.ports.cloud); console.log("CONVEX_SELF_HOSTED_ADMIN_KEY="+c.adminKey)' "$dir/config.json" > "$envfile"
unset CONVEX_DEPLOYMENT CONVEX_AGENT_MODE
export CONVEX_TMPDIR=/srv/agents/hazel/tmp/convex-tmp
npx convex "$1" --env-file "$envfile" "${@:2}"
