#!/usr/bin/env bash
# Run the swapvm-ext Foundry suite (NorenOraclePeg + NorenAquaSwapVMRouter) against a FRESH Anvil
# fork of Robinhood Chain mainnet on port 8761, with the official Aqua registry and SwapVM router at
# their real addresses. The public RPC keeps only ~10 minutes of state, so every run forks anew.
# Extra args go to forge test (e.g. --match-test Underfunded -vvv).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="${ROBINHOOD_RPC:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${NOREN_AQUA_TEST_PORT:-8761}"
RPC="http://127.0.0.1:$PORT"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is busy; stop it first" >&2; exit 1; fi
mkdir -p "$ROOT/.fork"
BLOCK=$(( $(cast block-number --rpc-url "$UPSTREAM") - 20 ))
anvil --fork-url "$UPSTREAM" --fork-block-number "$BLOCK" --chain-id 4663 --port "$PORT" \
  --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 300 --silent >"$ROOT/.fork/test-swapvm-anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url "$RPC")" = 4663 ] || { echo "Fork did not start; see .fork/test-swapvm-anvil.log" >&2; exit 1; }
echo "Robinhood mainnet fork of block $BLOCK on $RPC" >&2
cd "$ROOT/swapvm-ext"
forge test --fork-url "$RPC" "$@"
