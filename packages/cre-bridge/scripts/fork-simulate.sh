#!/bin/sh
# End-to-end CRE simulation of the Noren credit bridge on two local Anvil forks.
#
#   Arc        127.0.0.1:8730  fork of Arc Testnet (chain 5042002), real MockKeystoneForwarder
#   Robinhood  127.0.0.1:8731  fork of Robinhood Chain MAINNET, run with --chain-id 46630 so the
#                              CRE "robinhood-testnet" selector can address it. Real Stock Tokens
#                              and Chainlink feeds; the robinhood-testnet MockKeystoneForwarder is
#                              copied in from the real Robinhood Testnet (anvil_setCode + 2 slots).
#
# Flow (every write goes DON report -> MockKeystoneForwarder -> onReport):
#   1. Robinhood: borrower opens a line (limit from the real Chainlink NVDA feed) -> CreditLineOpened
#   2. cre simulate handler 0 (dry run, then --broadcast) -> NorenCreditLine.onReport on Arc
#   3. Arc: borrower pays a merchant invoice from the credit line -> Drawn
#   4. cre simulate handler 2 --broadcast -> TsukeCredit.onReport on Robinhood (drawn)
#   5. Arc: borrower repays part -> Repaid; handler 2 again -> Robinhood (repaid)
#   6. Robinhood: borrower closes -> CreditLineClosed; handler 1 -> Arc line frozen, draws revert
#   7. Direct onReport calls from a non-forwarder revert on both chains
#
# TsukeCredit: until packages/tsuke lands on origin/tsuke-credit, the Robinhood receiver is the
# clearly labelled TsukeCreditHarness (packages/arc-credit/src/harness), which emits the identical
# fixed-interface events. Arc USDC: the repo's fork-only ForkUSDC shim replaces Arc's native USDC
# (stock Anvil cannot execute it), as in scripts/dev-stack.ts.
#
# Uses Anvil's published dev accounts (public "test ... junk" mnemonic) on the local forks only.
# Nothing is sent to a public chain. NOREN_CRE_CAPTURE=1 writes fixtures/fork-run.json.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CREDIT_PKG="$ROOT/../arc-credit"
USDC_SHIM_SRC="$ROOT/../contracts/src/ForkUSDC.sol"
ARC_PORT=8730
RH_PORT=8731
ARC="http://127.0.0.1:$ARC_PORT"
RH="http://127.0.0.1:$RH_PORT"
ARC_UPSTREAM=https://rpc.testnet.arc.io
RH_UPSTREAM=https://rpc.mainnet.chain.robinhood.com
RH_TESTNET=https://rpc.testnet.chain.robinhood.com
ARC_FORWARDER=0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1
RH_FORWARDER=0x0b93082D9b3C7C97fAcd250082899BAcf3af3885
ARC_USDC=0x3600000000000000000000000000000000000000
NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
NVDA_FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
WORK=$(mktemp -d "${TMPDIR:-/tmp}/noren-cre-bridge.XXXXXX")

for c in anvil cast forge cre bun jq; do command -v "$c" >/dev/null || { echo "Setup required: $c" >&2; exit 1; }; done
for p in $ARC_PORT $RH_PORT; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $p is busy" >&2; exit 1; fi
done
[ -d "$ROOT/credit-bridge/node_modules/@chainlink/cre-sdk" ] || { echo "Setup required: cd packages/cre-bridge/credit-bridge && bun install" >&2; exit 1; }

