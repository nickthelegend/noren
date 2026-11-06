#!/bin/sh
# Noren cross-chain 1inch Aqua, end to end on local forks, every hop through `cre workflow simulate --broadcast`.
#
# "One Arc maker, orders from every chain": one maker keeps USDC in its own wallet on Arc and ships
# Chainlink-pegged Aqua strategies (SwapVM NorenOraclePeg). Takers on two other chains lock tokens in
# a Noren escrow; Chainlink CRE carries the order and the Chainlink price round to Arc, the maker's
# strategy pays the taker USDC on Arc, and CRE carries the fill back so the escrow releases the
# locked tokens to the maker.
#
#   phase A  Arc Testnet fork (8810) + Robinhood Chain mainnet snapshot (8811): NVDA Stock Token -> USDC
#            plus replay, stale/expired order, expiry and refund
#   phase B  Arc Testnet fork (8810, same state) + Base Sepolia fork (8812): WETH -> USDC, same maker
# One fork pair at a time (RAM). All hashes are LOCAL FORK transactions; nothing is sent to a public chain.
# Anvil's published dev keys only. Transcript: packages/xchain-aqua/.fork/xchain-demo.txt
set -eu
. "$(dirname "$0")/forks.sh"
need anvil cast forge jq cre bun
trap stop_forks EXIT INT TERM
CRE_DIR="$XC_ROOT/cre"
WF="$CRE_DIR/xchain-aqua"
[ -d "$WF/node_modules/@chainlink/cre-sdk" ] || { echo "Setup required: cd packages/xchain-aqua/cre/xchain-aqua && bun install" >&2; exit 1; }
[ -s "$XC_ROOT/../aqua/swapvm-ext/out/NorenAquaSwapVMRouter.sol/NorenAquaSwapVMRouter.json" ] || {
  echo "Setup required: (cd packages/aqua/swapvm-ext && forge build)" >&2; exit 1; }
WORK="$XC_ROOT/.fork/demo"
rm -rf "$WORK"; mkdir -p "$WORK"

NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
NVDA_FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
WETH=0x4200000000000000000000000000000000000006
ETH_FEED=0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1
BASE_FORWARDER=0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5
ARC_FORWARDER=0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1
MN="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MN" --mnemonic-index "$1"; }
DEPLOYER_KEY=$(key 0); TAKER_KEY=$(key 1); MAKER_KEY=$(key 3)
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
TAKER=$(cast wallet address --private-key "$TAKER_KEY")      # holds NVDA in the warmed Robinhood snapshot
MAKER=$(cast wallet address --private-key "$MAKER_KEY")      # the Arc maker
PAYOUT=$(cast wallet address --mnemonic "$MN" --mnemonic-index 5) # maker's address on the source chains
printf 'CRE_ETH_PRIVATE_KEY=%s\n' "$DEPLOYER_KEY" >"$WORK/fork.env"; chmod 600 "$WORK/fork.env"

