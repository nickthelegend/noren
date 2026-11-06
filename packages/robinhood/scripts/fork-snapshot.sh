#!/usr/bin/env bash
# Build a durable local Robinhood chain for demos and SDK tests.
#
# Robinhood's public RPC is not an archive node: it serves state for only ~5,000-10,000 recent
# blocks (about 10-15 minutes). A plain Anvil fork therefore breaks for any slot it has not
# cached by then ("historical state ... is not available"). This script:
#   1. forks mainnet on a temporary port (8722) a few blocks behind the head,
#   2. deploys Noren (CREATE2) and seeds demo balances from a real holder (deploy-fork.sh),
#   3. simulates every demo flow from the demo accounts (Warm.s.sol, no broadcast) with state-diff
#      recording, then writes every account and slot those flows read, with its real value at the
#      fork block, into the temporary fork (apply-warm.ts). Anvil's dump only holds state its own
#      transactions or anvil_set* calls touched, so plain reads would otherwise be lost,
#   4. dumps that state to .fork/robinhood-snapshot.json and stops the temporary fork.
# Then serve it with scripts/serve-snapshot.sh (no upstream, port 8720).
# Reads of state that was never warmed return zero on the snapshot; add flows to Warm.s.sol.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="${ROBINHOOD_RPC:-https://rpc.mainnet.chain.robinhood.com}"
TMP_PORT="${NOREN_RH_SNAPSHOT_TMP_PORT:-8722}"
SERVE_PORT="${NOREN_RH_FORK_PORT:-8720}"
SNAP="$ROOT/.fork/robinhood-snapshot.json"
mkdir -p "$ROOT/.fork"
if lsof -nP -iTCP:$TMP_PORT -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $TMP_PORT busy" >&2; exit 1; fi
BLOCK=$(( $(cast block-number --rpc-url "$UPSTREAM") - 5 ))
rm -f "$SNAP"
anvil --fork-url "$UPSTREAM" --fork-block-number "$BLOCK" --chain-id 4663 --port $TMP_PORT \
  --retries 20 --fork-retry-backoff 1500 --dump-state "$SNAP" --silent >"$ROOT/.fork/snapshot-build.log" 2>&1 &
PID=$!
stop() { kill -INT "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap stop EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url http://127.0.0.1:$TMP_PORT >/dev/null 2>&1 && break; sleep 1; done
echo "Temporary fork of block $BLOCK on :$TMP_PORT" >&2
NOREN_RH_FORK_PORT=$TMP_PORT sh "$ROOT/scripts/deploy-fork.sh" >/dev/null
D="$ROOT/.fork/deployment.json"
j() { python3 -c "import json,sys;print(json.load(open('$D'))['$1'])"; }
cd "$ROOT/contracts"
NOREN_RH_ORACLE=$(j oracle) NOREN_RH_VAULT=$(j vault) NOREN_RH_GATEWAY=$(j gateway) NOREN_RH_CREDIT=$(j credit) NOREN_RH_MERCHANT=$(j demoMerchant) NOREN_RH_BORROW=$(j borrow) \
  forge script script/Warm.s.sol:Warm --rpc-url http://127.0.0.1:$TMP_PORT --sender "$(j demoCustomer)" --gas-limit 4000000000 --memory-limit 1073741824 >"$ROOT/.fork/warm-output.txt" 2>&1 \
  || { tail -20 "$ROOT/.fork/warm-output.txt" >&2; exit 1; }
cd "$ROOT"
pnpm exec tsx scripts/apply-warm.ts "$ROOT/.fork/warm-output.txt" http://127.0.0.1:$TMP_PORT
cast rpc --rpc-url http://127.0.0.1:$TMP_PORT evm_mine >/dev/null # a block so the dump has a head with the new state
stop
trap - EXIT
[ -s "$SNAP" ] || { echo "Snapshot was not written" >&2; exit 1; }
python3 - "$D" "$BLOCK" "$SERVE_PORT" <<'PY'
import json, sys
p, block, port = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.load(open(p))
d['rpcUrl'] = 'http://127.0.0.1:' + port
d['network'] = 'robinhood-mainnet-snapshot'
d['forkedFromBlock'] = block
json.dump(d, open(p, 'w'), indent=2)
PY
echo "Snapshot of Robinhood mainnet block $BLOCK with Noren deployed: $SNAP" >&2
cat "$D"
