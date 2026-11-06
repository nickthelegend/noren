#!/bin/sh
# Local forks for Noren cross-chain Aqua (sourced by test-forks.sh and xchain-demo.sh).
#
#   Arc        127.0.0.1:8810  Anvil fork of Arc Testnet (5042002). 1inch Aqua and the SwapVM router are
#                              NOT deployed on Arc Testnet, and 1inch's CREATE3 factory
#                              0xaa710bd40c633ab46d30fc6baf6885143f3a6dd7 has no code there, so the
#                              official addresses can't be reproduced by anyone but 1inch. The fork
#                              therefore gets the OFFICIAL runtime bytecode copied from Arc mainnet (5042)
#                              at the official addresses (anvil_setCode). FORK-ONLY.
#                              Arc's native USDC is replaced by the fork-only ForkUSDC shim (as in
#                              scripts/dev-stack.ts and packages/cre-bridge), because stock Anvil can't
#                              execute it.
#   Robinhood  127.0.0.1:8811  the warmed Robinhood Chain mainnet snapshot (packages/robinhood
#                              fork-snapshot.sh; real Stock Tokens and Chainlink feeds), chain id 4663.
#                              The robinhood-testnet MockKeystoneForwarder is copied in from Robinhood Testnet.
#   Base       127.0.0.1:8812  Anvil fork of Base Sepolia (84532): real WETH, real Chainlink ETH/USD,
#                              real MockKeystoneForwarder.
# Every fork is started by the caller and stopped by its EXIT trap. Anvil dev keys only.