first() { awk 'NR==1 {print $1}'; }
send() { rpc=$1; shift; cast send --rpc-url "$rpc" --json "$@" | jq -r .transactionHash; }
bal() { cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url "$3" | first; }
fmt() { python3 -c "import sys; print(f'{int(sys.argv[1])/10**int(sys.argv[2]):,.6f}'.rstrip('0').rstrip('.'))" "$1" "$2"; }
step() { echo; echo "== $*"; }
msg_index() { # position of the XChainMessage log inside the tx (CRE --evm-event-index)
  cast receipt "$2" --json --rpc-url "$1" | jq --arg t "$(cast keccak 'XChainMessage(bytes32,uint64,address,bytes)')" '[.logs | to_entries[] | select(.value.topics[0] == $t)][0].key'
}
align_clock() { now=$(date +%s); ts=$(cast block latest --field timestamp --rpc-url "$1"); if [ "$ts" -lt "$now" ]; then cast rpc evm_setNextBlockTimestamp "$now" --rpc-url "$1" >/dev/null; cast rpc evm_mine --rpc-url "$1" >/dev/null; fi; }
write_config() { # write_config <json array of chains>
  jq -n --argjson chains "$1" '{chains: $chains, maxPriceAgeSec: 259200, confidence: "SAFE"}' >"$WF/config.local-fork.json"
}
simulate() { # simulate <trigger> <tx> <rpc>
  idx=$(msg_index "$3" "$2")
  (cd "$CRE_DIR" && cre workflow simulate xchain-aqua --target local-fork --non-interactive --trigger-index "$1" \
    --evm-tx-hash "$2" --evm-event-index "$idx" -e "$WORK/fork.env" --broadcast) >"$WORK/sim.log" 2>&1 || {
    cat "$WORK/sim.log" >&2; echo "cre workflow simulate failed" >&2; exit 1; }
  grep -E '\[USER LOG\]' "$WORK/sim.log" | sed -E 's/.*\[USER LOG\] ?/   | /' || true
}
written() { grep -o "Delivered to [a-z]* 0x[0-9a-fA-F]*: tx 0x[0-9a-f]*" "$WORK/sim.log" | grep -o '0x[0-9a-f]*$' | tail -1; }
check_forwarded() { to=$(cast tx "$2" to --rpc-url "$1"); [ "$(echo "$to" | tr 'A-F' 'a-f')" = "$(echo "$3" | tr 'A-F' 'a-f')" ] || { echo "write $2 did not go through the forwarder $3" >&2; exit 1; }
  echo "   forwarder tx $2 (status $(cast receipt "$2" status --rpc-url "$1"), block $(cast receipt "$2" blockNumber --rpc-url "$1"), gas $(cast receipt "$2" gasUsed --rpc-url "$1"))"; }
ORDER_SIG='(uint64,address,uint64,address,address,address,uint256,address,uint256,address,address,bytes32,uint64,uint64,uint256)'
order_tuple() { # order_tuple <srcChain> <escrow> <tokenIn> <amountIn> <strategy> <fillDeadline> <refundAfter> <nonce>
  echo "($1,$2,5042002,$SETTLER,$TAKER,$3,$4,$ARC_USDC,1,$TAKER,$MAKER,$5,$6,$7,$8)"
}