anvil --silent --host 127.0.0.1 --port $ARC_PORT --fork-url $ARC_UPSTREAM --chain-id 5042002 >"$WORK/arc.log" 2>&1 &
ARC_PID=$!
anvil --silent --host 127.0.0.1 --port $RH_PORT --fork-url $RH_UPSTREAM --chain-id 46630 >"$WORK/rh.log" 2>&1 &
RH_PID=$!
cleanup() {
  kill "$ARC_PID" "$RH_PID" 2>/dev/null || true
  wait "$ARC_PID" "$RH_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

wait_rpc() {
  i=0
  until cast chain-id --rpc-url "$1" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 90 ] && { echo "Anvil fork $1 did not start:" >&2; head -c 800 "$2" >&2; exit 1; }
    sleep 0.5
  done
}
wait_rpc "$ARC" "$WORK/arc.log"
wait_rpc "$RH" "$WORK/rh.log"
[ "$(cast chain-id --rpc-url "$ARC")" = 5042002 ] || { echo "Arc fork has the wrong chain id" >&2; exit 1; }
[ "$(cast chain-id --rpc-url "$RH")" = 46630 ] || { echo "Robinhood fork has the wrong chain id" >&2; exit 1; }
ARC_FORK_BLOCK=$(cast block-number --rpc-url "$ARC")
RH_FORK_BLOCK=$(cast block-number --rpc-url "$RH")
echo "== Arc Testnet fork $ARC (fork block $ARC_FORK_BLOCK)"
echo "== Robinhood Chain mainnet fork $RH (fork block $RH_FORK_BLOCK of chain 4663, served as chain id 46630)"

# ---------------------------------------------------------------- forwarders
[ "$(cast code $ARC_FORWARDER --rpc-url "$ARC")" != 0x ] || { echo "Arc MockKeystoneForwarder missing on the fork" >&2; exit 1; }
[ "$(cast code $RH_FORWARDER --rpc-url "$RH")" = 0x ] || { echo "unexpected code at $RH_FORWARDER on Robinhood mainnet" >&2; exit 1; }
RH_FWD_CODE=$(cast code $RH_FORWARDER --rpc-url $RH_TESTNET)
[ "$RH_FWD_CODE" != 0x ] || { echo "robinhood-testnet MockKeystoneForwarder not found on Robinhood Testnet" >&2; exit 1; }
SELF_SLOT=$(cast index address $RH_FORWARDER 2)   # s_forwarders[address(this)] (MockKeystoneForwarder routes to itself)
cast rpc anvil_setCode $RH_FORWARDER "$RH_FWD_CODE" --rpc-url "$RH" >/dev/null
for slot in 0x0 "$SELF_SLOT"; do
  cast rpc anvil_setStorageAt $RH_FORWARDER "$(cast to-uint256 "$slot")" "$(cast storage $RH_FORWARDER "$slot" --rpc-url $RH_TESTNET)" --rpc-url "$RH" >/dev/null
done
echo "== Installed the real robinhood-testnet MockKeystoneForwarder bytecode at $RH_FORWARDER on the Robinhood fork"
echo "   typeAndVersion $(cast call $RH_FORWARDER 'typeAndVersion()(string)' --rpc-url "$RH"), isForwarder(self) $(cast call $RH_FORWARDER 'isForwarder(address)(bool)' $RH_FORWARDER --rpc-url "$RH")"
echo "   code hash fork $(cast keccak "$(cast code $RH_FORWARDER --rpc-url "$RH")") = testnet $(cast keccak "$RH_FWD_CODE")"

# ---------------------------------------------------------------- accounts (Anvil dev keys, never printed)
MN="test test test test test test test test test test test junk"
DEPLOYER_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 0)
BORROWER_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 1)
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
BORROWER=$(cast wallet address --private-key "$BORROWER_KEY")
MERCHANT=$(cast wallet address --mnemonic "$MN" --mnemonic-index 2)
printf 'CRE_ETH_PRIVATE_KEY=%s\n' "$DEPLOYER_KEY" >"$WORK/fork.env"
chmod 600 "$WORK/fork.env"

