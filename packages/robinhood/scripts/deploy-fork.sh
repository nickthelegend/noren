#!/usr/bin/env bash
# Deploy Noren to the local Robinhood mainnet fork (port 8720) and seed demo balances.
# Uses Anvil's published dev keys, which are only acceptable on a disposable local fork.
# Prints the addresses and writes packages/robinhood/.fork/deployment.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${NOREN_RH_FORK_PORT:-8720}"
RPC="http://127.0.0.1:$PORT"
case "$RPC" in http://127.0.0.1:*) ;; *) echo "Refusing: deploy-fork only targets a local fork" >&2; exit 1;; esac
[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = 4663 ] || { echo "Start the fork first: sh scripts/fork.sh" >&2; exit 1; }

# Anvil dev accounts (public test mnemonic): #0 owner/LP, #1 demo customer, #2 demo merchant,
# #3 Aqua maker (a merchant with idle USDG), #4 liquidation keeper,
# #7 stand-in World ID attester when NOREN_WORLD_ATTESTER_KEY is not configured,
# #8 stand-in CRE forwarder on the fork, #9 underwriter signer on the fork.
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
CUSTOMER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
MERCHANT=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
MAKER=0x90F79bf6EB2c4f870365E785982E1f101E93b906
MAKER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
KEEPER=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
FORWARDER="${NOREN_RH_FORWARDER:-0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f}"
UNDERWRITER="${NOREN_RH_UNDERWRITER:-0xa0Ee7A142d267C1f36714E4a8F75612F20a79720}"
# World ID attester (NorenReputation.worldIdSigner): the address of NOREN_WORLD_ATTESTER_KEY, from the
# environment or the main checkout's gitignored .env (the key itself is never printed). Without one,
# Anvil's published #7 stands in on the fork.
WORLD_ID_SIGNER="${NOREN_RH_WORLD_ID_SIGNER:-}"
if [ -z "$WORLD_ID_SIGNER" ]; then
  ENV_FILE="${NOREN_ENV_FILE:-$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)/.." 2>/dev/null && pwd)/.env}"
  ATTESTER_KEY="${NOREN_WORLD_ATTESTER_KEY:-}"
  if [ -z "$ATTESTER_KEY" ] && [ -f "$ENV_FILE" ]; then ATTESTER_KEY=$(sed -nE 's/^NOREN_WORLD_ATTESTER_KEY=(0x[0-9a-fA-F]{64})[[:space:]]*$/\1/p' "$ENV_FILE" | tail -1); fi
  [ -n "$ATTESTER_KEY" ] && WORLD_ID_SIGNER=$(cast wallet address "$ATTESTER_KEY" 2>/dev/null || true)
  unset ATTESTER_KEY
  WORLD_ID_SIGNER="${WORLD_ID_SIGNER:-0x14dC79964da2C08b23698B3D3cc7Ca32193d9955}"
fi
INTERVAL="${NOREN_RH_INSTALLMENT_INTERVAL:-1209600}"
GRACE="${NOREN_RH_GRACE:-259200}"
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
TSLA=0x322F0929c4625eD5bAd873c95208D54E1c003b2d
AAPL=0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9

for a in "$OWNER" "$CUSTOMER" "$MERCHANT" "$MAKER" "$KEEPER" "$FORWARDER" "$UNDERWRITER" "$WORLD_ID_SIGNER"; do
  cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x56BC75E2D63100000 >/dev/null # 100 ETH (fork gas only)
done

mkdir -p "$ROOT/.fork"
(cd "$ROOT/../aqua/swapvm-ext" && forge build >/dev/null 2>"$ROOT/.fork/swapvm-build.log") || { echo "Setup required: pnpm install, then forge build in packages/aqua/swapvm-ext" >&2; exit 1; }
cd "$ROOT/contracts"
OUT="$(NOREN_RH_OWNER=$OWNER NOREN_RH_UNDERWRITER=$UNDERWRITER NOREN_RH_FORWARDER=$FORWARDER NOREN_RH_WORLD_ID_SIGNER=$WORLD_ID_SIGNER \
  NOREN_RH_INSTALLMENT_INTERVAL=$INTERVAL NOREN_RH_GRACE=$GRACE \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --private-key "$OWNER_KEY" 2>&1)" || { echo "$OUT" >&2; exit 1; }
pick() { sed -nE "s/.*$1[[:space:]]+(0x[[:xdigit:]]{40}).*/\1/p" <<<"$OUT" | tail -1; }
ORACLE=$(pick NOREN_RH_ORACLE); VAULT=$(pick NOREN_RH_VAULT); GATEWAY=$(pick NOREN_RH_GATEWAY); CREDIT=$(pick NOREN_RH_CREDIT)
ROUTER=$(pick NOREN_RH_SWAPVM_ROUTER); LIQUIDITY=$(pick NOREN_RH_LIQUIDITY); DUTCH=$(pick NOREN_RH_DUTCH_AUCTION)
REPUTATION=$(pick NOREN_RH_REPUTATION); BORROW=$(pick NOREN_RH_BORROW); CREDIT_LENS=$(pick NOREN_RH_CREDIT_LENS)
DEPOSIT_VAULTS=$(sed -nE 's/.*NOREN_RH_DEPOSIT_VAULT[[:space:]]+(0x[[:xdigit:]]{40})[[:space:]]+(0x[[:xdigit:]]{40}).*/{"asset":"\1","vault":"\2"}/p' <<<"$OUT" | paste -sd, - | sed 's/^/[/;s/$/]/')
[ -n "$BORROW" ] && [ -n "$REPUTATION" ] || { echo "$OUT" >&2; exit 1; }
[ -n "$CREDIT" ] && [ -n "$LIQUIDITY" ] || { echo "$OUT" >&2; exit 1; }
DEPLOY_BLOCK=$(cast block-number --rpc-url "$RPC")

