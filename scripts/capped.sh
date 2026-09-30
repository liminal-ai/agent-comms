#!/usr/bin/env bash
# Run a command in a memory-capped transient systemd user unit, with SSH agent
# variables removed (lim-builder working rule). Usage: scripts/capped.sh [--mem 2G] <cmd...>
set -euo pipefail
mem=2G
if [[ "${1:-}" == "--mem" ]]; then mem="$2"; shift 2; fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
exec systemd-run --user --wait --pipe --collect --quiet \
  -p MemoryMax="$mem" -p MemorySwapMax=0 \
  --working-directory="$PWD" \
  --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
  env -u SSH_AUTH_SOCK -u GIT_SSH_COMMAND "$@"
