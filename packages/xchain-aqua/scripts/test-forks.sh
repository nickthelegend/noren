#!/bin/sh
# Foundry suite for Noren cross-chain Aqua on local forks, one fork pair at a time:
#   phase 1: Arc Testnet fork (official Aqua from Arc mainnet bytecode) + warmed Robinhood mainnet snapshot
#   phase 2: Arc Testnet fork + Base Sepolia fork (and the Arc-only delivered-order tests)
# Extra args go to forge test (e.g. -vvv --match-test Stale). Stops every anvil it starts.
set -eu
. "$(dirname "$0")/forks.sh"
need anvil cast forge jq
trap stop_forks EXIT INT TERM
[ -s "$XC_ROOT/../aqua/swapvm-ext/out/NorenAquaSwapVMRouter.sol/NorenAquaSwapVMRouter.json" ] || {
  echo "Setup required: (cd packages/aqua/swapvm-ext && forge build)" >&2; exit 1; }
cd "$XC_ROOT/contracts"
forge build >/dev/null

echo "== phase 1: Arc Testnet fork + Robinhood mainnet snapshot" >&2
start_arc
start_rh
echo "   Arc fork block $ARC_FORK_BLOCK, Aqua codehash $AQUA_HASH (= Arc mainnet); Robinhood snapshot block $RH_SNAPSHOT_BLOCK" >&2
NOREN_XCHAIN_ARC_RPC=$ARC NOREN_XCHAIN_RH_RPC=$RH forge test --match-contract XChainRobinhoodArcTest "$@"
stop_pid "$RH_PID"

echo "== phase 2: Arc Testnet fork + Base Sepolia fork" >&2
start_base
echo "   Base Sepolia fork block $BASE_FORK_BLOCK" >&2
NOREN_XCHAIN_ARC_RPC=$ARC NOREN_XCHAIN_BASE_RPC=$BASE forge test --match-contract 'XChainBaseArcTest|XChainDeliveredTest|XChainActionRouterTest' "$@"