# Seed from a real holder (Uniswap v4 PoolManager) by impersonation on the fork.
cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$POOL_MANAGER" >/dev/null
cast rpc --rpc-url "$RPC" anvil_setBalance "$POOL_MANAGER" 0x56BC75E2D63100000 >/dev/null
send_pm() { cast send --rpc-url "$RPC" --unlocked --from "$POOL_MANAGER" "$1" 'transfer(address,uint256)' "$2" "$3" --json | jq -r .transactionHash; }
TX_LP_FUND=$(send_pm $USDG $OWNER 250000000000)
TX_CUST_USDG=$(send_pm $USDG $CUSTOMER 5000000000)
TX_CUST_NVDA=$(send_pm $NVDA $CUSTOMER 20000000000000000000)
TX_CUST_TSLA=$(send_pm $TSLA $CUSTOMER 10000000000000000000)
TX_CUST_AAPL=$(send_pm $AAPL $CUSTOMER 10000000000000000000)
# The other Stock Tokens with Chainlink feeds, so every one can pay at checkout on the snapshot (10 each, demo customer).
for T in 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C 0xe93237C50D904957Cf27E7B1133b510C669c2e74 0x12f190a9F9d7D37a250758b26824B97CE941bF54 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35; do
  send_pm $T $CUSTOMER 10000000000000000000 >/dev/null
done
TX_MAKER_USDG=$(send_pm $USDG $MAKER 100000000000)
cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$POOL_MANAGER" >/dev/null
cast send --rpc-url "$RPC" --private-key "$OWNER_KEY" $USDG 'approve(address,uint256)' "$VAULT" 250000000000 >/dev/null
TX_LP_DEPOSIT=$(cast send --rpc-url "$RPC" --private-key "$OWNER_KEY" "$VAULT" 'deposit(uint256,address)' 250000000000 "$OWNER" --json | jq -r .transactionHash)

# Aqua maker: ships NorenOraclePeg strategies for NVDA, TSLA, AAPL, SPY, MSFT, AMZN, GOOGL, META and WETH (10,000 USDG each) and registers them.
STRATEGIES="[]"
if [ "${NOREN_AQUA_SEED_MAKERS:-1}" = 1 ]; then
  SEED="$(NOREN_RH_LIQUIDITY=$LIQUIDITY forge script script/SeedMakers.s.sol:SeedMakers --rpc-url "$RPC" --broadcast --private-key "$MAKER_KEY" 2>&1)" || { echo "$SEED" >&2; exit 1; }
  STRATEGIES=$(sed -nE 's/.*NOREN_AQUA_STRATEGY[[:space:]]+(0x[[:xdigit:]]{40})[[:space:]]+(0x[[:xdigit:]]{64}).*/{"asset":"\1","strategyHash":"\2"}/p' <<<"$SEED" | paste -sd, - | sed 's/^/[/;s/$/]/')
fi

mkdir -p "$ROOT/.fork"
cat >"$ROOT/.fork/deployment.json" <<JSON
{
  "network": "robinhood-mainnet-fork",
  "chainId": 4663,
  "rpcUrl": "$RPC",
  "deployBlock": $DEPLOY_BLOCK,
  "oracle": "$ORACLE",
  "vault": "$VAULT",
  "gateway": "$GATEWAY",
  "credit": "$CREDIT",
  "liquidity": "$LIQUIDITY",
  "dutchAuction": "$DUTCH",
  "reputation": "$REPUTATION",
  "borrow": "$BORROW",
  "creditLens": "$CREDIT_LENS",
  "depositVaults": $DEPOSIT_VAULTS,
  "worldIdSigner": "$WORLD_ID_SIGNER",
  "swapRouter": "$ROUTER",
  "aqua": "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a",
  "officialSwapRouter": "0x111111338c5091E8440b67B168bAe16a668AC0De",
  "demoMaker": "$MAKER",
  "demoKeeper": "$KEEPER",
  "makerStrategies": $STRATEGIES,
  "usdg": "$USDG",
  "weth": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  "owner": "$OWNER",
  "underwriter": "$UNDERWRITER",
  "forwarder": "$FORWARDER",
  "demoCustomer": "$CUSTOMER",
  "demoMerchant": "$MERCHANT",
  "installmentInterval": $INTERVAL,
  "gracePeriod": $GRACE,
  "seedTxs": {"lpFund": "$TX_LP_FUND", "lpDeposit": "$TX_LP_DEPOSIT", "customerUsdg": "$TX_CUST_USDG", "customerNvda": "$TX_CUST_NVDA", "customerTsla": "$TX_CUST_TSLA", "customerAapl": "$TX_CUST_AAPL", "makerUsdg": "$TX_MAKER_USDG"}
}
JSON
cat "$ROOT/.fork/deployment.json"