# ---------------------------------------------------------------- Arc: USDC shim + NorenCreditLine
mkdir -p "$WORK/shim/src"
cp "$USDC_SHIM_SRC" "$WORK/shim/src/ForkUSDC.sol"
printf "[profile.default]\nsrc = 'src'\nout = 'out'\nsolc_version = '0.8.28'\noptimizer = true\nbytecode_hash = 'none'\ncbor_metadata = false\n" >"$WORK/shim/foundry.toml"
SHIM_CODE=$(forge inspect --root "$WORK/shim" src/ForkUSDC.sol:ForkUSDC deployedBytecode)
cast rpc anvil_setCode $ARC_USDC "$SHIM_CODE" --rpc-url "$ARC" >/dev/null
send_arc() { cast send --rpc-url "$ARC" --json "$@" | jq -r .transactionHash; }
send_rh() { cast send --rpc-url "$RH" --json "$@" | jq -r .transactionHash; }
send_arc $ARC_USDC 'mint(address,uint256)' "$DEPLOYER" 10000000000 --private-key "$DEPLOYER_KEY" >/dev/null
send_arc $ARC_USDC 'mint(address,uint256)' "$BORROWER" 100000000 --private-key "$DEPLOYER_KEY" >/dev/null
echo "== Arc USDC at $ARC_USDC replaced by the fork-only ForkUSDC shim; minted 10,000 to the pool funder, 100 to the borrower"

(cd "$CREDIT_PKG" && forge build >/dev/null)
CREDIT=$(cd "$CREDIT_PKG" && forge create src/NorenCreditLine.sol:NorenCreditLine --rpc-url "$ARC" --private-key "$DEPLOYER_KEY" --broadcast --json \
  --constructor-args $ARC_USDC $ARC_FORWARDER "$DEPLOYER" | jq -r .deployedTo)
send_arc $ARC_USDC 'approve(address,uint256)' "$CREDIT" 10000000000 --private-key "$DEPLOYER_KEY" >/dev/null
send_arc "$CREDIT" 'fund(uint256)' 10000000000 --private-key "$DEPLOYER_KEY" >/dev/null
echo "== NorenCreditLine on Arc fork at $CREDIT (forwarder $(cast call "$CREDIT" 'forwarder()(address)' --rpc-url "$ARC")), pool $(cast call $ARC_USDC 'balanceOf(address)(uint256)' "$CREDIT" --rpc-url "$ARC") USDC6"

# ---------------------------------------------------------------- Robinhood: TsukeCredit receiver
TSUKE=$(cd "$CREDIT_PKG" && forge create src/harness/TsukeCreditHarness.sol:TsukeCreditHarness --rpc-url "$RH" --private-key "$DEPLOYER_KEY" --broadcast --json \
  --constructor-args $RH_FORWARDER | jq -r .deployedTo)
echo "== TsukeCreditHarness (TEST HARNESS standing in for TsukeCredit) on Robinhood fork at $TSUKE"

jq --arg rh "$TSUKE" --arg arc "$CREDIT" '.robinhood.address = $rh | .arc.address = $arc' \
  "$ROOT/credit-bridge/config.staging.json" >"$ROOT/credit-bridge/config.local-fork.json"

simulate() {
  idx=$1; shift
  (cd "$ROOT" && cre workflow simulate credit-bridge --target local-fork --non-interactive --trigger-index "$idx" -e "$WORK/fork.env" "$@") >"$WORK/sim.log" 2>&1 || {
    cat "$WORK/sim.log" >&2; echo "cre workflow simulate failed" >&2; exit 1; }
  grep -E '\[USER LOG\]|Workflow Simulation Result|^\s*"\{' "$WORK/sim.log" | sed 's/^/   | /' || true
}
written_tx() { grep -o "updated on [a-z-]*: tx 0x[0-9a-f]*" "$WORK/sim.log" | grep -o '0x[0-9a-f]*$' | tail -1; }
check_forwarded() {
  rpc=$1; tx=$2; fwd=$3
  to=$(cast tx "$tx" to --rpc-url "$rpc")
  [ "$(echo "$to" | tr 'A-F' 'a-f')" = "$(echo "$fwd" | tr 'A-F' 'a-f')" ] || { echo "write $tx did not go through the forwarder" >&2; exit 1; }
  echo "   forwarder tx $tx: status $(cast receipt "$tx" status --rpc-url "$rpc"), to $to, block $(cast receipt "$tx" blockNumber --rpc-url "$rpc"), gas $(cast receipt "$tx" gasUsed --rpc-url "$rpc")"
}

