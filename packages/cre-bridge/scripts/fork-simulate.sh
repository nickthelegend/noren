#!/bin/sh
# End-to-end CRE simulation of the Noren credit bridge on two local Anvil forks.
#
#   Arc        127.0.0.1:8730  fork of Arc Testnet (chain 5042002), real arc-testnet MockKeystoneForwarder
#   Robinhood  127.0.0.1:8731  fork of Robinhood Chain MAINNET (chain 4663): real Stock Tokens and
#                              Chainlink feeds. CRE addresses it through its "robinhood-testnet"
#                              selector; the simulator does not compare the RPC's chain id with the
#                              selector (checked with both 4663 and 46630; NOREN_RH_CHAIN_ID=46630
#                              serves the fork under the testnet id instead). The robinhood-testnet
#                              MockKeystoneForwarder does not exist on mainnet, so its real bytecode
#                              and two storage slots are copied in from Robinhood Testnet.
#
# Flow (every cross-chain write is a CRE report -> MockKeystoneForwarder -> onReport):
#   1. Robinhood: underwriter EIP-712 attestation; borrower locks 10 NVDA in NorenCredit and opens a
#      line sized by the live Chainlink NVDA/USD price -> CreditLineOpened
#   2. cre simulate handler 0 (dry run, then --broadcast) -> NorenCreditLine.onReport on Arc
#   3. Arc: borrower pays a merchant invoice from the line -> Drawn; handler 2 -> NorenCredit.onReport
#   4. Arc: borrower repays part -> Repaid; handler 2 -> NorenCredit.onReport
#   5. Robinhood: borrower closes -> CreditLineClosed; handler 1 -> Arc line frozen, draws revert
#   6. Arc: borrower repays the rest -> Repaid; handler 2 -> NorenCredit settles, NVDA returned
#   7. Replays are skipped; direct onReport calls from a non-forwarder revert on both chains
#
# Robinhood receiver: the real NorenCredit from packages/robinhood (git archive of CREDIT_REF into a temp dir,
# deployed with its own script/Deploy.s.sol). NOREN_BRIDGE_RECEIVER=harness uses the labelled
# NorenCreditHarness instead. Arc USDC: the repo's fork-only ForkUSDC shim replaces Arc's native
# USDC, which stock Anvil cannot execute (same as scripts/dev-stack.ts).
#
# Uses Anvil's published dev accounts (public "test ... junk" mnemonic) on the local forks only.
# Nothing is sent to a public chain. NOREN_CRE_CAPTURE=1 writes fixtures/fork-run.json.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CREDIT_PKG="$ROOT/../arc-credit"
USDC_SHIM_SRC="$ROOT/../contracts/src/ForkUSDC.sol"
RECEIVER_MODE=${NOREN_BRIDGE_RECEIVER:-credit}
CREDIT_REF=${NOREN_CREDIT_REF:-HEAD}   # the commit whose packages/robinhood holds NorenCredit (default: this checkout)
ARC_PORT=8730
RH_PORT=8731
RH_CHAIN_ID=${NOREN_RH_CHAIN_ID:-4663}
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
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951   # real NVDA holder on mainnet, impersonated on the fork
COLLATERAL=10000000000000000000                              # 10 NVDA (18 decimals)

for c in anvil cast forge cre bun jq git; do command -v "$c" >/dev/null || { echo "Setup required: $c" >&2; exit 1; }; done
case "$RECEIVER_MODE" in credit|harness) ;; *) echo "NOREN_BRIDGE_RECEIVER must be credit or harness" >&2; exit 1 ;; esac
case "$RH_CHAIN_ID" in 4663|46630) ;; *) echo "NOREN_RH_CHAIN_ID must be 4663 or 46630" >&2; exit 1 ;; esac
if [ "$RECEIVER_MODE" = credit ] && [ "$RH_CHAIN_ID" != 4663 ]; then
  echo "NorenCredit's Deploy.s.sol requires chain id 4663; use NOREN_BRIDGE_RECEIVER=harness with 46630" >&2; exit 1
