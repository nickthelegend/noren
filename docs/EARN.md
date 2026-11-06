# Earn and borrow in the Noren app (Robinhood Chain)

In the Noren app a customer deposits ETH, a Stock Token or USDG. The deposit earns the spread that 1inch Aqua maker strategies charge, and the customer gets a receipt token for it. They can borrow USDG against that receipt at a Chainlink-priced loan-to-value. Repaying on time and verifying with World ID raise both the LTV and the credit limit.

Code: [`packages/robinhood`](../packages/robinhood) (contracts, SDK, underwriter). Everything below runs on a **local Anvil fork of Robinhood Chain mainnet (chain 4663)**, with the real WETH, USDG, Stock Tokens and Chainlink feeds and the official Aqua registry. No mainnet transaction is ever sent, and the contracts are unaudited. Pricing rules, Pay in 3 and the Arc credit line are covered in [CREDIT.md](CREDIT.md). Makers and SwapVM are covered in [AQUA.md](AQUA.md).

## Contracts

| Contract | Role |
| --- | --- |
| `NorenDepositVault` | One ERC-4626 vault per asset: **Noren ETH deposit (nETH)**, **Noren NVDA deposit (nNVDA)**, nTSLA and nAAPL. Shares have 24 decimals (the asset's 18 plus 6 virtual decimals against the first-deposit inflation attack). The vault is the maker of its own NorenOraclePeg Aqua strategy, registered with NorenLiquidity. |
| `NorenVault` (existing) | The USDG deposit and lender pool (`nvUSDG`). Borrowers draw from it. Its NAV counts outstanding loans and accrued interest as receivables. |
| `NorenBorrow` | Locks deposit shares, lends USDG from NorenVault and computes health. Liquidation goes through Aqua makers. It is a NorenVault module and the vault's receivables source (Pay-in-3 receivables plus loans). |
| `NorenReputation` | On-chain points, milestones and tiers. It verifies two EIP-712 attestations: World ID `VerifiedHuman` and underwriter `AccountAge`. It exposes `reputationOf`, `milestonesOf` and `creditLimitOf`. |
| `NorenLiquidity` (extended) | Adds an ask side to the maker registry: `bestAskForAsset` and `buyFromMakers`. The maker's spread is booked as its fee (`MakerSale`). |

## Deposit and earn

1. **Deposit.** `deposit(assets, receiver)` takes WETH or a Stock Token. `depositETH(receiver)` takes native ETH and wraps it to WETH. The vault then calls `Aqua.push` on itself, so the strategy's virtual balance grows by the deposit. The tokens stay in the vault: Aqua records an allocation, not an escrow. NorenOraclePeg refuses any fill the vault's real balance can't cover.
2. **Ask side.** A buyer calls `NorenLiquidity.buyFromMakers` and pays Chainlink + ask: 40 bps for ETH, 60 bps for stocks, plus 300 bps while US markets are closed. The deposit vault is the cheapest ask (the demo maker charges 50 and 80), so it fills. The buyer's USDG lands in the vault and is pushed into the strategy's USDG virtual balance.
3. **Bid side.** With that USDG the vault buys the asset back at Chainlink − bid: 25 bps for ETH, 40 for stocks. This happens, for example, when a Noren shopper pays a merchant with ETH: NorenGateway routes to the best bid, which is the vault's.
4. **Yield.** Each fill adds exactly its spread to the vault's value at that moment's Chainlink price. NorenLiquidity books every fill it routes (`strategy(h).feesUsdg`), and `feeBook()` sums them over every strategy the vault has shipped. With the fork's feeds frozen, the share price rises by exactly the booked fees (`test_yieldFromRealMakerFills`), and time alone earns nothing.
5. **NAV.** NAV in the asset is the asset held plus the USDG held, converted at the validated Chainlink price. While the vault holds USDG from a sale, that part also moves with the asset's price (an inventory mark). `stats()` reports it separately from the fees.

**APY.** `vaultStats(asset)` reports realised fees ÷ NAV × (one year ÷ the observed window, from first deposit to now), simple, not compounded. The label says exactly that: *"Realised: 3.67 USDG of maker fees from 2 fills over 1.0 h, annualised (simple). Not a forecast."* A short window with a few fills annualises to a very large number (1,444% in the demo below), so the app should lead with the realised fees and the window. `previewYield` applies the same realised rate to a planned deposit and says it is not a promise.

**Withdraw.**
- `withdraw` and `redeem` pay out the asset, up to what the vault holds now.
- If the vault has sold some of the asset and holds USDG until it buys back, a larger request fails with `LiquidityInUse(requested, availableNow, usdgHeld)`. The SDK turns that into a sentence with the amounts.
- `redeemInKind(shares)` always works. It pays the shares' pro-rata asset and USDG and needs no price, so it also works while a feed is stale.
- `redeemETH` unwraps nETH to native ETH. It is reentrancy-guarded (`test_reentrantEthRedeemIsBlocked`).

**USDG deposits** go to the lender pool, `NorenVault` (nvUSDG). It earns borrow interest (`borrowRateBps`, 5% a year, simple between interactions), the 3% Pay-in-3 merchant fee, and any vault-backed maker strategy the owner ships. Withdrawals are capped at idle USDG. While USDG is lent out, OpenZeppelin's `ERC4626ExceededMaxWithdraw` names the amount available.

## Borrow

- **Lock** deposit shares in `NorenBorrow` with `lock(vault, shares)`. Locked shares stay in their vault and keep earning (`test_lockedSharesKeepEarningAndRaiseTheLimit`).
- **Borrow limit** = the locked shares' Chainlink value × the account's LTV.
  - The value is the shares' in-kind asset plus their USDG, priced by NorenAssetOracle with all its rules: feed decimals read live, staleness, the 3-day weekend window for stock feeds, `uiMultiplier`, and the USDG depeg band.
  - New borrowing uses the closed-market haircut (stocks count 5% less while US markets are closed).
  - The LTV is **66%** at base and rises with reputation to 70%, 75% and at most **80%** (`MAX_LTV_BPS`, enforced in NorenBorrow too). Nick's example holds: deposit 1 ETH and, at the top tier, borrow up to 80% of its Chainlink value and not one wei more (`test_ltvTiersFromMilestonesUpToThe80Cap`).
- **Health factor** = collateral value without the haircut × 85% ÷ debt. Below 1.0 the position is liquidatable, so at 80% LTV the buffer is 5.9% (HF 1.0625). `liquidationPriceUsd8(account, vault)` gives the asset price at which HF reaches 1, holding other collateral and the vault's USDG part constant. The SDK's sentence reads: *"Your 0.8807 ETH deposit is liquidated if ETH < $2,071.11 (now $2,219.61)"*.
- **Repay** with `repay(account, amount)`; anyone can repay for an account, and `type(uint256).max` repays everything. Interest is paid first. **Unlock** (a partial withdrawal) is allowed while the remaining debt stays within the remaining limit.
- **Liquidation** with `liquidateViaAqua(account, vault)`:
  1. The seized shares are redeemed in kind. Their USDG repays the debt first.
  2. The asset goes through `NorenLiquidity.liquidate`, the same path as `liquidatePlanViaAqua`. Proceeds go to the lender pool and the keeper gets 5% of the debt in the asset. The sale must clear within 3% of Chainlink.
  3. The rest goes back to the borrower, as the underlying asset. Anything a blocklisted account can't receive is credited for `claim`.
  4. Debt left with no collateral is written off as `badDebtUsdg`, and the pool's NAV drops by it.

## Reputation, milestones and credit

Points (computed live from on-chain sources):

| Source | Points | Where it is read |
| --- | --- | --- |
| World ID verified human | +50 | `VerifiedHuman` attestation (below) |
| On-time Pay-in-3 installment | +10 each, first 12 count | `NorenCredit.history().onTime` |
| Loan repaid in full (principal ≥ 10 USDG, open ≥ 1 day) | +25 each, first 4 count | `NorenBorrow.record()` |
| Account older than 30 / 180 days | +20 / +20 | `AccountAge` attestation signed by the underwriter key from its mainnet history scan |
| Late installment | −15 | `NorenCredit.history().late` |
| Liquidation (Pay in 3, Arc line or loan) | −60 | `NorenCredit.history().defaults` + `NorenBorrow.record()` |

| Tier | Needs | Borrow LTV | Credit-limit multiplier |
| --- | --- | --- | --- |
| 0 | - | 66% | 1x |
| 1 | 40 points | 70% | 1.25x |
| 2 | 75 points and World ID | 75% | 1.5x |
| 3 | 100 points, World ID, and a repaid loan or three on-time installments | 80% | 2x |

Milestones (`milestonesOf`, a bitmask; the SDK returns labels):
- verified human
- account older than 30 days, and older than 180 days
- three on-time installments
- first loan repaid, and three loans repaid
- clean record (no late payments or liquidations)

Without World ID an account stays at tier 1 or below, whatever else it does. Tiny loans and loans repaid the same day don't count (`test_tinyOrSameDayLoansDoNotFarmMilestones`).

**`creditLimitOf(account)`** = Σ deposit value (wallet and locked shares, Chainlink, haircut) × the tier LTV, plus the **World ID starter line**: 25 USDC, unsecured, on Arc. The World ID server opens that line on Arc through the CRE bridge ([WORLD.md](WORLD.md), [BRIDGE.md](BRIDGE.md)). The registry only counts it and never opens it. The starter amount is owner-settable and can never go above 100 USDC.

**Pay-in-3 limit.** The underwriter multiplies the limit it attests to NorenCredit by `limitMultiplierOf(account)`, and `/attest` returns the multiplier and the base limit. NorenCredit's collateral rule (collateral ≥ limit × ratio at open) is unchanged. The multiplier applies after the 0G or deterministic decision, so it can raise a limit above that decision's cap. Collateral still bounds the risk.

### Credit-limit growth (demo numbers, from the contracts)

1 ETH and 2 NVDA deposited, nothing else (`packages/robinhood/demo/earn-demo-transcript.txt`):

| Step | LTV | Credit limit (USD, 6 dp) | Pay-in-3 multiplier |
| --- | --- | --- | --- |
| Deposit only | 66% | 1,708.82 | 1x |
| + World ID | 70% | 1,839.95 (incl. 25 USDC starter) | 1.25x |
| + three on-time Pay-in-3 installments | 75% | 1,969.59 | 1.5x |
| + a repaid loan | 80% | 2,099.23 | 2x |

That is +22.8% on the same deposits. The Foundry test `test_creditLimitGrowthStory` checks the same four steps.

## World ID attestation (production path)

1. The World ID server (`packages/world-id`) verifies the proof with World's `/api/v4/verify`. The proof is bound to the wallet through `signal = wallet`, and the server checks the nullifier.
2. Then it calls `recordVerifiedHuman({ publicClient, addresses, account, nullifier, relayer? })` from `@noren/robinhood/sdk`. That function:
   - signs EIP-712 `VerifiedHuman(address account, bytes32 nullifierHash, uint64 expiry)` with domain `NorenReputation` / `1` / chain id / registry address. It first checks that the signer is `worldIdSigner()`, that the local digest equals `hashVerifiedHuman()`, that the nullifier is unused and that the account is not yet verified.
   - relays `verifyHuman` and returns the reputation, milestones and credit limit before and after. The new LTV tier and limit apply in the same block.
3. **Key.** The key is `NOREN_WORLD_ATTESTER_KEY`, held by Noren's server in the gitignored `.env`. It is a Noren key, not World's RP signing key. The fork deployment sets `NorenReputation.worldIdSigner` to its address. Anvil's published key #7 is used only when no key is configured, and only on a loopback chain 4663/46630; anywhere else signing fails with "Setup required: NOREN_WORLD_ATTESTER_KEY".
4. **On-chain rules.** The registry enforces one nullifier per account and one account per nullifier (`NullifierUsed`, `AlreadyVerified`). An expired attestation fails with `AttestationExpired`, a wrong key with `BadSignature`, and a signature relayed for another account also with `BadSignature`. A replay fails with `NullifierUsed`. Nullifiers arrive as decimal strings and are stored as bytes32 (`nullifierToBytes32`).

The underwriter's `POST /attest-age {account}` signs `AccountAge` from the mainnet first-activity scan. The signed first-seen time is now minus the scanned age in whole days, a lower bound. It only moves earlier.

## SDK (`createNorenEarn({ publicClient, walletClient, addresses })`)

`addresses` is `.fork/deployment.json`, which now has `reputation`, `borrow`, `depositVaults` and `worldIdSigner`.

| Function | What it does |
| --- | --- |
| `vaults()` | nETH, nNVDA, nTSLA, nAAPL: name, symbol, decimals, asset |
| `deposit({asset, amount})` | `NATIVE_ETH` sends ETH; tokens are approved, then deposited. Returns the shares |
| `withdraw({asset, amount?, shares?, inKind?, asEth?})` | "Liquidity in use: …" with the amounts, or the in-kind / ETH exits |
| `vaultStats(asset)` | balances, NAV, assets per share, fees, fills, volume, `realisedApyBps`, `apyLabel` |
| `previewYield({asset, amount, days})` | shares, plus the gain at the realised rate (labelled) |
| `lock`, `unlock`, `borrow({amountUsdg, lockShares?})`, `repay({amountUsdg \| 'all'})` | the loan flow; the over-limit error states debt and limit |
| `health(account)` | debt, collateral (plain and haircut), limit, available, LTV, health factor, locked positions |
| `liquidationPrice(account, asset)` | price, buffer and the app sentence |
| `liquidateLoanViaAqua({borrower, asset})` | keeper action |
| `buyAsset({asset, amountOut})` | buy from makers at Chainlink + ask (the vaults' ask side) |
| `reputation(account)`, `milestones(account)`, `creditLimit(account)` | points breakdown and next-tier hint; milestone labels; secured + starter + Pay-in-3 terms and multiplier |
| `signVerifiedHuman`, `recordVerifiedHuman`, `applyVerifiedHuman`, `applyAccountAge`, `nullifierToBytes32` | World ID and account-age attestations |

Node-only: `loadWorldAttesterKey()` reads `NOREN_WORLD_ATTESTER_KEY` from the environment or from the main checkout's `.env`. It never logs the key.

## Demo (fork transactions)

```
sh packages/robinhood/scripts/fork-snapshot.sh         # NOREN_RH_SNAPSHOT_TMP_PORT / NOREN_RH_FORK_PORT pick the ports
sh packages/robinhood/scripts/serve-snapshot.sh
NOREN_RH_RPC=http://127.0.0.1:<port> pnpm --filter @noren/robinhood exec tsx scripts/earn-demo.ts
```

The demo reverts the chain when it finishes. The recorded run is [`packages/robinhood/demo/earn-demo-transcript.txt`](../packages/robinhood/demo/earn-demo-transcript.txt), on the snapshot of mainnet block 107405037. Every hash below is a **fork** transaction:

- `depositETH` 1 ETH → nETH: `0x9cad4717…a20be4a`.
- A trader buys 0.3 ETH from nETH at Chainlink + 40 bps for 668.56 USDG, a fee of 2.66 USDG: `0xe2fffd7b…e46c807`.
- A shopper pays a 400 USDG invoice with ETH. The nETH vault buys it at Chainlink − 25 bps, a fee of 1.00 USDG: `0x3f8f9359…5da926df`. Result: 1.001652 ETH per nETH.
- `verifyHuman`, signed by the configured attester `0x55B3…c02C`: `0xf880f869…ed6f7`.
- Three on-time installments: `0x149fdea5…e2629`. A 200 USDG loan repaid with 0.000306 USDG interest: `0x9a760b40…a6be`.
- A borrow at 80% (1,778.66 USDG on 0.8807 ETH + 268.56 USDG of nETH): `0x870cc691…892a`. Health factor 1.0625. Limit + 1 wei is refused.
- `liquidateViaAqua` after an 8% NVDA cut through the real `uiMultiplier` role (impersonated on the fork): the lender pool was repaid 295.57 USDG, 1.74787 NVDA went to makers, the keeper bonus was 0.086957 NVDA, and there was no bad debt. Reputation fell from 105 to 45 points.

Fork-only settings, all labelled in the transcript:
- The loan-milestone minimum age is 15 minutes instead of 1 day, because the frozen USDG/USD feed would go stale after a day.
- The NVDA drop is a `uiMultiplier` change made by the real role holder, impersonated.

## Tests

| Suite | Command | Result |
| --- | --- | --- |
| Foundry, fresh mainnet fork | `NOREN_RH_TEST_PORT=8770 sh packages/robinhood/scripts/test-fork.sh` | **134 passed** (112 existing, none changed; 22 in `NorenEarn.t.sol`) |
| Vitest, warmed snapshot + live mainnet reads | `NOREN_RH_RPC=http://127.0.0.1:8772 pnpm --filter @noren/robinhood test` | **19 passed** in 7 files (new: `sdk/test/earn.fork.test.ts`) |
| Typecheck | `pnpm --filter @noren/robinhood typecheck` | passes |

`NorenEarn.t.sol` covers:
- **Yield:** receipt shares backing Aqua; yield from real ask and bid fills equal to the booked fees; the stock vault earning its spread; a share price unmoved by later deposits.
- **Exits:** liquidity in use and the in-kind exit; in-kind redemption under a stale feed; reentrant `redeemETH` blocked.
- **Borrow:** 66% base LTV; tiers up to the 80% cap; milestone farming refused; locked shares keep earning; partial unlock only while healthy; the lender NAV counting loans and interest; lender withdrawals capped while USDG is lent.
- **Liquidation:** at 0.1% either side of the liquidation price through Aqua (exact deltas); underwater bad debt.
- **Reputation and attestations:** late payment and liquidation penalties; World ID wrong key, tampered, replayed, second wallet, second nullifier and expired; account age signer and monotonicity; `creditLimitOf` with the starter; vault allow-list and caps; the credit-limit story.

## Risks

- **Inventory.** A deposit vault holds USDG between a sale and the buy-back. A price move in that window is a mark-to-market gain or loss for depositors, not a fee. A vault that sold most of its asset can only be exited in kind until it buys back.
- **Oracle.** Every valuation depends on the Chainlink feeds and NorenAssetOracle's rules. A stale feed blocks deposits (when the vault holds USDG), borrowing and liquidation, which fail closed. In-kind exits still work.
- **Gap risk.** The liquidation buffer at 80% LTV is 5.9%. A larger gap, for example a Monday open on a stock, leaves bad debt in the lender pool.
- **Trusted keys.** The World ID attester key and the underwriter key can grant milestones. A leaked attester key lets one person collect many World ID verifications: each still needs a fresh nullifier, but the server checks those, not the chain. The owner can rotate the signer (`setWorldIdSigner`).
- **Interest.** Interest is a flat owner parameter (5%), not a utilisation curve.
