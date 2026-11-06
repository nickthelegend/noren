#!/usr/bin/env bash
# Deploys NorenArcHook on Arc Testnet (5042002) and records it in deployments.json.
# Key: NOREN_DEPLOYER_KEY from a gitignored env file (default: the main checkout's .env.arc-deployer).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-"/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.env.arc-deployer"}
[ -f "$ENV_FILE" ] || { echo "Setup required: $ENV_FILE with NOREN_DEPLOYER_KEY" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
[ -n "${NOREN_DEPLOYER_KEY:-}" ] || { echo "Setup required: NOREN_DEPLOYER_KEY" >&2; exit 1; }
RPC=https://rpc.testnet.arc.io
MT=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
USDC=0x3600000000000000000000000000000000000000
FORWARDER=${FORWARDER:-0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1}   # CRE MockKeystoneForwarder, arc-testnet
OWNER=$(cast wallet address --private-key "$NOREN_DEPLOYER_KEY")
OUT=$(forge create src/NorenArcHook.sol:NorenArcHook --rpc-url $RPC --private-key "$NOREN_DEPLOYER_KEY" --broadcast --json \
  --constructor-args $MT $USDC $FORWARDER "$OWNER")
ADDR=$(echo "$OUT" | jq -r .deployedTo); TX=$(echo "$OUT" | jq -r .transactionHash)
[ "$ADDR" != null ] || { echo "deploy failed: $OUT" >&2; exit 1; }
[ "$(cast call "$ADDR" 'localDomain()(uint32)' --rpc-url $RPC)" = 26 ] || { echo "localDomain != 26" >&2; exit 1; }
BLOCK=$(cast receipt "$TX" blockNumber --rpc-url $RPC)
jq --arg a "$ADDR" --arg t "$TX" --arg b "$BLOCK" --arg f "$FORWARDER" --arg o "$OWNER" \
  '."5042002" = {NorenArcHook: $a, deployTx: $t, deployBlock: ($b|tonumber), forwarder: $f, owner: $o, messageTransmitter: "'$MT'", usdc: "'$USDC'"}' \
  deployments.json > deployments.json.tmp && mv deployments.json.tmp deployments.json
echo "NorenArcHook $ADDR"
echo "tx https://explorer.testnet.arc.io/tx/$TX"