{
trap stop_forks EXIT INT TERM
echo "Noren cross-chain 1inch Aqua: one Arc maker, orders from every chain ($(date -u '+%Y-%m-%d %H:%M UTC'))"
echo "LOCAL FORKS ONLY. Every tx hash below exists only on a local Anvil fork."

# ================================================================ phase A: Arc + Robinhood
step "Start the Arc Testnet fork and the warmed Robinhood mainnet snapshot"
start_arc
start_rh
align_clock "$ARC"
echo "   Arc Testnet fork $ARC (fork block $ARC_FORK_BLOCK). 1inch Aqua and SwapVM are not deployed on Arc Testnet,"
echo "   and 1inch's deployers (Aqua 0x71481c3b…abe7, router 0xaa710bd4…6dd7) have no code there, so the fork gets"
echo "   the OFFICIAL bytecode copied from Arc mainnet at the official addresses (fork only):"
echo "     Aqua   $AQUA codehash $AQUA_HASH (= Arc mainnet, = Robinhood Chain)"
echo "     router $OFFICIAL_ROUTER codehash $ROUTER_HASH (= Arc mainnet)"
echo "   Robinhood Chain mainnet snapshot $RH (block $RH_SNAPSHOT_BLOCK, chain 4663): real NVDA Stock Token and Chainlink NVDA/USD"

step "Deploy on Arc: Noren SwapVM router (modified SwapVM: + NorenOraclePeg), settler, escrow receipts, relayed Chainlink feeds"
(cd "$XC_ROOT/contracts" && forge script script/DeployXChain.s.sol:DeployArc --rpc-url "$ARC" --private-key "$DEPLOYER_KEY" --broadcast >"$WORK/deploy-arc.log" 2>&1) || { tail -30 "$WORK/deploy-arc.log" >&2; exit 1; }
D="$XC_ROOT/.fork/arc-deployment.json"
SETTLER=$(jq -r .settler "$D"); ROUTER=$(jq -r .router "$D"); RNVDA=$(jq -r .rNVDA "$D"); RWETH=$(jq -r .rWETH "$D")
NVDA_RELAYED=$(jq -r .nvdaUsdRelayed "$D"); ETH_RELAYED=$(jq -r .ethUsdRelayed "$D")
echo "   NorenAquaSwapVMRouter $ROUTER (AQUA() = $(cast call "$ROUTER" 'AQUA()(address)' --rpc-url "$ARC"))"
echo "   NorenCrossChainSettler $SETTLER; receipts rNVDA $RNVDA, rWETH $RWETH"
echo "   relayed feeds: NVDA/USD $NVDA_RELAYED, ETH/USD $ETH_RELAYED"
cast send $ARC_USDC 'mint(address,uint256)' "$MAKER" 20000000000 --rpc-url "$ARC" --private-key "$DEPLOYER_KEY" >/dev/null
echo "   maker $MAKER holds $(fmt "$(bal $ARC_USDC "$MAKER" "$ARC")" 6) USDC on Arc (fork-only ForkUSDC shim at $ARC_USDC)"

step "Maker ships two Chainlink-pegged Aqua strategies from ONE USDC wallet: NVDA (Robinhood) and WETH (Base Sepolia)"
(cd "$XC_ROOT/contracts" && XCHAIN_SETTLER=$SETTLER XCHAIN_ROUTES="$(jq -r .nvdaRoute "$D"),$(jq -r .wethRoute "$D")" XCHAIN_IN_TOKENS="$RNVDA,$RWETH" \
  XCHAIN_ALLOC=15000000000 XCHAIN_BID_BPS=50 XCHAIN_PAYOUT="$PAYOUT" XCHAIN_OUT=../.fork/maker.json \
  forge script script/DeployXChain.s.sol:MakerShip --rpc-url "$ARC" --private-key "$MAKER_KEY" --broadcast >"$WORK/maker.log" 2>&1) || { tail -30 "$WORK/maker.log" >&2; exit 1; }
NVDA_STRAT=$(jq -r '."0"' "$XC_ROOT/.fork/maker.json"); WETH_STRAT=$(jq -r '."1"' "$XC_ROOT/.fork/maker.json")
for tx in $(jq -r '.transactions[].hash' "$XC_ROOT/contracts/broadcast/DeployXChain.s.sol/5042002/run-latest.json"); do echo "   maker tx $tx"; done
echo "   NVDA strategy $NVDA_STRAT, WETH strategy $WETH_STRAT; 15,000 USDC Aqua allocation each, bid 50 bps, payout $PAYOUT"

step "Deploy the Robinhood escrow (NVDA + Chainlink NVDA/USD) and trust it on Arc"
(cd "$XC_ROOT/contracts" && XCHAIN_ARC_SETTLER=$SETTLER XCHAIN_TOKEN=$NVDA XCHAIN_FEED=$NVDA_FEED XCHAIN_UI=true XCHAIN_FORWARDER=$RH_FORWARDER XCHAIN_OUT=../.fork/rh-escrow.json \
  forge script script/DeployXChain.s.sol:DeploySource --rpc-url "$RH" --private-key "$DEPLOYER_KEY" --broadcast >"$WORK/rh.log" 2>&1) || { tail -30 "$WORK/rh.log" >&2; exit 1; }
RH_ESCROW=$(jq -r .escrow "$XC_ROOT/.fork/rh-escrow.json")
echo "   NorenCrossChainEscrow on Robinhood fork $RH_ESCROW; setEscrow tx $(send "$ARC" "$SETTLER" 'setEscrow(uint64,address)' 4663 "$RH_ESCROW" --private-key "$DEPLOYER_KEY")"
write_config "$(jq -n --arg e "$RH_ESCROW" --arg s "$SETTLER" '[
  {name: "robinhood", chainSelectorName: "robinhood-testnet", chainId: 4663, escrow: $e, settler: "0x0000000000000000000000000000000000000000", gasLimit: "1500000"},
  {name: "arc", chainSelectorName: "arc-testnet", chainId: 5042002, escrow: "0x0000000000000000000000000000000000000000", settler: $s, gasLimit: "3000000"}]')"

