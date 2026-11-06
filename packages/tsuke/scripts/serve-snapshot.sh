#!/usr/bin/env bash
# Serve the warmed Robinhood mainnet snapshot on port 8720 (chain 4663, no upstream).
# Build it first with scripts/fork-snapshot.sh. Foreground; Ctrl-C stops it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SNAP="$ROOT/.fork/robinhood-snapshot.json"
PORT="${TSUKE_FORK_PORT:-8720}"
[ -s "$SNAP" ] || { echo "Setup required: sh scripts/fork-snapshot.sh" >&2; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is already in use" >&2; exit 1; fi
exec anvil --load-state "$SNAP" --chain-id 4663 --port "$PORT" --silent
