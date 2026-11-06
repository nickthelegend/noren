#!/usr/bin/env bash
# Partial Dutch-auction liquidation demo: forks Robinhood Chain mainnet on port 8860 (the official
# Aqua registry at its real address, real NVDA, USDG and Chainlink feeds), deploys Noren with the
# modified SwapVM router (NorenOraclePeg opcode 34 + NorenDutchDecay opcode 35) and
# NorenDutchAuction, then runs every step with real token transfers and prints the fork tx hashes
# (scripts/dutch-demo.ts). Local fork only, Anvil dev keys, no real money. The anvil it starts is
# stopped on exit. Transcript: packages/aqua/.fork/dutch-demo.txt
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RH="$ROOT/../robinhood"
UPSTREAM="${ROBINHOOD_RPC:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${NOREN_DUTCH_DEMO_PORT:-8860}"
RPC="http://127.0.0.1:$PORT"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is busy; stop it first" >&2; exit 1; fi
mkdir -p "$ROOT/.fork"
BLOCK=$(( $(cast block-number --rpc-url "$UPSTREAM") - 20 ))
anvil --fork-url "$UPSTREAM" --fork-block-number "$BLOCK" --chain-id 4663 --port "$PORT" \
  --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 300 --silent >"$ROOT/.fork/dutch-anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url "$RPC")" = 4663 ] || { echo "Fork did not start; see .fork/dutch-anvil.log" >&2; exit 1; }
echo "Forked Robinhood Chain mainnet at block $BLOCK on $RPC; deploying Noren..." >&2
NOREN_RH_FORK_PORT=$PORT NOREN_RH_INSTALLMENT_INTERVAL=900 NOREN_RH_GRACE=900 sh "$RH/scripts/deploy-fork.sh" >"$ROOT/.fork/dutch-deploy.log" 2>&1 \
  || { tail -30 "$ROOT/.fork/dutch-deploy.log" >&2; exit 1; }
(cd "$RH/contracts" && forge build >/dev/null 2>"$ROOT/.fork/dutch-build.log") || { tail -20 "$ROOT/.fork/dutch-build.log" >&2; exit 1; }
python3 - "$RH/.fork/deployment.json" "$ROOT/.fork/dutch-deployment.json" "$BLOCK" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d['forkBlock'] = int(sys.argv[3])
json.dump(d, open(sys.argv[2], 'w'), indent=2)
PY
cd "$ROOT"
NODE_NO_WARNINGS=1 pnpm exec tsx scripts/dutch-demo.ts "$ROOT/.fork/dutch-deployment.json" "$RH/contracts/out/NorenDutchAuction.sol/NorenDutchAuction.json" 2>&1 | tee "$ROOT/.fork/dutch-demo.txt"
