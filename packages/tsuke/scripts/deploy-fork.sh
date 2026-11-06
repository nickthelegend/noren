#!/usr/bin/env bash
# Deploy Tsuke to the local Robinhood mainnet fork (port 8720) and seed demo balances.
# Uses Anvil's published dev keys, which are only acceptable on a disposable local fork.
# Prints the addresses and writes packages/tsuke/.fork/deployment.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${TSUKE_FORK_PORT:-8720}"
RPC="http://127.0.0.1:$PORT"
case "$RPC" in http://127.0.0.1:*) ;; *) echo "Refusing: deploy-fork only targets a local fork" >&2; exit 1;; esac
[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = 4663 ] || { echo "Start the fork first: sh scripts/fork.sh" >&2; exit 1; }

# Anvil dev accounts (public test mnemonic): #0 owner/LP, #1 demo customer, #2 demo merchant,
# #8 stand-in CRE forwarder on the fork, #9 underwriter signer on the fork.
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
CUSTOMER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
MERCHANT=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
FORWARDER="${TSUKE_FORWARDER:-0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f}"
UNDERWRITER="${TSUKE_UNDERWRITER:-0xa0Ee7A142d267C1f36714E4a8F75612F20a79720}"
INTERVAL="${TSUKE_INSTALLMENT_INTERVAL:-1209600}"
GRACE="${TSUKE_GRACE:-259200}"
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
TSLA=0x322F0929c4625eD5bAd873c95208D54E1c003b2d
AAPL=0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9

for a in "$OWNER" "$CUSTOMER" "$MERCHANT" "$FORWARDER" "$UNDERWRITER"; do
  cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x56BC75E2D63100000 >/dev/null # 100 ETH (fork gas only)
done

cd "$ROOT/contracts"
OUT="$(TSUKE_OWNER=$OWNER TSUKE_UNDERWRITER=$UNDERWRITER TSUKE_FORWARDER=$FORWARDER \
  TSUKE_INSTALLMENT_INTERVAL=$INTERVAL TSUKE_GRACE=$GRACE \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --private-key "$OWNER_KEY" 2>&1)" || { echo "$OUT" >&2; exit 1; }
pick() { sed -nE "s/.*$1[[:space:]]+(0x[[:xdigit:]]{40}).*/\1/p" <<<"$OUT" | tail -1; }
ORACLE=$(pick TSUKE_ORACLE); VAULT=$(pick TSUKE_VAULT); GATEWAY=$(pick TSUKE_GATEWAY); CREDIT=$(pick TSUKE_CREDIT)
[ -n "$CREDIT" ] || { echo "$OUT" >&2; exit 1; }
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
cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$POOL_MANAGER" >/dev/null
cast send --rpc-url "$RPC" --private-key "$OWNER_KEY" $USDG 'approve(address,uint256)' "$VAULT" 250000000000 >/dev/null
TX_LP_DEPOSIT=$(cast send --rpc-url "$RPC" --private-key "$OWNER_KEY" "$VAULT" 'deposit(uint256,address)' 250000000000 "$OWNER" --json | jq -r .transactionHash)

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
  "usdg": "$USDG",
  "weth": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  "owner": "$OWNER",
  "underwriter": "$UNDERWRITER",
  "forwarder": "$FORWARDER",
  "demoCustomer": "$CUSTOMER",
  "demoMerchant": "$MERCHANT",
  "installmentInterval": $INTERVAL,
  "gracePeriod": $GRACE,
  "seedTxs": {"lpFund": "$TX_LP_FUND", "lpDeposit": "$TX_LP_DEPOSIT", "customerUsdg": "$TX_CUST_USDG", "customerNvda": "$TX_CUST_NVDA", "customerTsla": "$TX_CUST_TSLA", "customerAapl": "$TX_CUST_AAPL"}
}
JSON
cat "$ROOT/.fork/deployment.json"
