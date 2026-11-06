#!/bin/sh
# Robinhood Chain -> Arc value bridge, end to end on a local Anvil fork of Robinhood Chain mainnet.
#
#   127.0.0.1:8732  fork of Robinhood Chain MAINNET (4663): real NVDA, USDG, Chainlink feeds,
#                   Uniswap v4 pool, Universal Router, Permit2, Relay Depository, Across SpokePool.
#                   The robinhood-testnet CRE MockKeystoneForwarder is copied in from Robinhood Testnet.
#
#   A. Merchant sells 1 NVDA for USDG on the live Uniswap v4 pool (floored at Chainlink - 2%) and
#      requests settlement to Arc. CRE workflow (log trigger, --broadcast): live Relay + Across quotes
#      via HTTP with consensus, Chainlink USDG/USD (Robinhood) and USDC/USD (Arc) over JSON-RPC,
#      approve. Keeper fetches fresh Relay calldata and deposits into the real Relay Depository.
#   B. Merchant requests 100 USDG; approved; keeper uses Across (the fallback) on the real SpokePool.
#   C. Merchant requests 100 USDG with a 1 bp max slippage; the workflow rejects; merchant cancels.
#
# The Arc-side fill needs Relay's solver / an Across relayer to see a real deposit on Robinhood
# mainnet. These deposits exist only on the fork, so no fill can happen and none is claimed.
# Live HTTP calls are read-only; no transaction is sent to any public chain.
# Uses Anvil's published dev keys on the fork only. NOREN_SETTLE_CAPTURE=1 writes fixtures/settle-run.json.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CRE_DIR="$ROOT/cre"
PORT=8732
RH="http://127.0.0.1:$PORT"
RH_UPSTREAM=https://rpc.mainnet.chain.robinhood.com
RH_TESTNET=https://rpc.testnet.chain.robinhood.com
RH_FORWARDER=0x0b93082D9b3C7C97fAcd250082899BAcf3af3885
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
USDG_USD=0x61B7e5650328764B076A108EFF5fa7282a1B9aD2
NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
NVDA_USD=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
UNIVERSAL_ROUTER=0x8876789976dEcBfCbBbe364623C63652db8C0904
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
V4_QUOTER=0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94
RELAY_DEPOSITORY=0x4cD00E387622C35bDDB9b4c962C136462338BC31
ACROSS_SPOKE=0xD29C85F15DF544bA632C9E25829fd29d767d7978
ARC_USDC=0x3600000000000000000000000000000000000000
NVDA_KEY="($USDG,$NVDA,3000,60,0x0000000000000000000000000000000000000000)"

for c in anvil cast forge cre bun jq npx; do command -v "$c" >/dev/null || { echo "Setup required: $c" >&2; exit 1; }; done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is busy" >&2; exit 1; fi
[ -d "$CRE_DIR/settlement-desk/node_modules/@chainlink/cre-sdk" ] || { echo "Setup required: cd packages/bridge-settlement/cre/settlement-desk && bun install" >&2; exit 1; }
[ -d "$ROOT/node_modules/viem" ] || { echo "Setup required: pnpm install (packages/bridge-settlement)" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/noren-settle.XXXXXX")
anvil --silent --host 127.0.0.1 --port $PORT --fork-url $RH_UPSTREAM --chain-id 4663 >"$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM
i=0
until cast chain-id --rpc-url "$RH" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 90 ] && { echo "Anvil fork did not start:" >&2; head -c 800 "$WORK/anvil.log" >&2; exit 1; }
  sleep 0.5
done
FORK_BLOCK=$(cast block-number --rpc-url "$RH")
echo "== Robinhood Chain mainnet fork $RH (fork block $FORK_BLOCK, chain id $(cast chain-id --rpc-url "$RH"))"

# CRE simulation forwarder for robinhood-testnet: real bytecode + owner + s_forwarders[self] from Robinhood Testnet.
FWD_CODE=$(cast code $RH_FORWARDER --rpc-url $RH_TESTNET)
[ "$FWD_CODE" != 0x ] || { echo "robinhood-testnet MockKeystoneForwarder not found on Robinhood Testnet" >&2; exit 1; }
cast rpc anvil_setCode $RH_FORWARDER "$FWD_CODE" --rpc-url "$RH" >/dev/null
for slot in 0x0 "$(cast index address $RH_FORWARDER 2)"; do
  cast rpc anvil_setStorageAt $RH_FORWARDER "$(cast to-uint256 "$slot")" "$(cast storage $RH_FORWARDER "$slot" --rpc-url $RH_TESTNET)" --rpc-url "$RH" >/dev/null
