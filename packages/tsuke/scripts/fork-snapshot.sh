#!/usr/bin/env bash
# Build a durable local Robinhood chain for demos and SDK tests.
#
# Robinhood's public RPC is not an archive node: it serves state for only ~5,000-10,000 recent
# blocks (about 10-15 minutes). A plain Anvil fork therefore breaks for any slot it has not
# cached by then ("historical state ... is not available"). This script:
#   1. forks mainnet on a temporary port (8722) a few blocks behind the head,
#   2. deploys Tsuke (CREATE2) and seeds demo balances from a real holder (deploy-fork.sh),
#   3. simulates every demo flow from the demo accounts (Warm.s.sol, no broadcast) so the
#      fork caches all the real mainnet state those flows read,
#   4. dumps that state to .fork/robinhood-snapshot.json and stops the temporary fork.
# Then serve it with scripts/serve-snapshot.sh (no upstream, port 8720).
# Reads of state that was never warmed return zero on the snapshot; add flows to Warm.s.sol.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="${ROBINHOOD_RPC:-https://rpc.mainnet.chain.robinhood.com}"
TMP_PORT=8722
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
TSUKE_FORK_PORT=$TMP_PORT sh "$ROOT/scripts/deploy-fork.sh" >/dev/null
D="$ROOT/.fork/deployment.json"
j() { python3 -c "import json,sys;print(json.load(open('$D'))['$1'])"; }
cd "$ROOT/contracts"
TSUKE_ORACLE=$(j oracle) TSUKE_VAULT=$(j vault) TSUKE_GATEWAY=$(j gateway) TSUKE_CREDIT=$(j credit) TSUKE_MERCHANT=$(j demoMerchant) \
  forge script script/Warm.s.sol:Warm --rpc-url http://127.0.0.1:$TMP_PORT --sender "$(j demoCustomer)" -q >/dev/null
stop
trap - EXIT
[ -s "$SNAP" ] || { echo "Snapshot was not written" >&2; exit 1; }
python3 - "$D" "$BLOCK" <<'PY'
import json, sys
p, block = sys.argv[1], int(sys.argv[2])
d = json.load(open(p))
d['rpcUrl'] = 'http://127.0.0.1:8720'
d['network'] = 'robinhood-mainnet-snapshot'
d['forkedFromBlock'] = block
json.dump(d, open(p, 'w'), indent=2)
PY
echo "Snapshot of Robinhood mainnet block $BLOCK with Tsuke deployed: $SNAP" >&2
cat "$D"