# ---------------------------------------------------------------- 1. open on Robinhood
NVDA_PRICE=$(cast call $NVDA_FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RH" | sed -n 2p | awk '{print $1}')
NVDA_SYMBOL=$(cast call $NVDA 'symbol()(string)' --rpc-url "$RH")
COLLATERAL_USD8=$((NVDA_PRICE * 10))                  # 10 NVDA at the live Chainlink price
LIMIT_USDC6=$((COLLATERAL_USD8 / 100 / 2))            # 50% of collateral value, USD8 -> USDC6
NOW=$(cast block latest --field timestamp --rpc-url "$RH")
EXPIRY=$((NOW + 30 * 86400))
LINE=$(cast keccak "noren-fork-line-$NOW")
OPEN_TX=$(send_rh "$TSUKE" 'emitOpened(bytes32,uint256,uint64,uint256)' "$LINE" $LIMIT_USDC6 $EXPIRY $COLLATERAL_USD8 --private-key "$BORROWER_KEY")
echo "== 1. Robinhood fork: CreditLineOpened tx $OPEN_TX"
echo "   10 $NVDA_SYMBOL at Chainlink NVDA/USD $NVDA_PRICE (8 dp) = collateral $COLLATERAL_USD8 usd8 -> limit $LIMIT_USDC6 USDC6, expiry $EXPIRY, line $LINE"

echo "== 2a. cre workflow simulate handler 0, no --broadcast (dry run: nothing is sent)"
simulate 0 --evm-tx-hash "$OPEN_TX" --evm-event-index 0
[ "$(cast call "$CREDIT" 'available(bytes32)(uint256)' "$LINE" --rpc-url "$ARC")" = 0 ] || { echo "dry run changed Arc" >&2; exit 1; }
echo "   Arc line still empty after the dry run"
echo "== 2b. cre workflow simulate handler 0 --broadcast: Robinhood CreditLineOpened -> Arc NorenCreditLine.onReport"
simulate 0 --evm-tx-hash "$OPEN_TX" --evm-event-index 0 --broadcast
ARC_OPEN_TX=$(written_tx); [ -n "$ARC_OPEN_TX" ] || { echo "handler 0 did not write" >&2; exit 1; }
check_forwarded "$ARC" "$ARC_OPEN_TX" $ARC_FORWARDER
AVAILABLE=$(cast call "$CREDIT" 'available(bytes32)(uint256)' "$LINE" --rpc-url "$ARC" | awk '{print $1}')
[ "$AVAILABLE" = "$LIMIT_USDC6" ] || { echo "Arc available $AVAILABLE != limit $LIMIT_USDC6" >&2; exit 1; }
echo "   Arc line available: $AVAILABLE USDC6"
echo "== 2c. same event again: workflow sees the line already synced and skips"
simulate 0 --evm-tx-hash "$OPEN_TX" --evm-event-index 0 --broadcast

# ---------------------------------------------------------------- 3-4. draw on Arc
INVOICE=$(cast keccak "noren-fork-invoice-1-$NOW")
DRAW_TX=$(send_arc "$CREDIT" 'payInvoice(bytes32,address,uint256,bytes32)' "$LINE" "$MERCHANT" 120000000 "$INVOICE" --private-key "$BORROWER_KEY")
echo "== 3. Arc fork: payInvoice 120 USDC to merchant $MERCHANT, Drawn tx $DRAW_TX"
echo "   merchant USDC balance $(cast call $ARC_USDC 'balanceOf(address)(uint256)' "$MERCHANT" --rpc-url "$ARC") USDC6"
DRAW_IDX=$(cast receipt "$DRAW_TX" --json --rpc-url "$ARC" | jq --arg a "$(echo "$CREDIT" | tr 'A-F' 'a-f')" '[.logs[] | select((.address | ascii_downcase) == $a)][0].logIndex' | xargs printf '%d')
echo "== 4. cre workflow simulate handler 2 --broadcast: Arc Drawn -> Robinhood TsukeCredit.onReport"
simulate 2 --evm-tx-hash "$DRAW_TX" --evm-event-index "$DRAW_IDX" --broadcast
RH_DRAW_TX=$(written_tx); [ -n "$RH_DRAW_TX" ] || { echo "handler 2 did not write (Drawn)" >&2; exit 1; }
check_forwarded "$RH" "$RH_DRAW_TX" $RH_FORWARDER
echo "   Robinhood utilisation (drawn, repaid, asOf): $(cast call "$TSUKE" 'utilisation(bytes32)(uint256,uint256,uint64)' "$LINE" --rpc-url "$RH" | tr '\n' ' ')"

# ---------------------------------------------------------------- 5. repay on Arc
send_arc $ARC_USDC 'approve(address,uint256)' "$CREDIT" 50000000 --private-key "$BORROWER_KEY" >/dev/null
REPAY_TX=$(send_arc "$CREDIT" 'repay(bytes32,uint256)' "$LINE" 50000000 --private-key "$BORROWER_KEY")
REPAY_IDX=$(cast receipt "$REPAY_TX" --json --rpc-url "$ARC" | jq --arg a "$(echo "$CREDIT" | tr 'A-F' 'a-f')" '[.logs[] | select((.address | ascii_downcase) == $a)][0].logIndex' | xargs printf '%d')
echo "== 5. Arc fork: repay 50 USDC, Repaid tx $REPAY_TX; handler 2 --broadcast"
simulate 2 --evm-tx-hash "$REPAY_TX" --evm-event-index "$REPAY_IDX" --broadcast
RH_REPAY_TX=$(written_tx); [ -n "$RH_REPAY_TX" ] || { echo "handler 2 did not write (Repaid)" >&2; exit 1; }
check_forwarded "$RH" "$RH_REPAY_TX" $RH_FORWARDER
UTIL=$(cast call "$TSUKE" 'utilisation(bytes32)(uint256,uint256,uint64)' "$LINE" --rpc-url "$RH" | awk '{print $1}' | tr '\n' ' ')
echo "   Robinhood utilisation (drawn, repaid, asOf): $UTIL"
case "$UTIL" in "120000000 50000000 "*) ;; *) echo "Robinhood utilisation is wrong" >&2; exit 1 ;; esac
echo "== 5b. replay the Drawn event: Robinhood already has a newer asOf, workflow skips"
simulate 2 --evm-tx-hash "$DRAW_TX" --evm-event-index "$DRAW_IDX" --broadcast

