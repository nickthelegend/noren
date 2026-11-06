#!/bin/sh
# End-to-end CRE simulation against a local Anvil fork of Arc Testnet.
#
#   1. fork Arc Testnet on 127.0.0.1:${NOREN_CRE_FORK_PORT:-8710} (the fork carries the real
#      CRE MockKeystoneForwarder 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1)
#   2. deploy NorenRateOracle with that forwarder
#   3. cre workflow simulate --broadcast: live Arc mainnet Chainlink reads -> report -> forwarder -> onReport
#   4. read the stored rates and an on-chain quote back
#   5. simulate again: the workflow sees the rounds already stored and skips the write
# Step 3 is preceded by a dry run without --broadcast (the simulator sends nothing).
# NOREN_CRE_CAPTURE=1 saves the delivered report to fixtures/fork-run.json (the Foundry tests embed it).
#
# Uses Anvil's published dev account 0 (from the public "test ... junk" mnemonic) on the local fork only.
# No real money moves; Arc mainnet is only read.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONTRACTS="$ROOT/../contracts"
PORT=${NOREN_CRE_FORK_PORT:-8710}
RPC="http://127.0.0.1:$PORT"
FORWARDER=0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1
WORK=$(mktemp -d "${TMPDIR:-/tmp}/noren-cre-pricing.XXXXXX")
LOG="$WORK/anvil.log"

case "$PORT" in 871[0-9]) ;; *) echo "NOREN_CRE_FORK_PORT must be in 8710-8719" >&2; exit 1 ;; esac
command -v anvil >/dev/null || { echo "Setup required: Foundry (anvil, forge, cast)" >&2; exit 1; }
command -v cre >/dev/null || { echo "Setup required: CRE CLI (cre)" >&2; exit 1; }
command -v bun >/dev/null || { echo "Setup required: bun" >&2; exit 1; }
command -v jq >/dev/null || { echo "Setup required: jq" >&2; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is busy" >&2; exit 1; fi

anvil --silent --host 127.0.0.1 --port "$PORT" --fork-url https://rpc.testnet.arc.io --chain-id 5042002 >"$LOG" 2>&1 &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

i=0
until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "Anvil fork did not start:" >&2; head -c 800 "$LOG" >&2; exit 1; }
  sleep 0.5
done
[ "$(cast chain-id --rpc-url "$RPC")" = 5042002 ] || { echo "fork is not Arc Testnet" >&2; exit 1; }
[ "$(cast code "$FORWARDER" --rpc-url "$RPC")" != 0x ] || { echo "MockKeystoneForwarder missing on fork" >&2; exit 1; }
FORK_BLOCK=$(cast block-number --rpc-url "$RPC")
echo "== Arc Testnet fork at $RPC (fork block $FORK_BLOCK), MockKeystoneForwarder has code"

# Anvil's published dev key, derived from the public mnemonic. Local fork only; never printed.
DEV_KEY=$(cast wallet private-key --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 0)
CONFIG="$ROOT/rate-oracle/config.staging.json"
CODES=$(jq -r '[.currencies[].code | "\"" + . + "\""] | join(",")' "$CONFIG")
PROXIES=$(jq -r '[.currencies[] | (.feed // "0x0000000000000000000000000000000000000000")] | join(",")' "$CONFIG")
DECIMALS=$(jq -r '[.currencies[].minorDecimals] | join(",")' "$CONFIG")
USDC_FEED=$(jq -r .usdcUsdFeed "$CONFIG")
MAX_AGE=$(jq -r .maxAgeSeconds "$CONFIG")
SOURCE_CHAIN=$(jq -r .sourceChainId "$CONFIG")

(cd "$CONTRACTS" && forge build --skip 'test/**' --skip 'fork-test/**' >/dev/null)
ORACLE=$(cd "$CONTRACTS" && forge create src/NorenRateOracle.sol:NorenRateOracle --rpc-url "$RPC" --private-key "$DEV_KEY" --broadcast --json \
  --constructor-args "$FORWARDER" "$SOURCE_CHAIN" "$USDC_FEED" "$MAX_AGE" "[$CODES]" "[$PROXIES]" "[$DECIMALS]" | jq -r .deployedTo)
echo "== NorenRateOracle deployed on the fork at $ORACLE (forwarder $(cast call "$ORACLE" 'forwarder()(address)' --rpc-url "$RPC"))"

jq --arg a "$ORACLE" '.oracle.address = $a' "$CONFIG" >"$ROOT/rate-oracle/config.local-fork.json"
printf 'CRE_ETH_PRIVATE_KEY=%s\n' "$DEV_KEY" >"$WORK/fork.env"
chmod 600 "$WORK/fork.env"

simulate() {
  (cd "$ROOT" && cre workflow simulate rate-oracle --target local-fork --non-interactive --trigger-index 0 "$@" -e "$WORK/fork.env") | tee "$WORK/sim.log"
}

