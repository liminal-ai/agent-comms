#!/usr/bin/env bash
# Link a T3 v0.0.44 checkout's client packages (and its effect) into
# src/t3/node_modules, so src/t3/*.ts imports T3's own RPC client and
# contracts without a build. Only src/t3/ sees them; the rest of the adapter
# uses this repo's effect and talks to src/t3/ through plain promises.
# Symlinks only: the checkout is never modified. Same approach as
# long-horizon-context/packages/t3code-inject.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T3="${AGENT_COMMS_T3_CHECKOUT:-/srv/agents/hazel/t3code-v044}"
[[ -d "$T3/packages/client-runtime/node_modules" ]] || { echo "link-deps: $T3 isn't installed (no packages/client-runtime/node_modules)" >&2; exit 1; }
NM="$HERE/src/t3/node_modules"
mkdir -p "$NM/@t3tools"
ln -sfn "$T3/packages/client-runtime" "$NM/@t3tools/client-runtime"
ln -sfn "$T3/packages/contracts" "$NM/@t3tools/contracts"
ln -sfn "$T3/packages/shared" "$NM/@t3tools/shared"
ln -sfn "$(readlink -f "$T3/packages/client-runtime/node_modules/effect")" "$NM/effect"
echo "linked T3 client packages from $T3"