# ---------------------------------------------------------------- 6. close on Robinhood
CLOSE_TX=$(send_rh "$TSUKE" 'emitClosed(bytes32)' "$LINE" --private-key "$BORROWER_KEY")
echo "== 6. Robinhood fork: CreditLineClosed tx $CLOSE_TX; handler 1 --broadcast"
simulate 1 --evm-tx-hash "$CLOSE_TX" --evm-event-index 0 --broadcast
ARC_CLOSE_TX=$(written_tx); [ -n "$ARC_CLOSE_TX" ] || { echo "handler 1 did not write" >&2; exit 1; }
check_forwarded "$ARC" "$ARC_CLOSE_TX" $ARC_FORWARDER
echo "   Arc line: $(cast call "$CREDIT" 'lines(bytes32)((address,uint64,uint64,bool,uint256,uint256,uint256))' "$LINE" --rpc-url "$ARC")"
if cast send "$CREDIT" 'payInvoice(bytes32,address,uint256,bytes32)' "$LINE" "$MERCHANT" 1000000 "$(cast keccak inv-after-close)" --rpc-url "$ARC" --private-key "$BORROWER_KEY" >"$WORK/after.log" 2>&1; then
  echo "draw after close unexpectedly succeeded" >&2; exit 1
fi
echo "   payInvoice after close reverted: $(grep -o -m1 'LineClosed' "$WORK/after.log" || grep -i -m1 revert "$WORK/after.log" | cut -c 1-160)"
echo "== 6b. replay the opened event after close: workflow sees the frozen line and skips"
simulate 0 --evm-tx-hash "$OPEN_TX" --evm-event-index 0 --broadcast

