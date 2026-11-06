#!/usr/bin/env bash
# Run the Foundry suite against a FRESH Anvil fork of Robinhood Chain mainnet on port 8723.
# A fresh fork is required: the public RPC keeps only ~10 minutes of state, so an old fork
# (or the warmed demo snapshot on 8720) cannot serve slots the tests touch for the first time.
# Extra args go to forge test (e.g. --match-contract NorenCredit -vvv).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${NOREN_RH_TEST_PORT:-8723}"
RPC="http://127.0.0.1:$PORT"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is busy; stop it first" >&2; exit 1; fi
mkdir -p "$ROOT/.fork"
NOREN_RH_FORK_PORT=$PORT sh "$ROOT/scripts/fork.sh" >"$ROOT/.fork/test-anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() { pkill -P "$ANVIL_PID" 2>/dev/null || true; kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url "$RPC")" = 4663 ] || { echo "Fork did not start; see .fork/test-anvil.log" >&2; exit 1; }
cd "$ROOT/contracts"
forge test --fork-url "$RPC" "$@"
