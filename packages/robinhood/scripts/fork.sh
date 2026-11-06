#!/usr/bin/env bash
# Start a local Anvil fork of Robinhood Chain mainnet (chain 4663) on port 8720.
# Real Stock Tokens, USDG, WETH and Chainlink feeds; no real money moves.
# Usage: sh scripts/fork.sh            (foreground; Ctrl-C stops it)
#        FORK_BLOCK=107288000 sh scripts/fork.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="${ROBINHOOD_RPC:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${NOREN_RH_FORK_PORT:-8720}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use; stop that process or set NOREN_RH_FORK_PORT (8720-8729)." >&2
  exit 1
fi
BLOCK="${FORK_BLOCK:-$(( $(cast block-number --rpc-url "$UPSTREAM") - 20 ))}"
mkdir -p "$ROOT/.fork"
echo "Forking Robinhood Chain mainnet at block $BLOCK on http://127.0.0.1:$PORT" >&2
exec anvil --fork-url "$UPSTREAM" --fork-block-number "$BLOCK" --chain-id 4663 --port "$PORT" \
  --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 300 --silent