echo "== cre workflow simulate, no --broadcast (dry run: nothing is sent)"
simulate
[ "$(cast call "$ORACLE" 'lastSourceBlock()(uint64)' --rpc-url "$RPC")" = 0 ] || { echo "dry run changed the oracle" >&2; exit 1; }
echo "oracle still empty after the dry run (lastSourceBlock 0)"

echo "== cre workflow simulate --broadcast (run 1)"
simulate --broadcast
TX=$(grep -o 'NorenRateOracle updated: .* tx 0x[0-9a-f]*' "$WORK/sim.log" | grep -o '0x[0-9a-f]*$' || true)
[ -n "$TX" ] || { echo "run 1 did not write a report" >&2; exit 1; }

echo "== Forwarder transaction $TX on the fork"
TX_TO=$(cast tx "$TX" to --rpc-url "$RPC")
TX_BLOCK=$(cast receipt "$TX" blockNumber --rpc-url "$RPC")
TX_TIME=$(cast block "$TX_BLOCK" --field timestamp --rpc-url "$RPC")
echo "status $(cast receipt "$TX" status --rpc-url "$RPC"), to $TX_TO (MockKeystoneForwarder), block $TX_BLOCK, timestamp $TX_TIME, gas used $(cast receipt "$TX" gasUsed --rpc-url "$RPC")"
[ "$(echo "$TX_TO" | tr 'A-F' 'a-f')" = "$(echo "$FORWARDER" | tr 'A-F' 'a-f')" ] || { echo "write did not go through the forwarder" >&2; exit 1; }
# MockKeystoneForwarder.report(receiver, rawReport, reportContext, signatures): rawReport = 109-byte header + workflow report.
RAW=$(cast calldata-decode 'report(address,bytes,bytes,bytes[])' "$(cast tx "$TX" input --rpc-url "$RPC")" | sed -n 2p)
REPORT="0x$(printf %s "$RAW" | cut -c 221-)"
CAPTURE="$WORK/fork-run.json"
[ "${NOREN_CRE_CAPTURE:-0}" = 1 ] && { mkdir -p "$ROOT/fixtures"; CAPTURE="$ROOT/fixtures/fork-run.json"; }
jq -n --arg tx "$TX" --arg forwarder "$FORWARDER" --arg oracle "$ORACLE" --argjson forkBlock "$FORK_BLOCK" --argjson block "$TX_BLOCK" \
  --argjson timestamp "$TX_TIME" --arg rawReport "$RAW" --arg report "$REPORT" \
  '{note: "Captured from scripts/fork-simulate.sh: cre workflow simulate --broadcast on a local Anvil fork of Arc Testnet. Feed values are live Arc mainnet Chainlink rounds.", txHash: $tx, forwarder: $forwarder, oracle: $oracle, forkBlock: $forkBlock, block: $block, timestamp: $timestamp, rawReport: $rawReport, report: $report}' \
  >"$CAPTURE"
echo "report bytes saved to $CAPTURE ($(( (${#REPORT} - 2) / 2 )) bytes)"

echo "== A direct onReport call from a non-forwarder account must revert"
if cast send "$ORACLE" 'onReport(bytes,bytes)' 0x "$REPORT" --rpc-url "$RPC" --private-key "$DEV_KEY" >"$WORK/direct.log" 2>&1; then
  echo "direct onReport unexpectedly succeeded" >&2; exit 1
fi
echo "reverted as expected: $(grep -i -m1 'revert\|error' "$WORK/direct.log" | cut -c 1-200) (UnauthorizedForwarder selector $(cast sig 'UnauthorizedForwarder(address,address)'))"

echo "== On-chain state after run 1"
LAST_BLOCK=$(cast call "$ORACLE" 'lastSourceBlock()(uint64)' --rpc-url "$RPC")
echo "lastSourceBlock (Arc mainnet block the feeds were read at): $LAST_BLOCK"
for c in $(jq -r '.currencies[].code' "$CONFIG"); do
  dec=$(jq -r --arg c "$c" '.currencies[] | select(.code == $c) | .minorDecimals' "$CONFIG")
  amount=$((10 ** dec * 100))
  q=$(cast call "$ORACLE" 'quote(string,uint256)(uint256,uint80,uint80,uint256)' "$c" "$amount" --rpc-url "$RPC" | tr '\n' ' ')
  echo "quote($c, $amount minor units = 100 $c) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: $q"
done
echo "RateUpdated events: $(cast logs --from-block "$FORK_BLOCK" --address "$ORACLE" 'RateUpdated(bytes3 indexed,uint80,uint80,uint256,uint64,uint64,uint64)' --rpc-url "$RPC" --json | jq length)"

echo "== cre workflow simulate --broadcast (run 2: same rounds expected, no write)"
simulate --broadcast