step "1. Robinhood: taker locks 2 NVDA in the escrow (the escrow reads Chainlink NVDA/USD in the same tx)"
NOW=$(cast block latest --field timestamp --rpc-url "$RH")
O1=$(order_tuple 4663 "$RH_ESCROW" $NVDA 2000000000000000000 "$NVDA_STRAT" $((NOW + 1800)) $((NOW + 9000)) 1)
T_NVDA0=$(bal $NVDA "$TAKER" "$RH")
send "$RH" $NVDA 'approve(address,uint256)' "$RH_ESCROW" 2000000000000000000 --private-key "$TAKER_KEY" >/dev/null
OPEN1=$(send "$RH" "$RH_ESCROW" "open($ORDER_SIG)" "$O1" --private-key "$TAKER_KEY")
ID1=$(cast call "$RH_ESCROW" "idOf($ORDER_SIG)(bytes32)" "$O1" --rpc-url "$RH")
echo "   open tx $OPEN1, order $ID1"
echo "   taker NVDA $(fmt "$T_NVDA0" 18) -> $(fmt "$(bal $NVDA "$TAKER" "$RH")" 18), escrow holds $(fmt "$(bal $NVDA "$RH_ESCROW" "$RH")" 18) NVDA"
echo "   Chainlink NVDA/USD on Robinhood: $(cast call $NVDA_FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RH" | sed -n '1p;2p;4p' | awk '{printf "%s ", $1}')(round, answer 8 dp, updatedAt)"

step "2. CRE (trigger 0, log on Robinhood) -> Arc settler: re-read the round, check the order, fill through the maker's Aqua strategy"
M_USDC0=$(bal $ARC_USDC "$MAKER" "$ARC"); T_USDC0=$(bal $ARC_USDC "$TAKER" "$ARC")
simulate 0 "$OPEN1" "$RH"
FILL1=$(written); [ -n "$FILL1" ] || { echo "CRE did not write the fill" >&2; exit 1; }
check_forwarded "$ARC" "$FILL1" $ARC_FORWARDER
[ "$(cast call "$SETTLER" 'orderStatus(bytes32)(uint8)' "$ID1" --rpc-url "$ARC")" = 1 ] || { echo "order not filled on Arc" >&2; cast receipt "$FILL1" --rpc-url "$ARC" >&2; exit 1; }
PAID1=$(( $(bal $ARC_USDC "$TAKER" "$ARC") - T_USDC0 ))
echo "   taker +$(fmt $PAID1 6) USDC on Arc; maker USDC $(fmt "$M_USDC0" 6) -> $(fmt "$(bal $ARC_USDC "$MAKER" "$ARC")" 6); rNVDA supply $(cast call "$RNVDA" 'totalSupply()(uint256)' --rpc-url "$ARC" | first) (burned in the fill)"
echo "   relayed NVDA/USD on Arc: $(cast call "$NVDA_RELAYED" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$ARC" | sed -n '1p;2p' | awk '{printf "%s ", $1}')(round, answer 8 dp)"