# ---------------------------------------------------------------- 7. forwarder-only receivers
REPORT_ARC=$(cast abi-encode 'f(address,bytes32,uint256,uint64)' "$BORROWER" "$(cast keccak x)" 1 $EXPIRY)
REPORT_RH=$(cast abi-encode 'f(bytes32,uint256,uint256,uint64)' "$LINE" 0 0 $((NOW + 100)))
if cast send "$CREDIT" 'onReport(bytes,bytes)' 0x "$REPORT_ARC" --rpc-url "$ARC" --private-key "$BORROWER_KEY" >/dev/null 2>&1; then echo "direct Arc onReport succeeded" >&2; exit 1; fi
if cast send "$TSUKE" 'onReport(bytes,bytes)' 0x "$REPORT_RH" --rpc-url "$RH" --private-key "$BORROWER_KEY" >/dev/null 2>&1; then echo "direct Robinhood onReport succeeded" >&2; exit 1; fi
echo "== 7. direct onReport from a non-forwarder reverted on both forks (NotForwarder $(cast sig 'NotForwarder(address)'))"

if [ "${NOREN_CRE_CAPTURE:-0}" = 1 ]; then
  mkdir -p "$ROOT/fixtures"
  jq -n --arg arcForkBlock "$ARC_FORK_BLOCK" --arg rhForkBlock "$RH_FORK_BLOCK" --arg credit "$CREDIT" --arg tsuke "$TSUKE" --arg line "$LINE" \
    --arg open "$OPEN_TX" --arg arcOpen "$ARC_OPEN_TX" --arg draw "$DRAW_TX" --arg rhDraw "$RH_DRAW_TX" --arg repay "$REPAY_TX" --arg rhRepay "$RH_REPAY_TX" \
    --arg close "$CLOSE_TX" --arg arcClose "$ARC_CLOSE_TX" --arg nvda "$NVDA_PRICE" --arg limit "$LIMIT_USDC6" \
    '{note: "LOCAL FORKS ONLY. Captured by packages/cre-bridge/scripts/fork-simulate.sh. Arc = Anvil fork of Arc Testnet (5042002). Robinhood = Anvil fork of Robinhood Chain mainnet (4663) served as chain id 46630. These hashes do not exist on any public chain. The Robinhood receiver is TsukeCreditHarness (test harness).",
      arcForkBlock: $arcForkBlock, robinhoodForkBlock: $rhForkBlock, norenCreditLine: $credit, tsukeCreditHarness: $tsuke, lineId: $line,
      nvdaUsd8: $nvda, limitUsdc6: $limit,
      flow: [
        {step: "CreditLineOpened (Robinhood)", tx: $open}, {step: "NorenCreditLine.onReport via forwarder (Arc)", tx: $arcOpen},
        {step: "payInvoice -> Drawn 120 USDC (Arc)", tx: $draw}, {step: "TsukeCredit.onReport via forwarder (Robinhood)", tx: $rhDraw},
        {step: "repay -> Repaid 50 USDC (Arc)", tx: $repay}, {step: "TsukeCredit.onReport via forwarder (Robinhood)", tx: $rhRepay},
        {step: "CreditLineClosed (Robinhood)", tx: $close}, {step: "NorenCreditLine.onReport limit 0 via forwarder (Arc)", tx: $arcClose}
      ]}' >"$ROOT/fixtures/fork-run.json"
  echo "== transcript saved to fixtures/fork-run.json"
fi
echo "== PASS: credit line bridged both ways through CRE on local forks (forks stop now)"
