#!/usr/bin/env bash
# Noren public-testnet deploy: the whole Arc-side stack on PUBLIC Arc testnet (5042002), plus the CCIP
# endpoints on Base Sepolia, Ethereum Sepolia and Robinhood testnet. No forks.
#
#   bash scripts/deploy-public.sh                 # plan + preflight only (default; sends nothing)
#   bash scripts/deploy-public.sh --execute       # run every step in order (real testnet transactions)
#   bash scripts/deploy-public.sh --execute 3     # resume from step 3
#
# Each step is an existing, resumable script (docs/DEPLOY.md explains them). This wrapper adds:
#   - preflight: the RPC is the public Arc testnet (never a loopback fork), the deployer key exists
#     (by name; it is never printed), the deployer has USDC for gas;
#   - DEV_ONLY refusal: no step may deploy a contract marked DEV_ONLY (ForkUSDC, NorenCreditHarness) or
#     install code with anvil_setCode;
#   - the CRE forwarder policy: NOREN_CRE_MODE=simulate uses Chainlink's MockKeystoneForwarder (CRE
#     simulation, no DON signatures, testnet only); NOREN_CRE_MODE=production refuses every known mock
#     forwarder, requires CRE_FORWARDER (a real KeystoneForwarder with code) and CRE_WORKFLOW_OWNER, and
#     rewires every CRE receiver to them after the deploy.
# Every deployer transaction in the step scripts runs under /private/tmp/noren-arc-deployer.lock.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE=plan; FROM=1
[ "${1:-}" = --execute ] && { MODE=execute; FROM=${2:-1}; }

die() { echo "deploy-public: $*" >&2; exit 1; }
ARC_RPC=${NOREN_RPC_URL:-https://rpc.testnet.arc.io}
ARC_CHAIN=5042002
# Chainlink CRE simulation forwarders (MockKeystoneForwarder) on the chains Noren uses. Never production.
MOCK_FORWARDERS="0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1 0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5 0x0b93082D9b3C7C97fAcd250082899BAcf3af3885"

# ---------------------------------------------------------------- env (names only)
ENV_FILE=${NOREN_ENV_FILE:-}
if [ -z "$ENV_FILE" ]; then
  for f in "$ROOT/.env.arc-deployer" "$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)/.." 2>/dev/null && pwd)/.env.arc-deployer"; do
    [ -f "$f" ] && { ENV_FILE=$f; break; }
  done
fi
[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || die "Setup required: a gitignored env file with NOREN_DEPLOYER_KEY (set NOREN_ENV_FILE)"
grep -qE '^NOREN_DEPLOYER_KEY=0x[0-9a-fA-F]{64}' "$ENV_FILE" || die "Setup required: NOREN_DEPLOYER_KEY in $ENV_FILE"
export NOREN_ENV_FILE=$ENV_FILE ENV_FILE
DEPLOYER=$(set -a; . "$ENV_FILE" >/dev/null 2>&1; cast wallet address --private-key "$NOREN_DEPLOYER_KEY" 2>/dev/null) || die "NOREN_DEPLOYER_KEY is not a valid key"

# ---------------------------------------------------------------- preflight
case "$ARC_RPC" in *127.0.0.1*|*localhost*|*0.0.0.0*) die "refusing a local RPC ($ARC_RPC): this script deploys to the public Arc testnet only";; esac
CHAIN=$(cast chain-id --rpc-url "$ARC_RPC") || die "RPC unreachable: $ARC_RPC"
[ "$CHAIN" = "$ARC_CHAIN" ] || die "RPC chain id $CHAIN, expected Arc testnet $ARC_CHAIN"
if cast rpc anvil_nodeInfo --rpc-url "$ARC_RPC" >/dev/null 2>&1; then die "RPC is an Anvil node, not the public chain"; fi
GAS_USDC=$(cast call 0x3600000000000000000000000000000000000000 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$ARC_RPC" | awk '{print $1}')

CRE_MODE=${NOREN_CRE_MODE:-}
case "$CRE_MODE" in
  simulate) FWD=0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1 ;;
  production)
    FWD=${CRE_FORWARDER:-}; [ -n "$FWD" ] || die "Setup required: CRE_FORWARDER (KeystoneForwarder; docs/CHAINLINK.md)"
    for m in $MOCK_FORWARDERS; do [ "$(echo "$FWD" | tr A-F a-f)" = "$(echo "$m" | tr A-F a-f)" ] && die "CRE_FORWARDER is Chainlink's MockKeystoneForwarder (simulation only); production needs the real KeystoneForwarder"; done
    [ "$(cast code "$FWD" --rpc-url "$ARC_RPC")" != 0x ] || die "CRE_FORWARDER $FWD has no code on Arc testnet"
    [ -n "${CRE_WORKFLOW_OWNER:-}" ] || die "Setup required: CRE_WORKFLOW_OWNER (the DON workflow owner every receiver pins)" ;;
  *) die "Setup required: NOREN_CRE_MODE=simulate (CRE simulator, MockKeystoneForwarder) or NOREN_CRE_MODE=production (real KeystoneForwarder)";;
