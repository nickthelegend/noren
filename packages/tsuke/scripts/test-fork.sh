#!/usr/bin/env bash
# Run the Tsuke Foundry suite against a local Anvil fork of Robinhood Chain mainnet.
# Reuses a fork already listening on TSUKE_FORK_PORT (default 8720), otherwise starts one
# and stops it on exit. Extra args go to forge test (e.g. --match-contract Credit -vvv).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${TSUKE_FORK_PORT:-8720}"
RPC="http://127.0.0.1:$PORT"
ANVIL_PID=
cleanup() { if [ -n "$ANVIL_PID" ]; then kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; fi; }
trap cleanup EXIT
if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  mkdir -p "$ROOT/.fork"
  sh "$ROOT/scripts/fork.sh" >"$ROOT/.fork/anvil.log" 2>&1 &
  ANVIL_PID=$!
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
fi
[ "$(cast chain-id --rpc-url "$RPC")" = 4663 ] || { echo "Expected a Robinhood mainnet fork (4663) on $RPC" >&2; exit 1; }
cd "$ROOT/contracts"
forge test --fork-url "$RPC" "$@"