step "3. CRE (trigger 1, log on Arc) -> Robinhood escrow: FILLED, release the NVDA to the maker"
simulate 1 "$FILL1" "$ARC"
REL1=$(written); [ -n "$REL1" ] || { echo "CRE did not write the release" >&2; exit 1; }
check_forwarded "$RH" "$REL1" $RH_FORWARDER
[ "$(bal $NVDA "$PAYOUT" "$RH")" = 2000000000000000000 ] || { echo "maker payout did not receive 2 NVDA" >&2; exit 1; }
echo "   maker payout $PAYOUT received $(fmt "$(bal $NVDA "$PAYOUT" "$RH")" 18) NVDA on Robinhood; escrow status $(cast call "$RH_ESCROW" 'orderStatus(bytes32)(uint8)' "$ID1" --rpc-url "$RH") (2 = Released)"

step "4. Replay: the same Robinhood log again. The workflow sees the order Filled on Arc and skips"
simulate 0 "$OPEN1" "$RH"
grep -q "already Filled" "$WORK/sim.log" || { echo "replay was not skipped" >&2; exit 1; }
echo "   (and a forced replay through the forwarder would revert AlreadySettled; see the Foundry tests)"

step "5. Timeout path: a second order is never filled. After its deadline anyone expires it on Arc, CRE unlocks the refund"
NOW=$(cast block latest --field timestamp --rpc-url "$RH")
NOW=$(date +%s); RH_TS=$(cast block latest --field timestamp --rpc-url "$RH"); [ "$RH_TS" -gt "$NOW" ] && NOW=$RH_TS
O2=$(order_tuple 4663 "$RH_ESCROW" $NVDA 1000000000000000000 "$NVDA_STRAT" $((NOW + 40)) $((NOW + 40 + 3600)) 2)
send "$RH" $NVDA 'approve(address,uint256)' "$RH_ESCROW" 1000000000000000000 --private-key "$TAKER_KEY" >/dev/null
OPEN2=$(send "$RH" "$RH_ESCROW" "open($ORDER_SIG)" "$O2" --private-key "$TAKER_KEY")
ID2=$(cast call "$RH_ESCROW" "idOf($ORDER_SIG)(bytes32)" "$O2" --rpc-url "$RH")
echo "   open tx $OPEN2 (1 NVDA, fill deadline in 40 seconds), order $ID2"
echo "   (nobody relays it; waiting 45 s of real time until the deadline has passed on every clock)"
sleep 45; cast rpc evm_mine --rpc-url "$ARC" >/dev/null
simulate 0 "$OPEN2" "$RH"
grep -q "passed its fill deadline" "$WORK/sim.log" || { echo "late order was not skipped" >&2; exit 1; }
EXP2=$(send "$ARC" "$SETTLER" "expire($ORDER_SIG)" "$O2" --private-key "$TAKER_KEY")
echo "   expire tx on Arc $EXP2 (status $(cast call "$SETTLER" 'orderStatus(bytes32)(uint8)' "$ID2" --rpc-url "$ARC"), 2 = Expired)"
simulate 1 "$EXP2" "$ARC"
UNL2=$(written); [ -n "$UNL2" ] || { echo "CRE did not write the expiry" >&2; exit 1; }
check_forwarded "$RH" "$UNL2" $RH_FORWARDER
B=$(bal $NVDA "$TAKER" "$RH")
REF2=$(send "$RH" "$RH_ESCROW" 'refund(bytes32)' "$ID2" --private-key "$TAKER_KEY")
echo "   refund tx $REF2: taker NVDA +$(fmt $(( $(bal $NVDA "$TAKER" "$RH") - B )) 18)"
stop_pid "$RH_PID"
echo "   (Robinhood fork stopped; Arc fork keeps running with the maker's state)"

