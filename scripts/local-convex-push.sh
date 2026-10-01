#!/usr/bin/env bash
# Pushes convex/ to the local backend started by scripts/local-convex.sh, as a
# self-hosted deployment. The admin key is read from the state dir's config.json
# and passed through the environment only; never printed.
#
#   scripts/local-convex-push.sh <state-dir> [convex dev args...]   (default: --once)
set -euo pipefail
dir="${1:?usage: local-convex-push.sh <state-dir> [args...]}"; shift
cfg="$dir/config.json"
read_cfg() { node -e 'const c=require(process.argv[1]); process.stdout.write(String(process.argv[2].split(".").reduce((o,k)=>o[k],c)))' "$cfg" "$1"; }
cd "$(dirname "$0")/.."
# --env-file wins over a stray .env.local (CONVEX_DEPLOYMENT=...). Owner-only, removed on exit.
envfile="$(mktemp)"
chmod 600 "$envfile"
trap 'rm -f "$envfile"' EXIT
{
  echo "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:$(read_cfg ports.cloud)"
  echo "CONVEX_SELF_HOSTED_ADMIN_KEY=$(read_cfg adminKey)"
} > "$envfile"
unset CONVEX_DEPLOYMENT CONVEX_AGENT_MODE
npx convex dev --env-file "$envfile" --typecheck disable --tail-logs disable "${@:---once}"
