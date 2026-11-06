#!/bin/sh
# Foundry suite for the Arc Testnet Aqua stack (docs/AQUA-LIVE.md) on an Anvil fork of Arc Testnet,
# port 8840 (aqua-live block). Fresh copy from live/config.json by default; NOREN_AQUA_LIVE=1 runs the
# same tests against the deployed addresses in live/arc-testnet.json. Stops its anvil on exit.
#   sh packages/xchain-aqua/scripts/test-aqua-live.sh [forge test args]
set -eu
export NOREN_XCHAIN_ARC_PORT=${NOREN_AQUA_ARC_PORT:-8840}
. "$(dirname "$0")/forks.sh"
need anvil cast forge jq
trap stop_forks EXIT INT TERM
[ -s "$XC_ROOT/../aqua/aqua-official/build/out/AquaRouter.sol/AquaRouter.json" ] || {
  echo "Setup required: bash scripts/live/aqua-build-official.sh" >&2; exit 1; }
[ -s "$XC_ROOT/../aqua/swapvm-ext/out/NorenAquaSwapVMRouter.sol/NorenAquaSwapVMRouter.json" ] || {
  echo "Setup required: (cd packages/aqua/swapvm-ext && forge build)" >&2; exit 1; }
cd "$XC_ROOT/contracts"
forge build >/dev/null
start_arc
echo "   Arc Testnet fork block $ARC_FORK_BLOCK (USDC shim installed; EURC, NorenRateOracle and the action router are live state)" >&2
NOREN_AQUA_ARC_RPC=$ARC forge test --match-contract AquaLiveArcTest "$@"