# ================================================================ phase B: Arc + Base Sepolia
step "Start the Base Sepolia fork and deploy its escrow (WETH + Chainlink ETH/USD on Base Sepolia)"
start_base
align_clock "$BASE"
echo "   Base Sepolia fork $BASE (fork block $BASE_FORK_BLOCK)"
(cd "$XC_ROOT/contracts" && XCHAIN_ARC_SETTLER=$SETTLER XCHAIN_TOKEN=$WETH XCHAIN_FEED=$ETH_FEED XCHAIN_UI=false XCHAIN_FORWARDER=$BASE_FORWARDER XCHAIN_OUT=../.fork/base-escrow.json \
  forge script script/DeployXChain.s.sol:DeploySource --rpc-url "$BASE" --private-key "$DEPLOYER_KEY" --broadcast >"$WORK/base.log" 2>&1) || { tail -30 "$WORK/base.log" >&2; exit 1; }
BASE_ESCROW=$(jq -r .escrow "$XC_ROOT/.fork/base-escrow.json")
echo "   NorenCrossChainEscrow on Base fork $BASE_ESCROW; setEscrow tx $(send "$ARC" "$SETTLER" 'setEscrow(uint64,address)' 84532 "$BASE_ESCROW" --private-key "$DEPLOYER_KEY")"
write_config "$(jq -n --arg e "$BASE_ESCROW" --arg s "$SETTLER" '[
  {name: "arc", chainSelectorName: "arc-testnet", chainId: 5042002, escrow: "0x0000000000000000000000000000000000000000", settler: $s, gasLimit: "3000000"},
  {name: "base", chainSelectorName: "ethereum-testnet-sepolia-base-1", chainId: 84532, escrow: $e, settler: "0x0000000000000000000000000000000000000000", gasLimit: "1500000"}]')"

step "6. Base Sepolia: taker wraps 0.5 ETH and locks 0.5 WETH against the SAME maker's WETH strategy"
WRAP=$(send "$BASE" $WETH 'deposit()' --value 0.5ether --private-key "$TAKER_KEY")
NOW=$(cast block latest --field timestamp --rpc-url "$BASE"); ARC_NOW=$(cast block latest --field timestamp --rpc-url "$ARC")
[ "$ARC_NOW" -gt "$NOW" ] && NOW=$ARC_NOW
O3=$(order_tuple 84532 "$BASE_ESCROW" $WETH 500000000000000000 "$WETH_STRAT" $((NOW + 1800)) $((NOW + 9000)) 3)
send "$BASE" $WETH 'approve(address,uint256)' "$BASE_ESCROW" 500000000000000000 --private-key "$TAKER_KEY" >/dev/null
OPEN3=$(send "$BASE" "$BASE_ESCROW" "open($ORDER_SIG)" "$O3" --private-key "$TAKER_KEY")
ID3=$(cast call "$BASE_ESCROW" "idOf($ORDER_SIG)(bytes32)" "$O3" --rpc-url "$BASE")
echo "   wrap tx $WRAP, open tx $OPEN3, order $ID3; escrow holds $(fmt "$(bal $WETH "$BASE_ESCROW" "$BASE")" 18) WETH"
echo "   Chainlink ETH/USD on Base Sepolia: $(cast call $ETH_FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$BASE" | sed -n '1p;2p' | awk '{printf "%s ", $1}')(round, answer 8 dp)"

step "7. CRE (trigger 1, log on Base) -> Arc settler: fill from the same maker wallet"
M_USDC1=$(bal $ARC_USDC "$MAKER" "$ARC"); T_USDC1=$(bal $ARC_USDC "$TAKER" "$ARC")
simulate 1 "$OPEN3" "$BASE"
FILL3=$(written); [ -n "$FILL3" ] || { echo "CRE did not write the Base fill" >&2; exit 1; }
check_forwarded "$ARC" "$FILL3" $ARC_FORWARDER
[ "$(cast call "$SETTLER" 'orderStatus(bytes32)(uint8)' "$ID3" --rpc-url "$ARC")" = 1 ] || { echo "Base order not filled on Arc" >&2; exit 1; }
PAID3=$(( $(bal $ARC_USDC "$TAKER" "$ARC") - T_USDC1 ))
echo "   taker +$(fmt $PAID3 6) USDC on Arc; maker USDC $(fmt "$M_USDC1" 6) -> $(fmt "$(bal $ARC_USDC "$MAKER" "$ARC")" 6)"