done
echo "== MockKeystoneForwarder installed at $RH_FORWARDER ($(cast call $RH_FORWARDER 'typeAndVersion()(string)' --rpc-url "$RH"))"

MN="test test test test test test test test test test test junk"
OWNER_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 0)
MERCHANT_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 1)
KEEPER_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 4)
OWNER=$(cast wallet address --private-key "$OWNER_KEY")
MERCHANT=$(cast wallet address --private-key "$MERCHANT_KEY")
KEEPER=$(cast wallet address --private-key "$KEEPER_KEY")
ARC_TREASURY=$(cast wallet address --mnemonic "$MN" --mnemonic-index 5)
printf 'CRE_ETH_PRIVATE_KEY=%s\n' "$OWNER_KEY" >"$WORK/fork.env"
chmod 600 "$WORK/fork.env"
first() { awk 'NR==1 {print $1}'; }
send() { cast send --rpc-url "$RH" --json "$@" | jq -r .transactionHash; }

(cd "$ROOT" && forge build >/dev/null 2>&1)
DESK=$(cd "$ROOT" && forge create src/NorenSettlementDesk.sol:NorenSettlementDesk --rpc-url "$RH" --private-key "$OWNER_KEY" --broadcast --json \
  --constructor-args $USDG $USDG_USD $RELAY_DEPOSITORY $ACROSS_SPOKE $ARC_USDC $UNIVERSAL_ROUTER $PERMIT2 $RH_FORWARDER "$KEEPER" "$OWNER" | jq -r .deployedTo)
send "$DESK" 'setStockFeed(address,address)' $NVDA $NVDA_USD --private-key "$OWNER_KEY" >/dev/null
echo "== NorenSettlementDesk on the fork at $DESK (forwarder $RH_FORWARDER, keeper $KEEPER); Arc recipient $ARC_TREASURY"

# Merchant balances from a real holder (the v4 PoolManager), impersonated on the fork only.
cast rpc anvil_impersonateAccount $POOL_MANAGER --rpc-url "$RH" >/dev/null
cast rpc anvil_setBalance $POOL_MANAGER 0x56BC75E2D63100000 --rpc-url "$RH" >/dev/null
cast send $NVDA 'transfer(address,uint256)' "$MERCHANT" 1000000000000000000 --unlocked --from $POOL_MANAGER --rpc-url "$RH" >/dev/null
cast send $USDG 'transfer(address,uint256)' "$MERCHANT" 200000000 --unlocked --from $POOL_MANAGER --rpc-url "$RH" >/dev/null
cast rpc anvil_stopImpersonatingAccount $POOL_MANAGER --rpc-url "$RH" >/dev/null
send $NVDA 'approve(address,uint256)' "$DESK" 1000000000000000000 --private-key "$MERCHANT_KEY" >/dev/null
send $USDG 'approve(address,uint256)' "$DESK" 200000000 --private-key "$MERCHANT_KEY" >/dev/null