fi
for p in $ARC_PORT $RH_PORT; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $p is busy" >&2; exit 1; fi
done
[ -d "$ROOT/credit-bridge/node_modules/@chainlink/cre-sdk" ] || { echo "Setup required: cd packages/cre-bridge/credit-bridge && bun install" >&2; exit 1; }
[ -d "$CREDIT_PKG/node_modules/@openzeppelin/contracts" ] || { echo "Setup required: pnpm install (packages/arc-credit dependencies)" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/noren-cre-bridge.XXXXXX")
ARC_PID=""; RH_PID=""
cleanup() {
  [ -n "$ARC_PID" ] && kill "$ARC_PID" 2>/dev/null || true
  [ -n "$RH_PID" ] && kill "$RH_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- NorenCredit source (real contract)
# The Robinhood credit contract is taken from CREDIT_REF (default HEAD: this checkout's packages/robinhood).
# Its package and contract names are detected from that commit.
if [ "$RECEIVER_MODE" = credit ]; then
  case "$CREDIT_REF" in origin/*) git -C "$ROOT" fetch -q origin "${CREDIT_REF#origin/}" 2>/dev/null || true ;; esac
  CREDIT_COMMIT=$(git -C "$ROOT" rev-parse --verify -q "$CREDIT_REF^{commit}") || {
    echo "Setup required: $CREDIT_REF (the commit holding NorenCredit) is not available; run with NOREN_BRIDGE_RECEIVER=harness" >&2; exit 1; }
  REPO_TOP=$(git -C "$ROOT" rev-parse --show-toplevel)
  DEPLOY_PATH=$(git -C "$REPO_TOP" ls-tree -r --name-only "$CREDIT_COMMIT" packages | grep -E '^packages/[^/]+/contracts/script/Deploy\.s\.sol$' \
    | awk '/^packages\/robinhood\// {print; found=1; exit} {first = first ? first : $0} END {if (!found && first) print first}')
  [ -n "$DEPLOY_PATH" ] || { echo "no packages/*/contracts/script/Deploy.s.sol on $CREDIT_REF" >&2; exit 1; }
  CREDIT_PKG_REL=${DEPLOY_PATH%/contracts/script/Deploy.s.sol}
  mkdir -p "$WORK/robinhood"
  git -C "$REPO_TOP" archive "$CREDIT_COMMIT" "$CREDIT_PKG_REL/contracts" | tar -x -C "$WORK/robinhood"
  RH_SRC_DIR="$WORK/robinhood/$CREDIT_PKG_REL/contracts"
  CREDIT_SOL=$(grep -l 'function openCreditLine' "$RH_SRC_DIR"/src/*.sol | head -1)
  [ -n "$CREDIT_SOL" ] || { echo "no contract with openCreditLine on $CREDIT_REF" >&2; exit 1; }
  RH_CONTRACT=$(sed -nE 's/^contract ([A-Za-z0-9_]+) .*/\1/p' "$CREDIT_SOL" | head -1)
  ENV_PREFIX=$(sed -nE "s/.*vm\.envAddress\('([A-Z0-9_]+)_OWNER'\).*/\1/p" "$RH_SRC_DIR/script/Deploy.s.sol" | head -1)
  [ -n "$RH_CONTRACT" ] && [ -n "$ENV_PREFIX" ] || { echo "could not read the contract name or deploy env prefix on $CREDIT_REF" >&2; exit 1; }
  # The contract pins @openzeppelin/contracts 5.1.0, the same version packages/arc-credit installs.
  # Copied, not symlinked: solc refuses imports that resolve outside the project's allowed paths.
  mkdir -p "$WORK/robinhood/$CREDIT_PKG_REL/node_modules/@openzeppelin"
  cp -RL "$CREDIT_PKG/node_modules/@openzeppelin/contracts" "$WORK/robinhood/$CREDIT_PKG_REL/node_modules/@openzeppelin/contracts"
  echo "== Robinhood credit contract: $RH_CONTRACT from $CREDIT_PKG_REL on $CREDIT_REF at $(git -C "$ROOT" rev-parse --short "$CREDIT_COMMIT")"
fi

anvil --silent --host 127.0.0.1 --port $ARC_PORT --fork-url $ARC_UPSTREAM --chain-id 5042002 >"$WORK/arc.log" 2>&1 &
ARC_PID=$!
anvil --silent --host 127.0.0.1 --port $RH_PORT --fork-url $RH_UPSTREAM --chain-id "$RH_CHAIN_ID" >"$WORK/rh.log" 2>&1 &
RH_PID=$!

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
[ "$(cast chain-id --rpc-url "$RH")" = "$RH_CHAIN_ID" ] || { echo "Robinhood fork has the wrong chain id" >&2; exit 1; }
ARC_FORK_BLOCK=$(cast block-number --rpc-url "$ARC")
RH_FORK_BLOCK=$(cast block-number --rpc-url "$RH")
echo "== Arc Testnet fork $ARC (fork block $ARC_FORK_BLOCK)"
echo "== Robinhood Chain mainnet fork $RH (fork block $RH_FORK_BLOCK of chain 4663, served as chain id $RH_CHAIN_ID)"

# ---------------------------------------------------------------- forwarders
[ "$(cast code $ARC_FORWARDER --rpc-url "$ARC")" != 0x ] || { echo "Arc MockKeystoneForwarder missing on the fork" >&2; exit 1; }
[ "$(cast code $RH_FORWARDER --rpc-url "$RH")" = 0x ] || { echo "unexpected code at $RH_FORWARDER on Robinhood mainnet" >&2; exit 1; }
RH_FWD_CODE=$(cast code $RH_FORWARDER --rpc-url $RH_TESTNET)
[ "$RH_FWD_CODE" != 0x ] || { echo "robinhood-testnet MockKeystoneForwarder not found on Robinhood Testnet" >&2; exit 1; }
SELF_SLOT=$(cast index address $RH_FORWARDER 2)   # s_forwarders[address(this)]: the mock routes reports to itself
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
UNDERWRITER_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 9)
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
BORROWER=$(cast wallet address --private-key "$BORROWER_KEY")
UNDERWRITER=$(cast wallet address --private-key "$UNDERWRITER_KEY")
MERCHANT=$(cast wallet address --mnemonic "$MN" --mnemonic-index 2)
printf 'CRE_ETH_PRIVATE_KEY=%s\n' "$DEPLOYER_KEY" >"$WORK/fork.env"
chmod 600 "$WORK/fork.env"
send_arc() { cast send --rpc-url "$ARC" --json "$@" | jq -r .transactionHash; }
send_rh() { cast send --rpc-url "$RH" --json "$@" | jq -r .transactionHash; }
first() { awk 'NR==1 {print $1}'; }

# ---------------------------------------------------------------- Arc: USDC shim + NorenCreditLine
mkdir -p "$WORK/shim/src"
cp "$USDC_SHIM_SRC" "$WORK/shim/src/ForkUSDC.sol"
printf "[profile.default]\nsrc = 'src'\nout = 'out'\nsolc_version = '0.8.28'\noptimizer = true\nbytecode_hash = 'none'\ncbor_metadata = false\n" >"$WORK/shim/foundry.toml"
SHIM_CODE=$(forge inspect --root "$WORK/shim" src/ForkUSDC.sol:ForkUSDC deployedBytecode)
cast rpc anvil_setCode $ARC_USDC "$SHIM_CODE" --rpc-url "$ARC" >/dev/null
send_arc $ARC_USDC 'mint(address,uint256)' "$DEPLOYER" 10000000000 --private-key "$DEPLOYER_KEY" >/dev/null
send_arc $ARC_USDC 'mint(address,uint256)' "$BORROWER" 200000000 --private-key "$DEPLOYER_KEY" >/dev/null
echo "== Arc USDC at $ARC_USDC replaced by the fork-only ForkUSDC shim; minted 10,000 to the pool funder, 200 to the borrower"

(cd "$CREDIT_PKG" && forge build >/dev/null)
CREDIT=$(cd "$CREDIT_PKG" && forge create src/NorenCreditLine.sol:NorenCreditLine --rpc-url "$ARC" --private-key "$DEPLOYER_KEY" --broadcast --json \
  --constructor-args $ARC_USDC $ARC_FORWARDER "$DEPLOYER" | jq -r .deployedTo)
send_arc $ARC_USDC 'approve(address,uint256)' "$CREDIT" 10000000000 --private-key "$DEPLOYER_KEY" >/dev/null
send_arc "$CREDIT" 'fund(uint256)' 10000000000 --private-key "$DEPLOYER_KEY" >/dev/null
echo "== NorenCreditLine on Arc fork at $CREDIT (forwarder $(cast call "$CREDIT" 'forwarder()(address)' --rpc-url "$ARC")), pool $(cast call $ARC_USDC 'balanceOf(address)(uint256)' "$CREDIT" --rpc-url "$ARC" | first) USDC6"

# ---------------------------------------------------------------- Robinhood: receiver + opened line
NOW=$(cast block latest --field timestamp --rpc-url "$RH")
EXPIRY=$((NOW + 30 * 86400))
NVDA_PRICE=$(cast call $NVDA_FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RH" | sed -n 2p | first)
if [ "$RECEIVER_MODE" = credit ]; then
  RECEIVER_NAME=NorenCredit
  for a in "$DEPLOYER" "$BORROWER" "$UNDERWRITER" "$POOL_MANAGER"; do cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RH" >/dev/null; done
  OUT=$(cd "$RH_SRC_DIR" && env "${ENV_PREFIX}_OWNER=$DEPLOYER" "${ENV_PREFIX}_UNDERWRITER=$UNDERWRITER" "${ENV_PREFIX}_FORWARDER=$RH_FORWARDER" \
    forge script script/Deploy.s.sol:Deploy --rpc-url "$RH" --broadcast --private-key "$DEPLOYER_KEY" 2>&1) || { echo "$OUT" | tail -30 >&2; exit 1; }
  RH_CREDIT=$(echo "$OUT" | sed -nE "s/.*${ENV_PREFIX}_CREDIT[[:space:]]+(0x[0-9a-fA-F]{40}).*/\1/p" | tail -1)
  ORACLE=$(echo "$OUT" | sed -nE "s/.*${ENV_PREFIX}_ORACLE[[:space:]]+(0x[0-9a-fA-F]{40}).*/\1/p" | tail -1)
  [ -n "$RH_CREDIT" ] && [ -n "$ORACLE" ] || { echo "$OUT" | tail -30 >&2; echo "$RH_CONTRACT deploy printed no address" >&2; exit 1; }
  echo "== $RH_CONTRACT (real contract, $CREDIT_REF) on Robinhood fork at $RH_CREDIT, forwarder $(cast call "$RH_CREDIT" 'forwarder()(address)' --rpc-url "$RH")"

  # Borrower gets 10 NVDA from a real holder (impersonated on the fork only).
  cast rpc anvil_impersonateAccount $POOL_MANAGER --rpc-url "$RH" >/dev/null
  cast send $NVDA 'transfer(address,uint256)' "$BORROWER" $COLLATERAL --unlocked --from $POOL_MANAGER --rpc-url "$RH" >/dev/null
  cast rpc anvil_stopImpersonatingAccount $POOL_MANAGER --rpc-url "$RH" >/dev/null

  # Underwriter EIP-712 attestation (tier 2, 5,000 USDG, 120% collateral), digest from the contract itself.
  ATT="($BORROWER,2,5000000000,12000,0,$EXPIRY)"
  DIGEST=$(cast call "$RH_CREDIT" 'hashAttestation((address,uint8,uint256,uint16,uint256,uint64))(bytes32)' "$ATT" --rpc-url "$RH")
  SIG=$(cast wallet sign --no-hash --private-key "$UNDERWRITER_KEY" "$DIGEST")
  ATT_TX=$(send_rh "$RH_CREDIT" 'applyAttestation((address,uint8,uint256,uint16,uint256,uint64),bytes)' "$ATT" "$SIG" --private-key "$BORROWER_KEY")
  TERMS=$(cast call "$RH_CREDIT" 'creditTerms(address)(uint8,uint256,uint16,uint256)' "$BORROWER" --rpc-url "$RH" | awk '{print $1}' | tr '\n' ' ')
  RATIO=$(echo "$TERMS" | awk '{print $3}')
  RISK_USD8=$(cast call "$ORACLE" 'riskValueUsd8(address,uint256)(uint256)' $NVDA $COLLATERAL --rpc-url "$RH" | first)
  LIMIT_USDC6=$((RISK_USD8 * 10000 / RATIO / 100))
  echo "   attestation tx $ATT_TX; creditTerms (tier, limitUsdg, ratioBps, available): $TERMS"
  echo "   10 NVDA: Chainlink NVDA/USD $NVDA_PRICE (8 dp), oracle risk value $RISK_USD8 usd8 -> max line at ${RATIO} bps = $LIMIT_USDC6 USDC6"
  send_rh $NVDA 'approve(address,uint256)' "$RH_CREDIT" $COLLATERAL --private-key "$BORROWER_KEY" >/dev/null
  OPEN_TX=$(send_rh "$RH_CREDIT" 'openCreditLine(address,uint256,uint256,uint64)' $NVDA $COLLATERAL $LIMIT_USDC6 $EXPIRY --private-key "$BORROWER_KEY")
else
  RECEIVER_NAME=NorenCreditHarness
  RH_CREDIT=$(cd "$CREDIT_PKG" && forge create src/harness/NorenCreditHarness.sol:NorenCreditHarness --rpc-url "$RH" --private-key "$DEPLOYER_KEY" --broadcast --json \
    --constructor-args $RH_FORWARDER | jq -r .deployedTo)
  echo "== NorenCreditHarness (TEST HARNESS standing in for NorenCredit) on Robinhood fork at $RH_CREDIT"
  COLLATERAL_USD8=$((NVDA_PRICE * 10))
  LIMIT_USDC6=$((COLLATERAL_USD8 / 100 / 2))
  OPEN_TX=$(send_rh "$RH_CREDIT" 'emitOpened(bytes32,uint256,uint64,uint256)' "$(cast keccak "noren-fork-line-$NOW")" $LIMIT_USDC6 $EXPIRY $COLLATERAL_USD8 --private-key "$BORROWER_KEY")
fi
OPEN_RCPT=$(cast receipt "$OPEN_TX" --json --rpc-url "$RH")
OPENED_TOPIC=$(cast keccak 'CreditLineOpened(address,bytes32,uint256,uint64,uint256)')
OPEN_IDX=$(echo "$OPEN_RCPT" | jq --arg t "$OPENED_TOPIC" '[.logs[] | select(.topics[0] == $t)][0].logIndex' | xargs printf '%d')
OPEN_IDX_IN_TX=$(echo "$OPEN_RCPT" | jq --arg t "$OPENED_TOPIC" '[.logs | to_entries[] | select(.value.topics[0] == $t)][0].key')
LINE=$(echo "$OPEN_RCPT" | jq -r --arg t "$OPENED_TOPIC" '[.logs[] | select(.topics[0] == $t)][0].topics[2]')
echo "== 1. Robinhood fork: CreditLineOpened tx $OPEN_TX (log $OPEN_IDX), line $LINE, limit $LIMIT_USDC6 USDC6, expiry $EXPIRY"

jq --arg rh "$RH_CREDIT" --arg arc "$CREDIT" --arg recv "$RECEIVER_NAME" '.robinhood.address = $rh | .robinhood.receiver = $recv | .arc.address = $arc' \
  "$ROOT/credit-bridge/config.staging.json" >"$ROOT/credit-bridge/config.local-fork.json"

simulate() {
  idx=$1; shift
  (cd "$ROOT" && cre workflow simulate credit-bridge --target local-fork --non-interactive --trigger-index "$idx" -e "$WORK/fork.env" "$@") >"$WORK/sim.log" 2>&1 || {
    cat "$WORK/sim.log" >&2; echo "cre workflow simulate failed" >&2; exit 1; }
  grep -E '\[USER LOG\]|Workflow Simulation Result' "$WORK/sim.log" | sed 's/^/   | /' || true
  grep -A1 'Workflow Simulation Result' "$WORK/sim.log" | tail -1 | sed 's/^/   | /' || true
}
written_tx() { grep -o "updated on [a-z-]*: tx 0x[0-9a-f]*" "$WORK/sim.log" | grep -o '0x[0-9a-f]*$' | tail -1; }
check_forwarded() {
  rpc=$1; tx=$2; fwd=$3
  to=$(cast tx "$tx" to --rpc-url "$rpc")
  [ "$(echo "$to" | tr 'A-F' 'a-f')" = "$(echo "$fwd" | tr 'A-F' 'a-f')" ] || { echo "write $tx did not go through the forwarder" >&2; exit 1; }
  echo "   forwarder tx $tx: status $(cast receipt "$tx" status --rpc-url "$rpc"), to $to, block $(cast receipt "$tx" blockNumber --rpc-url "$rpc"), gas $(cast receipt "$tx" gasUsed --rpc-url "$rpc")"
}
arc_log_index() { cast receipt "$1" --json --rpc-url "$ARC" | jq --arg a "$(echo "$CREDIT" | tr 'A-F' 'a-f')" '[.logs | to_entries[] | select((.value.address | ascii_downcase) == $a)][0].key'; }
rh_state() {
  if [ "$RECEIVER_MODE" = credit ]; then
    cast call "$RH_CREDIT" 'line(bytes32)((address,address,uint64,uint64,uint64,uint8,uint256,uint256,uint256,uint256))' "$LINE" --rpc-url "$RH"
  else
    cast call "$RH_CREDIT" 'utilisation(bytes32)(uint256,uint256,uint64)' "$LINE" --rpc-url "$RH" | tr '\n' ' '
  fi
}
rh_drawn_repaid() {
  if [ "$RECEIVER_MODE" = credit ]; then
    cast call "$RH_CREDIT" 'line(bytes32)((address,address,uint64,uint64,uint64,uint8,uint256,uint256,uint256,uint256))' "$LINE" --rpc-url "$RH" \
      | tr -d '()' | tr ',' '\n' | sed -n '9p;10p' | first_cols
  else
    cast call "$RH_CREDIT" 'utilisation(bytes32)(uint256,uint256,uint64)' "$LINE" --rpc-url "$RH" | sed -n '1p;2p' | first_cols
  fi
}
first_cols() { awk '{print $1}' | tr '\n' ' ' | sed 's/ $//'; }
# NorenCredit settles only on an Arc report dated at or after the close. The two forks keep their own
# clocks, so if Arc's clock is not after Robinhood's close, step Arc's next block just past it.
align_arc_clock() {
  close_ts=$(cast block "$(cast receipt "$1" blockNumber --rpc-url "$RH")" --field timestamp --rpc-url "$RH")
  arc_ts=$(cast block latest --field timestamp --rpc-url "$ARC")
  if [ "$arc_ts" -le "$close_ts" ]; then
    cast rpc evm_setNextBlockTimestamp $((close_ts + 1)) --rpc-url "$ARC" >/dev/null
    echo "   (fork clock alignment: Arc clock $arc_ts is not after the Robinhood close at $close_ts; next Arc block set to $((close_ts + 1)))"
  fi
}
rh_status() { cast call "$RH_CREDIT" 'line(bytes32)((address,address,uint64,uint64,uint64,uint8,uint256,uint256,uint256,uint256))' "$1" --rpc-url "$RH" | tr -d '()' | tr ',' '\n' | sed -n 6p | tr -d ' '; }

# --evm-event-index is the log's position inside the transaction. Anvil mines one tx per block here, so it also equals the block log index.
echo "== 2a. cre workflow simulate handler 0, no --broadcast (dry run: nothing is sent)"
simulate 0 --evm-tx-hash "$OPEN_TX" --evm-event-index "$OPEN_IDX_IN_TX"
[ "$(cast call "$CREDIT" 'available(bytes32)(uint256)' "$LINE" --rpc-url "$ARC")" = 0 ] || { echo "dry run changed Arc" >&2; exit 1; }
echo "   Arc line still empty after the dry run"
echo "== 2b. cre workflow simulate handler 0 --broadcast: Robinhood CreditLineOpened -> Arc NorenCreditLine.onReport"
simulate 0 --evm-tx-hash "$OPEN_TX" --evm-event-index "$OPEN_IDX_IN_TX" --broadcast
ARC_OPEN_TX=$(written_tx); [ -n "$ARC_OPEN_TX" ] || { echo "handler 0 did not write" >&2; exit 1; }
check_forwarded "$ARC" "$ARC_OPEN_TX" $ARC_FORWARDER
AVAILABLE=$(cast call "$CREDIT" 'available(bytes32)(uint256)' "$LINE" --rpc-url "$ARC" | first)
[ "$AVAILABLE" = "$LIMIT_USDC6" ] || { echo "Arc available $AVAILABLE != limit $LIMIT_USDC6" >&2; exit 1; }
echo "   Arc line available: $AVAILABLE USDC6"
echo "== 2c. same event again: the workflow sees the line already synced and skips"
simulate 0 --evm-tx-hash "$OPEN_TX" --evm-event-index "$OPEN_IDX_IN_TX" --broadcast

# ---------------------------------------------------------------- 3. draw on Arc
INVOICE=$(cast keccak "noren-fork-invoice-1-$NOW")
DRAW_TX=$(send_arc "$CREDIT" 'payInvoice(bytes32,address,uint256,bytes32)' "$LINE" "$MERCHANT" 120000000 "$INVOICE" --private-key "$BORROWER_KEY")
echo "== 3. Arc fork: payInvoice 120 USDC to merchant $MERCHANT, Drawn tx $DRAW_TX (merchant now holds $(cast call $ARC_USDC 'balanceOf(address)(uint256)' "$MERCHANT" --rpc-url "$ARC" | first) USDC6)"
DRAW_IDX=$(arc_log_index "$DRAW_TX")
simulate 2 --evm-tx-hash "$DRAW_TX" --evm-event-index "$DRAW_IDX" --broadcast
RH_DRAW_TX=$(written_tx); [ -n "$RH_DRAW_TX" ] || { echo "handler 2 did not write (Drawn)" >&2; exit 1; }
check_forwarded "$RH" "$RH_DRAW_TX" $RH_FORWARDER
echo "   Robinhood $RECEIVER_NAME line: $(rh_state)"

# ---------------------------------------------------------------- 4. partial repay on Arc
send_arc $ARC_USDC 'approve(address,uint256)' "$CREDIT" 120000000 --private-key "$BORROWER_KEY" >/dev/null
REPAY_TX=$(send_arc "$CREDIT" 'repay(bytes32,uint256)' "$LINE" 50000000 --private-key "$BORROWER_KEY")
echo "== 4. Arc fork: repay 50 USDC, Repaid tx $REPAY_TX; handler 2 --broadcast"
simulate 2 --evm-tx-hash "$REPAY_TX" --evm-event-index "$(arc_log_index "$REPAY_TX")" --broadcast
RH_REPAY_TX=$(written_tx); [ -n "$RH_REPAY_TX" ] || { echo "handler 2 did not write (Repaid)" >&2; exit 1; }
check_forwarded "$RH" "$RH_REPAY_TX" $RH_FORWARDER
[ "$(rh_drawn_repaid)" = "120000000 50000000" ] || { echo "Robinhood drawn/repaid is $(rh_drawn_repaid), expected 120000000 50000000" >&2; exit 1; }
echo "   Robinhood $RECEIVER_NAME line: $(rh_state)"
echo "== 4b. replay the Drawn event: Robinhood already has a newer asOf, the workflow skips"
simulate 2 --evm-tx-hash "$DRAW_TX" --evm-event-index "$DRAW_IDX" --broadcast

# ---------------------------------------------------------------- 5. close on Robinhood
if [ "$RECEIVER_MODE" = credit ]; then
  CLOSE_TX=$(send_rh "$RH_CREDIT" 'closeCreditLine(bytes32)' "$LINE" --private-key "$BORROWER_KEY")
else
  CLOSE_TX=$(send_rh "$RH_CREDIT" 'emitClosed(bytes32)' "$LINE" --private-key "$BORROWER_KEY")
fi
CLOSED_TOPIC=$(cast keccak 'CreditLineClosed(bytes32)')
CLOSE_IDX=$(cast receipt "$CLOSE_TX" --json --rpc-url "$RH" | jq --arg t "$CLOSED_TOPIC" '[.logs | to_entries[] | select(.value.topics[0] == $t)][0].key')
echo "== 5. Robinhood fork: close requested, CreditLineClosed tx $CLOSE_TX; handler 1 --broadcast"
align_arc_clock "$CLOSE_TX"
simulate 1 --evm-tx-hash "$CLOSE_TX" --evm-event-index "$CLOSE_IDX" --broadcast
ARC_CLOSE_TX=$(written_tx); [ -n "$ARC_CLOSE_TX" ] || { echo "handler 1 did not write" >&2; exit 1; }
check_forwarded "$ARC" "$ARC_CLOSE_TX" $ARC_FORWARDER
echo "   Arc line (borrower, expiry, asOf, closed, limit, drawn, repaid, unsecured): $(cast call "$CREDIT" 'lines(bytes32)((address,uint64,uint64,bool,uint256,uint256,uint256,bool))' "$LINE" --rpc-url "$ARC")"
if cast send "$CREDIT" 'payInvoice(bytes32,address,uint256,bytes32)' "$LINE" "$MERCHANT" 1000000 "$(cast keccak inv-after-close)" --rpc-url "$ARC" --private-key "$BORROWER_KEY" >"$WORK/after.log" 2>&1; then
  echo "draw after close unexpectedly succeeded" >&2; exit 1
fi
echo "   payInvoice after close reverted: $(grep -o -m1 'LineClosed' "$WORK/after.log" || grep -i -m1 revert "$WORK/after.log" | cut -c 1-160)"
echo "== 5b. handler 2 on the freeze (CreditLineFrozen): fresh utilisation back to Robinhood (70 still owed, so no settlement yet)"
simulate 2 --evm-tx-hash "$ARC_CLOSE_TX" --evm-event-index "$(arc_log_index "$ARC_CLOSE_TX")" --broadcast
RH_FREEZE_TX=$(written_tx); [ -n "$RH_FREEZE_TX" ] || { echo "handler 2 did not write (CreditLineFrozen)" >&2; exit 1; }
check_forwarded "$RH" "$RH_FREEZE_TX" $RH_FORWARDER
echo "   Robinhood $RECEIVER_NAME line: $(rh_state)"
echo "== 5c. replay the opened event after close: the workflow sees the frozen line and skips"
simulate 0 --evm-tx-hash "$OPEN_TX" --evm-event-index "$OPEN_IDX_IN_TX" --broadcast

# ---------------------------------------------------------------- 6. final repay on Arc -> settle on Robinhood
align_arc_clock "$CLOSE_TX"
FINAL_TX=$(send_arc "$CREDIT" 'repay(bytes32,uint256)' "$LINE" 70000000 --private-key "$BORROWER_KEY")
echo "== 6. Arc fork: repay the remaining 70 USDC, Repaid tx $FINAL_TX; handler 2 --broadcast"
simulate 2 --evm-tx-hash "$FINAL_TX" --evm-event-index "$(arc_log_index "$FINAL_TX")" --broadcast
RH_FINAL_TX=$(written_tx); [ -n "$RH_FINAL_TX" ] || { echo "handler 2 did not write (final Repaid)" >&2; exit 1; }
check_forwarded "$RH" "$RH_FINAL_TX" $RH_FORWARDER
echo "   Robinhood $RECEIVER_NAME line: $(rh_state)"
if [ "$RECEIVER_MODE" = credit ]; then
  STATUS=$(cast call "$RH_CREDIT" 'line(bytes32)((address,address,uint64,uint64,uint64,uint8,uint256,uint256,uint256,uint256))' "$LINE" --rpc-url "$RH" | tr -d '()' | tr ',' '\n' | sed -n 6p | tr -d ' ')
  NVDA_BACK=$(cast call $NVDA 'balanceOf(address)(uint256)' "$BORROWER" --rpc-url "$RH" | first)
  [ "$STATUS" = 3 ] || { echo "NorenCredit line status $STATUS, expected 3 (Closed)" >&2; exit 1; }
  [ "$NVDA_BACK" = $COLLATERAL ] || { echo "borrower NVDA $NVDA_BACK, expected $COLLATERAL back" >&2; exit 1; }
  echo "   NorenCredit settled the line (status 3 = Closed); borrower NVDA balance back to $NVDA_BACK"
fi

# ---------------------------------------------------------------- 7. forwarder-only receivers
REPORT_ARC=$(cast abi-encode 'f(address,bytes32,uint256,uint64)' "$BORROWER" "$(cast keccak x)" 1 $EXPIRY)
REPORT_RH=$(cast abi-encode 'f(bytes32,uint256,uint256,uint64)' "$LINE" 0 0 $((NOW + 100)))
if cast send "$CREDIT" 'onReport(bytes,bytes)' 0x "$REPORT_ARC" --rpc-url "$ARC" --private-key "$BORROWER_KEY" >/dev/null 2>&1; then echo "direct Arc onReport succeeded" >&2; exit 1; fi
if cast send "$RH_CREDIT" 'onReport(bytes,bytes)' 0x "$REPORT_RH" --rpc-url "$RH" --private-key "$BORROWER_KEY" >/dev/null 2>&1; then echo "direct Robinhood onReport succeeded" >&2; exit 1; fi
echo "== 7. direct onReport from a non-forwarder reverted on both forks"

# ---------------------------------------------------------------- 8. World ID starter limit (HTTP trigger, handler 3)
HUMAN_KEY=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index 3)
HUMAN=$(cast wallet address --private-key "$HUMAN_KEY")
NULLIFIER=$(cast keccak "fork-world-id-nullifier-$NOW")
ARC_NOW=$(cast block latest --field timestamp --rpc-url "$ARC")
STARTER_EXPIRY=$((ARC_NOW + 30 * 86400))
STARTER_LINE=$(cast call "$CREDIT" 'starterLineId(address)(bytes32)' "$HUMAN" --rpc-url "$ARC")
# Same JSON shape as packages/world-id httpTriggerPayload (lineId is optional and must match starterLineId).
PAYLOAD=$(jq -cn --arg b "$HUMAN" --arg n "$NULLIFIER" --arg l "$STARTER_LINE" --argjson e "$STARTER_EXPIRY" \
  '{kind: "noren.human-starter.v1", borrower: $b, nullifierHash: $n, lineId: $l, limitUsdc6: "25000000", expiry: $e}')
echo "== 8. World ID starter: cre workflow simulate handler 3 (HTTP trigger) --broadcast, payload $PAYLOAD"
simulate 3 --http-payload "$PAYLOAD" --broadcast
ARC_HUMAN_TX=$(written_tx); [ -n "$ARC_HUMAN_TX" ] || { echo "handler 3 did not write" >&2; exit 1; }
check_forwarded "$ARC" "$ARC_HUMAN_TX" $ARC_FORWARDER
echo "   starter line $STARTER_LINE: $(cast call "$CREDIT" 'lines(bytes32)((address,uint64,uint64,bool,uint256,uint256,uint256,bool))' "$STARTER_LINE" --rpc-url "$ARC")"
[ "$(cast call "$CREDIT" 'available(bytes32)(uint256)' "$STARTER_LINE" --rpc-url "$ARC" | first)" = 25000000 ] || { echo "starter line not open" >&2; exit 1; }
echo "== 8b. same nullifier again: the workflow sees it spent and skips"
simulate 3 --http-payload "$PAYLOAD" --broadcast
grep -q "already used by" "$WORK/sim.log" || { echo "reused nullifier was not skipped" >&2; exit 1; }
echo "== 8c. the human spends 10 USDC from the starter line; handler 2 must not report it to Robinhood"
HUMAN_DRAW_TX=$(send_arc "$CREDIT" 'payInvoice(bytes32,address,uint256,bytes32)' "$STARTER_LINE" "$MERCHANT" 10000000 "$(cast keccak "starter-invoice-$NOW")" --private-key "$HUMAN_KEY")
simulate 2 --evm-tx-hash "$HUMAN_DRAW_TX" --evm-event-index "$(arc_log_index "$HUMAN_DRAW_TX")" --broadcast
grep -q "World ID starter line" "$WORK/sim.log" || { echo "starter-line draw was not skipped" >&2; exit 1; }
echo "   Drawn tx $HUMAN_DRAW_TX on the starter line was skipped for Robinhood (no collateral line behind it)"

# ---------------------------------------------------------------- 9. close a fully repaid line: the freeze report alone settles it
if [ "$RECEIVER_MODE" = credit ]; then
  echo "== 9. second line, fully repaid before close: open -> draw 10 -> repay 10 -> close -> freeze -> settle"
  send_rh $NVDA 'approve(address,uint256)' "$RH_CREDIT" $COLLATERAL --private-key "$BORROWER_KEY" >/dev/null
  OPEN2_TX=$(send_rh "$RH_CREDIT" 'openCreditLine(address,uint256,uint256,uint64)' $NVDA $COLLATERAL 100000000 $EXPIRY --private-key "$BORROWER_KEY")
  OPEN2_RCPT=$(cast receipt "$OPEN2_TX" --json --rpc-url "$RH")
  LINE2=$(echo "$OPEN2_RCPT" | jq -r --arg t "$OPENED_TOPIC" '[.logs[] | select(.topics[0] == $t)][0].topics[2]')
  simulate 0 --evm-tx-hash "$OPEN2_TX" --evm-event-index "$(echo "$OPEN2_RCPT" | jq --arg t "$OPENED_TOPIC" '[.logs | to_entries[] | select(.value.topics[0] == $t)][0].key')" --broadcast
  [ -n "$(written_tx)" ] || { echo "line 2 was not opened on Arc" >&2; exit 1; }
  D2=$(send_arc "$CREDIT" 'payInvoice(bytes32,address,uint256,bytes32)' "$LINE2" "$MERCHANT" 10000000 "$(cast keccak "inv-line2-$NOW")" --private-key "$BORROWER_KEY")
  simulate 2 --evm-tx-hash "$D2" --evm-event-index "$(arc_log_index "$D2")" --broadcast
  send_arc $ARC_USDC 'approve(address,uint256)' "$CREDIT" 10000000 --private-key "$BORROWER_KEY" >/dev/null
  R2=$(send_arc "$CREDIT" 'repay(bytes32,uint256)' "$LINE2" 10000000 --private-key "$BORROWER_KEY")
  simulate 2 --evm-tx-hash "$R2" --evm-event-index "$(arc_log_index "$R2")" --broadcast
  CLOSE2_TX=$(send_rh "$RH_CREDIT" 'closeCreditLine(bytes32)' "$LINE2" --private-key "$BORROWER_KEY")
  [ "$(rh_status "$LINE2")" = 2 ] || { echo "line 2 is not Closing after close" >&2; exit 1; }
  align_arc_clock "$CLOSE2_TX"
  simulate 1 --evm-tx-hash "$CLOSE2_TX" --evm-event-index "$(cast receipt "$CLOSE2_TX" --json --rpc-url "$RH" | jq --arg t "$CLOSED_TOPIC" '[.logs | to_entries[] | select(.value.topics[0] == $t)][0].key')" --broadcast
  FREEZE2_TX=$(written_tx); [ -n "$FREEZE2_TX" ] || { echo "line 2 was not frozen on Arc" >&2; exit 1; }
  simulate 2 --evm-tx-hash "$FREEZE2_TX" --evm-event-index "$(arc_log_index "$FREEZE2_TX")" --broadcast
  SETTLE2_TX=$(written_tx); [ -n "$SETTLE2_TX" ] || { echo "freeze snapshot was not reported to Robinhood" >&2; exit 1; }
  check_forwarded "$RH" "$SETTLE2_TX" $RH_FORWARDER
  [ "$(rh_status "$LINE2")" = 3 ] || { echo "line 2 did not settle from the freeze report (status $(rh_status "$LINE2"))" >&2; exit 1; }
  [ "$(cast call $NVDA 'balanceOf(address)(uint256)' "$BORROWER" --rpc-url "$RH" | first)" = $COLLATERAL ] || { echo "line 2 collateral not returned" >&2; exit 1; }
  echo "   line 2 $LINE2 settled from the freeze report alone (status 3 = Closed); borrower NVDA back to $COLLATERAL"
fi

if [ "${NOREN_CRE_CAPTURE:-0}" = 1 ]; then
  mkdir -p "$ROOT/fixtures"
  jq -n --arg arcForkBlock "$ARC_FORK_BLOCK" --arg rhForkBlock "$RH_FORK_BLOCK" --arg rhChainId "$RH_CHAIN_ID" --arg credit "$CREDIT" --arg rhCredit "$RH_CREDIT" \
    --arg receiver "$RECEIVER_NAME" --arg creditRef "${CREDIT_COMMIT:-none}" --arg line "$LINE" --arg nvda "$NVDA_PRICE" --arg limit "$LIMIT_USDC6" \
    --arg open "$OPEN_TX" --arg arcOpen "$ARC_OPEN_TX" --arg draw "$DRAW_TX" --arg rhDraw "$RH_DRAW_TX" --arg repay "$REPAY_TX" --arg rhRepay "$RH_REPAY_TX" \
    --arg close "$CLOSE_TX" --arg arcClose "$ARC_CLOSE_TX" --arg final "$FINAL_TX" --arg rhFinal "$RH_FINAL_TX" --arg rhFreeze "$RH_FREEZE_TX" --arg settle2 "${SETTLE2_TX:-}" --arg arcHuman "$ARC_HUMAN_TX" --arg humanDraw "$HUMAN_DRAW_TX" \
    '{note: "LOCAL FORKS ONLY. Captured by packages/cre-bridge/scripts/fork-simulate.sh with cre workflow simulate --broadcast. Arc = Anvil fork of Arc Testnet (5042002). Robinhood = Anvil fork of Robinhood Chain mainnet (4663). These hashes do not exist on any public chain.",
      arcForkBlock: $arcForkBlock, robinhoodForkBlock: $rhForkBlock, robinhoodForkChainId: $rhChainId,
      norenCreditLine: $credit, robinhoodReceiver: $receiver, robinhoodReceiverAddress: $rhCredit, robinhoodReceiverCommit: $creditRef,
      lineId: $line, nvdaUsd8: $nvda, limitUsdc6: $limit,
      flow: [
        {step: "openCreditLine -> CreditLineOpened (Robinhood)", tx: $open}, {step: "NorenCreditLine.onReport via forwarder (Arc)", tx: $arcOpen},
        {step: "payInvoice -> Drawn 120 USDC (Arc)", tx: $draw}, {step: "NorenCredit.onReport via forwarder (Robinhood)", tx: $rhDraw},
        {step: "repay -> Repaid 50 USDC (Arc)", tx: $repay}, {step: "NorenCredit.onReport via forwarder (Robinhood)", tx: $rhRepay},
        {step: "closeCreditLine -> CreditLineClosed (Robinhood)", tx: $close}, {step: "NorenCreditLine.onReport limit 0 via forwarder (Arc)", tx: $arcClose},
        {step: "repay -> Repaid 70 USDC (Arc)", tx: $final}, {step: "NorenCredit.onReport via forwarder, line settled (Robinhood)", tx: $rhFinal},
        {step: "CreditLineFrozen -> NorenCredit.onReport (fresh utilisation after close)", tx: $rhFreeze},
        {step: "line 2 fully repaid, freeze report alone settles it (Robinhood)", tx: $settle2},
        {step: "World ID starter (HTTP trigger) -> NorenCreditLine.onReport kind 2 via forwarder (Arc)", tx: $arcHuman},
        {step: "payInvoice 10 USDC on the starter line (Arc), not relayed to Robinhood", tx: $humanDraw}
      ]}' >"$ROOT/fixtures/fork-run.json"
  echo "== transcript saved to fixtures/fork-run.json"
fi
echo "== PASS: credit line bridged both ways through CRE on local forks ($RECEIVER_NAME on Robinhood); forks stop now"