esac

# ---------------------------------------------------------------- steps
# id|description|command
STEPS=(
  "Kohaku privacy pool (Entrypoint, verifiers, USDC pool) + NorenCheckout|pnpm exec tsx scripts/deploy-arc.ts"
  "NorenCcipGateway + NorenArcActionRouter on Arc|env ROLE=arc CCIP_ROUTER=0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8 CCIP_SELECTOR=3034092155422581607 bash -c 'cd packages/ccip && bash scripts/live.sh script/Deploy.s.sol:Deploy arc_testnet'"
  "NorenCcipHub on Base Sepolia|env ROLE=hub CCIP_ROUTER=0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93 CCIP_SELECTOR=10344971235874465080 bash -c 'cd packages/ccip && bash scripts/live.sh script/Deploy.s.sol:Deploy base_sepolia'"
  "NorenCcipGateway + NorenCcipInbox on Robinhood testnet|env ROLE=gateway-inbox CCIP_ROUTER=0x30D197C6F5bE050D5525dD94d01760FaCdB67e7C CCIP_SELECTOR=2032988798112970440 bash -c 'cd packages/ccip && bash scripts/live.sh script/Deploy.s.sol:Deploy robinhood_testnet'"
  "NorenCcipGateway on Ethereum Sepolia|env ROLE=gateway CCIP_ROUTER=0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59 CCIP_SELECTOR=16015286601757825753 bash -c 'cd packages/ccip && bash scripts/live.sh script/Deploy.s.sol:Deploy ethereum_sepolia'"
  "CCIP lanes and routes (Configure.s.sol, per ROLE; addresses from packages/ccip/deployments.json, see docs/CCIP.md)|echo 'Run packages/ccip/script/Configure.s.sol per ROLE with the addresses printed above (docs/CCIP.md)'"
  "NorenRateOracle + NorenCreditLine (and the first CRE simulate --broadcast writes)|pnpm exec tsx scripts/live/cre-live.ts"
  "NorenArcHook (CCTP V2) wired to the action router|bash packages/cctp/scripts/deploy-arc-hook.sh"
  "NorenShieldSink + SHIELD-aware NorenArcHook (arrive private)|pnpm exec tsx scripts/live/private-deploy.ts"
  "1inch Aqua v1.0.0, NorenAquaSwapVMRouter, NorenRateOracleFeed x2, NorenCrossChainSettler|bash scripts/live/aqua-build-official.sh && (cd packages/aqua/swapvm-ext && forge build) && (cd packages/xchain-aqua/contracts && forge build) && pnpm exec tsx scripts/live/aqua-live.ts deploy"
  "NorenCreditLine with drawToPool (pay later, privately)|pnpm exec tsx scripts/live/private-credit-live.ts"
)
# Contracts marked DEV_ONLY in their source must never be deployed by a step.
DEV_ONLY=$(grep -rlE '^/// .*DEV_ONLY' packages/*/src packages/*/contracts/src 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.sol$//' | sort -u | tr '\n' ' ')
check_step() {
  local cmd=$1 files f c
  files=$(grep -oE '(scripts|packages)/[A-Za-z0-9_./-]+\.(ts|sh|sol)' <<<"$cmd" | sort -u)
  for f in $files; do
    [ -f "$f" ] || continue
    if grep -qE 'anvil_setCode|anvil_impersonate' "$f" && ! grep -qE -- '--fork|isLocal|dry-run|DRY_RUN|fork-only|FORK' "$f"; then die "$f uses Anvil-only RPCs outside a fork guard"; fi
    for c in $DEV_ONLY; do
      if grep -qE "(new $c\b|$c\.sol:$c|artifact\(['\"]$c)" "$f" && ! grep -qE -- '--fork|isLocal|fork-only|FORK' "$f"; then die "$f deploys DEV_ONLY contract $c"; fi
    done
  done
}

echo "Noren public deploy, $MODE mode"
echo "  Arc testnet RPC   $ARC_RPC (chain $CHAIN, not a fork)"
echo "  deployer          $DEPLOYER (key from $(basename "$ENV_FILE"), never printed); USDC for gas: $GAS_USDC (6 dp)"
echo "  CRE               $CRE_MODE, forwarder $FWD"
echo "  DEV_ONLY refused  ${DEV_ONLY:-none}"
i=0
for s in "${STEPS[@]}"; do
  i=$((i + 1)); desc=${s%%|*}; cmd=${s#*|}
  check_step "$cmd"
  printf '  %2d. %s\n      %s\n' "$i" "$desc" "$cmd"
done
[ "$GAS_USDC" -gt 0 ] || echo "  warning: the deployer holds no Arc testnet USDC; fund it at https://faucet.circle.com first"
[ "$MODE" = plan ] && { echo "Plan only: nothing was sent. Re-run with --execute to deploy."; exit 0; }

i=0
for s in "${STEPS[@]}"; do
  i=$((i + 1)); [ "$i" -lt "$FROM" ] && continue
  desc=${s%%|*}; cmd=${s#*|}
  echo "== step $i: $desc"
  bash -c "$cmd" || die "step $i failed; fix and resume with: bash scripts/deploy-public.sh --execute $i"
done

if [ "$CRE_MODE" = production ]; then
  echo "== production CRE: point every receiver at $FWD and pin workflow owner $CRE_WORKFLOW_OWNER"
  RECEIVERS=$(jq -r '.live.pricing.oracle, .live.credit.creditLine' deployments/5042002.json 2>/dev/null; jq -r '.contracts.settler.address' packages/xchain-aqua/live/arc-testnet.json 2>/dev/null; jq -r '.creditLine' scripts/live/private-credit-runs.json 2>/dev/null)
  HOOKS=$(jq -r '."5042002".NorenArcHook, ."5042002".privacy.NorenArcHook' packages/cctp/deployments.json 2>/dev/null)
  (set -a; . "$ENV_FILE" >/dev/null 2>&1; set +a
   for r in $RECEIVERS; do
     [ "$r" = null ] && continue
     cast send "$r" 'setForwarder(address)' "$FWD" --rpc-url "$ARC_RPC" --private-key "$NOREN_DEPLOYER_KEY" >/dev/null
     cast send "$r" 'setExpectedWorkflowOwner(address)' "$CRE_WORKFLOW_OWNER" --rpc-url "$ARC_RPC" --private-key "$NOREN_DEPLOYER_KEY" >/dev/null
     echo "  $r forwarder + workflow owner set"
   done
   for h in $HOOKS; do
     [ "$h" = null ] && continue
     cast send "$h" 'setForwarder(address)' "$FWD" --rpc-url "$ARC_RPC" --private-key "$NOREN_DEPLOYER_KEY" >/dev/null
     echo "  $h (NorenArcHook) forwarder set"
   done)
fi
echo "Done. Addresses: deployments/5042002.json, packages/ccip/deployments.json, packages/cctp/deployments.json,"
echo "packages/xchain-aqua/live/arc-testnet.json, scripts/live/private-deployments.json, scripts/live/private-credit-runs.json."
echo "Verify sources: docs/DEPLOY.md#verified-source."