step "8. CRE (trigger 0, log on Arc) -> Base escrow: FILLED, release the WETH to the maker"
simulate 0 "$FILL3" "$ARC"
REL3=$(written); [ -n "$REL3" ] || { echo "CRE did not write the Base release" >&2; exit 1; }
check_forwarded "$BASE" "$REL3" $BASE_FORWARDER
[ "$(bal $WETH "$PAYOUT" "$BASE")" = 500000000000000000 ] || { echo "maker payout did not receive 0.5 WETH" >&2; exit 1; }
echo "   maker payout $PAYOUT received $(fmt "$(bal $WETH "$PAYOUT" "$BASE")" 18) WETH on Base Sepolia"

step "Result: one Arc maker, orders from two chains"
echo "   maker wallet on Arc: 20,000 USDC -> $(fmt "$(bal $ARC_USDC "$MAKER" "$ARC")" 6) USDC (paid $(fmt $((PAID1 + PAID3)) 6) to takers)"
echo "   maker received: 2 NVDA on Robinhood Chain + 0.5 WETH on Base Sepolia, released by the escrows after CRE reported each fill"
echo "   NVDA strategy fills $(cast call "$SETTLER" 'strategy(bytes32)((address,bytes32,address,bool,uint32,uint256,uint256,bytes))' "$NVDA_STRAT" --rpc-url "$ARC" | tr -d '()' | tr ',' '\n' | sed -n 5p | tr -d ' '), WETH strategy fills $(cast call "$SETTLER" 'strategy(bytes32)((address,bytes32,address,bool,uint32,uint256,uint256,bytes))' "$WETH_STRAT" --rpc-url "$ARC" | tr -d '()' | tr ',' '\n' | sed -n 5p | tr -d ' ')"
jq -n --arg arc "$ARC_FORK_BLOCK" --arg rh "$RH_SNAPSHOT_BLOCK" --arg base "$BASE_FORK_BLOCK" --arg settler "$SETTLER" --arg router "$ROUTER" \
  --arg rhEscrow "$RH_ESCROW" --arg baseEscrow "$BASE_ESCROW" --arg o1 "$OPEN1" --arg f1 "$FILL1" --arg r1 "$REL1" --arg o2 "$OPEN2" --arg e2 "$EXP2" --arg u2 "$UNL2" --arg rf2 "$REF2" \
  --arg o3 "$OPEN3" --arg f3 "$FILL3" --arg r3 "$REL3" --arg p1 "$PAID1" --arg p3 "$PAID3" \
  '{note: "LOCAL FORKS ONLY (Arc Testnet fork, Robinhood mainnet snapshot, Base Sepolia fork). Hashes do not exist on any public chain.",
    forkBlocks: {arc: $arc, robinhoodSnapshot: $rh, baseSepolia: $base}, settler: $settler, router: $router, robinhoodEscrow: $rhEscrow, baseEscrow: $baseEscrow,
    nvda: {open: $o1, arcFill: $f1, robinhoodRelease: $r1, usdcPaid6: $p1}, expiry: {open: $o2, arcExpire: $e2, robinhoodUnlock: $u2, refund: $rf2},
    weth: {open: $o3, arcFill: $f3, baseRelease: $r3, usdcPaid6: $p3}}' >"$XC_ROOT/.fork/xchain-demo.json"
echo
echo "== PASS. Forks stop now. Tx hashes: packages/xchain-aqua/.fork/xchain-demo.json"
} 2>&1 | tee "$XC_ROOT/.fork/xchain-demo.txt"
grep -q '^== PASS' "$XC_ROOT/.fork/xchain-demo.txt" || { echo "demo FAILED (see the transcript above)" >&2; exit 1; }
