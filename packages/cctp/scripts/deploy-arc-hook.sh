#!/usr/bin/env bash
# Deploys NorenArcHook on Arc Testnet (5042002), wires it to Noren's shared NorenArcActionRouter
# (router.setRail(hook, keccak256("CCTP")) and hook.setRouter(router)), and records it in deployments.json.
# Key: NOREN_DEPLOYER_KEY from a gitignored env file (default: the main checkout's .env.arc-deployer).
# The deployer is shared by several agents, so every tx runs under /private/tmp/noren-arc-deployer.lock.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-"/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.env.arc-deployer"}
[ -f "$ENV_FILE" ] || { echo "Setup required: $ENV_FILE with NOREN_DEPLOYER_KEY" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
[ -n "${NOREN_DEPLOYER_KEY:-}" ] || { echo "Setup required: NOREN_DEPLOYER_KEY" >&2; exit 1; }
RPC=https://rpc.testnet.arc.io
MT=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
TM=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA   # Circle TokenMessengerV2 (same address on every CCTP V2 testnet)
USDC=0x3600000000000000000000000000000000000000
FORWARDER=${FORWARDER:-0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1}   # CRE MockKeystoneForwarder, arc-testnet
ROUTER=${ROUTER:-0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4}         # NorenArcActionRouter (packages/ccip, branch ccip)
RAIL=$(cast keccak "CCTP")
OWNER=$(cast wallet address --private-key "$NOREN_DEPLOYER_KEY")
LOCK=/private/tmp/noren-arc-deployer.lock
until mkdir "$LOCK" 2>/dev/null; do
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null || true; else sleep 2; fi
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
nonce() { cast nonce "$OWNER" --block pending --rpc-url $RPC; }
OUT=$(forge create src/NorenArcHook.sol:NorenArcHook --rpc-url $RPC --private-key "$NOREN_DEPLOYER_KEY" --broadcast --json --nonce "$(nonce)" \
  --constructor-args $MT $USDC $TM $FORWARDER "$OWNER")
ADDR=$(echo "$OUT" | jq -r .deployedTo); TX=$(echo "$OUT" | jq -r .transactionHash)
[ "$ADDR" != null ] || { echo "deploy failed: $OUT" >&2; exit 1; }
[ "$(cast call "$ADDR" 'localDomain()(uint32)' --rpc-url $RPC)" = 26 ] || { echo "localDomain != 26" >&2; exit 1; }
SETROUTER=$(cast send "$ADDR" 'setRouter(address)' $ROUTER --rpc-url $RPC --private-key "$NOREN_DEPLOYER_KEY" --nonce "$(nonce)" --json | jq -r .transactionHash)
SETRAIL=$(cast send $ROUTER 'setRail(address,bytes32)' "$ADDR" "$RAIL" --rpc-url $RPC --private-key "$NOREN_DEPLOYER_KEY" --nonce "$(nonce)" --json | jq -r .transactionHash)
[ "$(cast call "$ADDR" 'router()(address)' --rpc-url $RPC)" = "$ROUTER" ] || { echo "router not set" >&2; exit 1; }
[ "$(cast call $ROUTER 'railOf(address)(bytes32)' "$ADDR" --rpc-url $RPC)" = "$RAIL" ] || { echo "rail not set" >&2; exit 1; }
BLOCK=$(cast receipt "$TX" blockNumber --rpc-url $RPC)
jq --arg a "$ADDR" --arg t "$TX" --arg b "$BLOCK" --arg f "$FORWARDER" --arg o "$OWNER" --arg r "$ROUTER" --arg sr "$SETROUTER" --arg sl "$SETRAIL" \
  '."5042002" |= (if .NorenArcHook then .previous = ((.previous // []) + [{NorenArcHook: .NorenArcHook, deployTx: .deployTx, deployBlock: .deployBlock}]) else . end)
   | ."5042002" += {NorenArcHook: $a, deployTx: $t, deployBlock: ($b|tonumber), forwarder: $f, owner: $o, router: $r, setRouterTx: $sr, setRailTx: $sl,
                    messageTransmitter: "'$MT'", usdc: "'$USDC'"}' deployments.json > deployments.json.tmp && mv deployments.json.tmp deployments.json
echo "NorenArcHook $ADDR"
echo "deploy    https://explorer.testnet.arc.io/tx/$TX"
echo "setRouter https://explorer.testnet.arc.io/tx/$SETROUTER"
echo "setRail   https://explorer.testnet.arc.io/tx/$SETRAIL"
