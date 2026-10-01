#!/usr/bin/env bash
# Runs a local Convex backend bound to 127.0.0.1 only. `npx convex dev` starts its
# local backend on 0.0.0.0 with no way to change it, so we run the same binary
# ourselves with --interface 127.0.0.1 and push functions to it as a self-hosted
# deployment (scripts/local-convex-push.sh).
#
#   scripts/local-convex.sh <state-dir>
#
# <state-dir> holds config.json ({ports, backendVersion, adminKey, instanceSecret,
# deploymentName}, as written by `npx convex dev` for a local deployment, mode 0600)
# and the backend's sqlite file and storage. Nothing here is printed.
set -euo pipefail
dir="${1:?usage: local-convex.sh <state-dir>}"
cfg="$dir/config.json"
read_cfg() { node -e 'const c=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o[k],c); process.stdout.write(String(v))' "$cfg" "$1"; }
version="$(read_cfg backendVersion)"
bin="${CONVEX_BACKEND_BIN:-$HOME/.cache/convex/binaries/$version/convex-local-backend}"
[[ -x "$bin" ]] || { echo "local-convex: no backend binary at $bin (run npx convex dev once to download it)" >&2; exit 1; }
cloud="$(read_cfg ports.cloud)"
site="$(read_cfg ports.site)"
exec "$bin" \
  --interface 127.0.0.1 \
  --port "$cloud" \
  --site-proxy-port "$site" \
  --convex-origin "http://127.0.0.1:$cloud" \
  --convex-site "http://127.0.0.1:$site" \
  --instance-name "$(read_cfg deploymentName)" \
  --instance-secret "$(read_cfg instanceSecret)" \
  --local-storage "$dir/convex_local_storage" \
  --disable-beacon \
  "$dir/convex_local_backend.sqlite3"