ARC_PORT=${NOREN_XCHAIN_ARC_PORT:-8810}
RH_PORT=${NOREN_XCHAIN_RH_PORT:-8811}
BASE_PORT=${NOREN_XCHAIN_BASE_PORT:-8812}
ARC="http://127.0.0.1:$ARC_PORT"
RH="http://127.0.0.1:$RH_PORT"
BASE="http://127.0.0.1:$BASE_PORT"
ARC_UPSTREAM=${ARC_TESTNET_RPC:-https://rpc.testnet.arc.io}
ARC_MAINNET=${ARC_MAINNET_RPC:-https://arc-rpc.publicnode.com}
BASE_UPSTREAM=${BASE_SEPOLIA_RPC:-https://sepolia.base.org}
RH_TESTNET=https://rpc.testnet.chain.robinhood.com
AQUA=0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a
OFFICIAL_ROUTER=0x111111338c5091E8440b67B168bAe16a668AC0De
AQUA_FACTORY=0xaa710bd40c633ab46d30fc6baf6885143f3a6dd7
ARC_USDC=0x3600000000000000000000000000000000000000
RH_FORWARDER=0x0b93082D9b3C7C97fAcd250082899BAcf3af3885
XC_ROOT=${XC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
PIDS=""

need() { for c in "$@"; do command -v "$c" >/dev/null || { echo "Setup required: $c" >&2; exit 1; }; done; }
port_free() { if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $1 is busy; stop it first" >&2; exit 1; fi; }
stop_forks() { for p in $PIDS; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; PIDS=""; }
stop_pid() { kill "$1" 2>/dev/null || true; wait "$1" 2>/dev/null || true; PIDS=$(echo "$PIDS" | tr ' ' '\n' | grep -v "^$1\$" | tr '\n' ' '); }
wait_rpc() {
  i=0
  until cast chain-id --rpc-url "$1" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 120 ] && { echo "Anvil $1 did not start:" >&2; tail -c 800 "$2" >&2; exit 1; }
    sleep 0.5
  done
}
codehash() { cast keccak "$(cast code "$1" --rpc-url "$2")"; }

start_arc() {
  port_free "$ARC_PORT"
  mkdir -p "$XC_ROOT/.fork"
  anvil --silent --host 127.0.0.1 --port "$ARC_PORT" --fork-url "$ARC_UPSTREAM" --chain-id 5042002 \
    --retries 20 --fork-retry-backoff 1500 >"$XC_ROOT/.fork/arc-anvil.log" 2>&1 &
  ARC_PID=$!; PIDS="$PIDS $ARC_PID"
  wait_rpc "$ARC" "$XC_ROOT/.fork/arc-anvil.log"
  [ "$(cast chain-id --rpc-url "$ARC")" = 5042002 ] || { echo "Arc fork has the wrong chain id" >&2; exit 1; }
  ARC_FORK_BLOCK=$(cast block-number --rpc-url "$ARC")

  # Official 1inch Aqua + SwapVM router: absent on Arc Testnet, so copied from Arc mainnet (fork only).
  [ "$(cast code $AQUA --rpc-url "$ARC_UPSTREAM")" = 0x ] || echo "note: Aqua now has code on Arc Testnet; using it as deployed" >&2
  [ "$(cast code $AQUA_FACTORY --rpc-url "$ARC_UPSTREAM")" = 0x ] || echo "note: 1inch's CREATE3 factory now exists on Arc Testnet" >&2
  if [ "$(cast code $AQUA --rpc-url "$ARC")" = 0x ]; then
    for a in $AQUA $OFFICIAL_ROUTER; do
      cast rpc anvil_setCode "$a" "$(cast code "$a" --rpc-url "$ARC_MAINNET")" --rpc-url "$ARC" >/dev/null
    done
    # Router storage slot 2 is the Rescuable owner (1inch's deployer); the rest of its state is empty.
    cast rpc anvil_setStorageAt $OFFICIAL_ROUTER 0x0000000000000000000000000000000000000000000000000000000000000002 \
      "$(cast storage $OFFICIAL_ROUTER 2 --rpc-url "$ARC_MAINNET")" --rpc-url "$ARC" >/dev/null
  fi
  AQUA_HASH=$(codehash $AQUA "$ARC")
  [ "$AQUA_HASH" = "$(codehash $AQUA "$ARC_MAINNET")" ] || { echo "Aqua bytecode on the Arc fork differs from Arc mainnet" >&2; exit 1; }
  ROUTER_HASH=$(codehash $OFFICIAL_ROUTER "$ARC")
  [ "$ROUTER_HASH" = "$(codehash $OFFICIAL_ROUTER "$ARC_MAINNET")" ] || { echo "router bytecode differs from Arc mainnet" >&2; exit 1; }

  # Fork-only USDC shim at Arc's USDC address.
  SHIM_DIR="$XC_ROOT/.fork/shim"
  mkdir -p "$SHIM_DIR/src"
  cp "$XC_ROOT/../contracts/src/ForkUSDC.sol" "$SHIM_DIR/src/ForkUSDC.sol"
  printf "[profile.default]\nsrc = 'src'\nout = 'out'\nsolc_version = '0.8.28'\noptimizer = true\nbytecode_hash = 'none'\ncbor_metadata = false\n" >"$SHIM_DIR/foundry.toml"
  cast rpc anvil_setCode $ARC_USDC "$(forge inspect --root "$SHIM_DIR" src/ForkUSDC.sol:ForkUSDC deployedBytecode)" --rpc-url "$ARC" >/dev/null
}

rh_snapshot_path() {
  for f in "${NOREN_RH_SNAPSHOT:-}" "$XC_ROOT/../robinhood/.fork/robinhood-snapshot.json"; do
    [ -n "$f" ] && [ -s "$f" ] && { echo "$f"; return; }
  done
  echo "Setup required: the warmed Robinhood snapshot. Run 'sh packages/robinhood/scripts/fork-snapshot.sh' or set NOREN_RH_SNAPSHOT" >&2
  exit 1
}

start_rh() {
  port_free "$RH_PORT"
  SNAP=$(rh_snapshot_path)
  anvil --silent --host 127.0.0.1 --port "$RH_PORT" --load-state "$SNAP" --chain-id 4663 >"$XC_ROOT/.fork/rh-anvil.log" 2>&1 &
  RH_PID=$!; PIDS="$PIDS $RH_PID"
  wait_rpc "$RH" "$XC_ROOT/.fork/rh-anvil.log"
  [ "$(cast chain-id --rpc-url "$RH")" = 4663 ] || { echo "Robinhood snapshot has the wrong chain id" >&2; exit 1; }
  RH_SNAPSHOT_BLOCK=$(cast block-number --rpc-url "$RH")
  # The snapshot's clock stops at its build time; move it to now so Chainlink ages are real ages.
  NOW=$(date +%s)
  HEAD_TS=$(cast block latest --field timestamp --rpc-url "$RH")
  if [ "$HEAD_TS" -lt "$NOW" ]; then
    cast rpc evm_setNextBlockTimestamp "$NOW" --rpc-url "$RH" >/dev/null
    cast rpc evm_mine --rpc-url "$RH" >/dev/null
  fi
  # robinhood-testnet MockKeystoneForwarder: not on mainnet, so its real bytecode and its two storage
  # slots come from Robinhood Testnet (same as packages/cre-bridge/scripts/fork-simulate.sh).
  FWD_CODE=$(cast code $RH_FORWARDER --rpc-url $RH_TESTNET)
  [ "$FWD_CODE" != 0x ] || { echo "robinhood-testnet MockKeystoneForwarder not found on Robinhood Testnet" >&2; exit 1; }
  cast rpc anvil_setCode $RH_FORWARDER "$FWD_CODE" --rpc-url "$RH" >/dev/null
  SELF_SLOT=$(cast index address $RH_FORWARDER 2)
  for slot in 0x0 "$SELF_SLOT"; do
    cast rpc anvil_setStorageAt $RH_FORWARDER "$(cast to-uint256 "$slot")" "$(cast storage $RH_FORWARDER "$slot" --rpc-url $RH_TESTNET)" --rpc-url "$RH" >/dev/null
  done
}

start_base() {
  port_free "$BASE_PORT"
  anvil --silent --host 127.0.0.1 --port "$BASE_PORT" --fork-url "$BASE_UPSTREAM" --chain-id 84532 \
    --retries 20 --fork-retry-backoff 1500 >"$XC_ROOT/.fork/base-anvil.log" 2>&1 &
  BASE_PID=$!; PIDS="$PIDS $BASE_PID"
  wait_rpc "$BASE" "$XC_ROOT/.fork/base-anvil.log"
  [ "$(cast chain-id --rpc-url "$BASE")" = 84532 ] || { echo "Base Sepolia fork has the wrong chain id" >&2; exit 1; }
  BASE_FORK_BLOCK=$(cast block-number --rpc-url "$BASE")
}