jq --arg d "$DESK" '.desk.address = $d' "$CRE_DIR/settlement-desk/config.staging.json" >"$CRE_DIR/settlement-desk/config.local-fork.json"
REQ_TOPIC=$(cast keccak 'SettlementRequested(bytes32,address,address,uint256,uint16)')
req_idx() { cast receipt "$1" --json --rpc-url "$RH" | jq --arg t "$REQ_TOPIC" '[.logs | to_entries[] | select(.value.topics[0] == $t)][0].key'; }
req_id() { cast receipt "$1" --json --rpc-url "$RH" | jq -r --arg t "$REQ_TOPIC" '[.logs[] | select(.topics[0] == $t)][0].topics[1]'; }
simulate() {
  (cd "$CRE_DIR" && cre workflow simulate settlement-desk --target local-fork --non-interactive --trigger-index 0 -e "$WORK/fork.env" "$@") >"$WORK/sim.log" 2>&1 || {
    cat "$WORK/sim.log" >&2; echo "cre workflow simulate failed" >&2; exit 1; }
  grep -E '\[USER LOG\]' "$WORK/sim.log" | sed 's/^/   | /' || true
}
result_json() { grep -A1 'Workflow Simulation Result' "$WORK/sim.log" | tail -1 | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' -e 's/\\"/"/g'; }
settlement() { cast call "$DESK" 'settlement(bytes32)((address,uint64,uint16,uint8,uint8,address,uint64,uint256,uint256,uint256))' "$1" --rpc-url "$RH"; }
status_of() { settlement "$1" | tr -d '()' | tr ',' '\n' | sed -n 4p | tr -d ' '; }
keeper() { (cd "$ROOT" && NOREN_KEEPER_PRIVATE_KEY="$KEEPER_KEY" npx tsx keeper/execute.ts --rpc "$RH" --desk "$DESK" --id "$1" --route "$2"); }

# ---------------------------------------------------------------- A. stock -> USDG on v4, then Relay
QUOTE=$(cast call $V4_QUOTER 'quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))(uint256,uint256)' "($NVDA_KEY,false,1000000000000000000,0x)" --rpc-url "$RH" | first)
FLOOR=$(cast call "$DESK" 'stockFloorUsdg6(address,uint256,uint16)(uint256)' $NVDA 1000000000000000000 200 --rpc-url "$RH" | first)
NVDA_PRICE=$(cast call $NVDA_USD 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RH" | sed -n 2p | first)
echo "== A. 1 NVDA: Chainlink NVDA/USD $NVDA_PRICE (8 dp); Uniswap v4 V4Quoter $QUOTE USDG6; desk floor (Chainlink - 2%) $FLOOR USDG6"
SELL_TX=$(send "$DESK" 'sellStockAndRequest((address,address,uint24,int24,address),uint128,uint128,uint16,address,uint16)' "$NVDA_KEY" 1000000000000000000 "$QUOTE" 200 "$ARC_TREASURY" 50 --private-key "$MERCHANT_KEY")
ID_A=$(req_id "$SELL_TX")
AMOUNT_A=$(settlement "$ID_A" | tr -d '()' | tr ',' '\n' | sed -n 8p | first)
echo "   sellStockAndRequest tx $SELL_TX: swapped on the v4 pool for $AMOUNT_A USDG6, settlement $ID_A requested (max slippage 50 bps)"
simulate --evm-tx-hash "$SELL_TX" --evm-event-index "$(req_idx "$SELL_TX")" --broadcast
RES_A=$(result_json); echo "   result: $RES_A"
[ "$(echo "$RES_A" | jq -r .decision)" = approve ] || { echo "A was not approved" >&2; exit 1; }
APPROVE_A_TX=$(echo "$RES_A" | jq -r .txHash)
[ "$(cast tx "$APPROVE_A_TX" to --rpc-url "$RH" | tr 'A-F' 'a-f')" = "$(echo $RH_FORWARDER | tr 'A-F' 'a-f')" ] || { echo "approval did not go through the forwarder" >&2; exit 1; }
[ "$(status_of "$ID_A")" = 2 ] || { echo "A not Approved on-chain" >&2; exit 1; }
echo "   approval written through the forwarder: tx $APPROVE_A_TX; settlement now $(settlement "$ID_A")"
RELAY_BEFORE=$(cast call $USDG 'balanceOf(address)(uint256)' $RELAY_DEPOSITORY --rpc-url "$RH" | first)
KEEP_A=$(keeper "$ID_A" relay); echo "   keeper: $KEEP_A"
RELAY_AFTER=$(cast call $USDG 'balanceOf(address)(uint256)' $RELAY_DEPOSITORY --rpc-url "$RH" | first)
[ $((RELAY_AFTER - RELAY_BEFORE)) = "$AMOUNT_A" ] || { echo "Relay Depository did not receive $AMOUNT_A" >&2; exit 1; }
[ "$(status_of "$ID_A")" = 4 ] || { echo "A not Executed" >&2; exit 1; }
echo "   real Relay Depository USDG balance +$AMOUNT_A on the fork; settlement Executed"

# ---------------------------------------------------------------- B. 100 USDG, executed through Across
REQ_B_TX=$(send "$DESK" 'requestSettlement(uint256,address,uint16)' 100000000 "$ARC_TREASURY" 50 --private-key "$MERCHANT_KEY")
ID_B=$(req_id "$REQ_B_TX")
echo "== B. requestSettlement 100 USDG tx $REQ_B_TX, settlement $ID_B"
simulate --evm-tx-hash "$REQ_B_TX" --evm-event-index "$(req_idx "$REQ_B_TX")" --broadcast
RES_B=$(result_json); echo "   result: $RES_B"
[ "$(echo "$RES_B" | jq -r .decision)" = approve ] || { echo "B was not approved" >&2; exit 1; }
SPOKE_BEFORE=$(cast call $USDG 'balanceOf(address)(uint256)' $ACROSS_SPOKE --rpc-url "$RH" | first)
KEEP_B=$(keeper "$ID_B" across); echo "   keeper (Across fallback): $KEEP_B"
SPOKE_AFTER=$(cast call $USDG 'balanceOf(address)(uint256)' $ACROSS_SPOKE --rpc-url "$RH" | first)
[ $((SPOKE_AFTER - SPOKE_BEFORE)) = 100000000 ] || { echo "Across SpokePool did not receive 100 USDG" >&2; exit 1; }
DEPOSIT_TOPIC=$(cast keccak 'FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)')
ACROSS_DEPOSIT_ID=$(cast receipt "$(echo "$KEEP_B" | jq -r .txHash)" --json --rpc-url "$RH" | jq -r --arg t "$DEPOSIT_TOPIC" --arg a "$(echo $ACROSS_SPOKE | tr 'A-F' 'a-f')" '[.logs[] | select((.address|ascii_downcase) == $a and .topics[0] == $t)][0].topics[2] // "none"')
echo "   real Across SpokePool USDG balance +100000000 on the fork; FundsDeposited depositId topic $ACROSS_DEPOSIT_ID"

# ---------------------------------------------------------------- C. too tight: rejected, then cancelled
REQ_C_TX=$(send "$DESK" 'requestSettlement(uint256,address,uint16)' 100000000 "$ARC_TREASURY" 1 --private-key "$MERCHANT_KEY")
ID_C=$(req_id "$REQ_C_TX")
echo "== C. requestSettlement 100 USDG with max slippage 1 bp, tx $REQ_C_TX"
simulate --evm-tx-hash "$REQ_C_TX" --evm-event-index "$(req_idx "$REQ_C_TX")" --broadcast
RES_C=$(result_json); echo "   result: $RES_C"
[ "$(echo "$RES_C" | jq -r .decision)" = reject ] || { echo "C was not rejected" >&2; exit 1; }
[ "$(status_of "$ID_C")" = 3 ] || { echo "C not Rejected on-chain" >&2; exit 1; }
BAL=$(cast call $USDG 'balanceOf(address)(uint256)' "$MERCHANT" --rpc-url "$RH" | first)
CANCEL_TX=$(send "$DESK" 'cancel(bytes32)' "$ID_C" --private-key "$MERCHANT_KEY")
echo "   rejected on-chain; cancel tx $CANCEL_TX refunded $(( $(cast call $USDG 'balanceOf(address)(uint256)' "$MERCHANT" --rpc-url "$RH" | first) - BAL )) USDG6"

echo "== Not done here: the Arc-side fill. Relay's solver and Across relayers watch Robinhood mainnet; these deposits exist only on the fork."
if [ "${NOREN_SETTLE_CAPTURE:-0}" = 1 ]; then
  mkdir -p "$ROOT/fixtures"
  jq -n --arg block "$FORK_BLOCK" --arg desk "$DESK" --arg sell "$SELL_TX" --arg q "$QUOTE" --arg floor "$FLOOR" --arg nvda "$NVDA_PRICE" \
    --argjson a "$RES_A" --argjson ka "$KEEP_A" --arg reqB "$REQ_B_TX" --argjson b "$RES_B" --argjson kb "$KEEP_B" --arg reqC "$REQ_C_TX" --argjson c "$RES_C" --arg cancel "$CANCEL_TX" \
    '{note: "LOCAL FORK ONLY: Anvil fork of Robinhood Chain mainnet (4663). Quotes and feeds are live (read-only); these tx hashes exist on no public chain and no Arc fill happened.",
      forkBlock: $block, desk: $desk,
      A: {sellTx: $sell, v4QuoteUsdg6: $q, chainlinkFloorUsdg6: $floor, nvdaUsd8: $nvda, workflow: $a, keeper: $ka},
      B: {requestTx: $reqB, workflow: $b, keeper: $kb},
      C: {requestTx: $reqC, workflow: $c, cancelTx: $cancel}}' >"$ROOT/fixtures/settle-run.json"
  echo "== transcript saved to fixtures/settle-run.json"
fi
echo "== PASS: stock sold on Uniswap v4, settlements approved/rejected by CRE on live quotes and Chainlink feeds, deposits made into the real Relay and Across contracts (fork)"
