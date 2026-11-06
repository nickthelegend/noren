# Noren on 1inch Aqua + SwapVM (Robinhood Chain)

Noren uses 1inch Aqua and SwapVM as its liquidity and liquidation layer on Robinhood Chain, where the Stock Token collateral lives.

- **Makers** keep USDG in their own wallets. A maker can be a merchant with idle USDG, an LP, or the Noren vault itself. Each maker ships an Aqua strategy whose SwapVM program buys Stock Tokens or ETH at the Chainlink price minus a spread, and resells them at the Chainlink price plus a spread. The spread is the maker's trading fee.
- **Pay with stocks:** NVDA, TSLA, AAPL or ETH paid at checkout is sold to the best maker through SwapVM. The maker pays the merchant USDG straight from its wallet.
- **Pay later is Pay in 3.** If a plan defaults (two missed payments, or the collateral falls below 110% of the debt), its Stock Token collateral is sold to makers through SwapVM. The proceeds repay the lender pool, the keeper gets its bonus in collateral, and the rest goes back to the borrower.

Everything below runs on a **local Anvil fork of Robinhood Chain mainnet (chain 4663)**. The official Aqua registry and SwapVM router are at their real addresses, alongside real USDG, WETH, Stock Tokens and Chainlink feeds. No mainnet transaction is ever sent, and the contracts are unaudited.

Powered by SwapVM — © Degensoft Ltd 2025. See [License](#license).

## Official contracts used

| Contract | Address on Robinhood Chain 4663 | How Noren uses it |
| --- | --- | --- |
| 1inch Aqua registry | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` | Used as deployed (forked): `ship`, `dock`, `safeBalances`, `rawBalances`, and `pull`/`push` during swaps |
| 1inch SwapVM router | `0x111111338c5091E8440b67B168bAe16a668AC0De` | Verified on the fork: `eip712Domain()` = "1inch SwapVM v1.0" / "1.0.2", `AQUA()` = the registry. A fork test swaps an upstream x·y=k Aqua strategy through it |
| Noren SwapVM router (modified SwapVM, allowed by the prize rules) | CREATE2 on the fork (`deployment.json` → `swapRouter`) | The same AquaSwapVMRouter v1.0.2 plus one instruction, deployed against the official Aqua registry |

**Which SwapVM is deployed.** The router on Robinhood Chain is **AquaSwapVMRouter** from SwapVM v1.0.2 (AquaOpcodes, 34 opcodes), not the full SwapVMRouter. We compiled v1.0.2 (commit `32c687c`) with the upstream settings. The runtime bytecode is 20,541 bytes, the same length as the deployed code, and it is byte-identical apart from immutables, metadata and 55 one-byte internal function-ID constants in the opcode dispatch table. Those IDs depend on source-path ordering in via-IR.

**No oracle instruction exists in the deployed set.** `OraclePriceAdjuster` is in the v1.0.2 sources but is not wired into any router's opcode table, and AquaOpcodes has no `LimitSwap`. It also only nudges another instruction's price, and it has no market-hours calendar, no Stock Token `uiMultiplier` and no quote-token depeg check. So Noren adds its own instruction and redeploys a modified router.

The deployed Aqua bytecode (5,619 B) belongs to a later Aqua build than the 0.1.0 `IAqua` that SwapVM v1.0.2 compiles against. The functions SwapVM and Noren call have the same signatures and behaviour. The official router itself uses this registry on mainnet.

## Architecture

```
                         Robinhood Chain mainnet fork (4663)
 customer ──pay(NVDA)──► NorenGateway ──► NorenLiquidity ──swap()──► NorenAquaSwapVMRouter
                              │             (registry,          │  program: Salt + NorenOraclePeg
                              │              best quote,        │  reads Chainlink NVDA/USD, USDG/USD,
                              │              fee book)          │  NVDA.uiMultiplier(), maker balance
                              │                                 ▼
                              │                       official Aqua 0x1111113c…
                              │              pull(maker → merchant, USDG)   push(taker → maker, NVDA)
                              │                                 │
                              ▼                                 ▼
             vault fallback (no maker)                maker wallet (USDG ↔ NVDA inventory)

 keeper ──liquidatePlanViaAqua──► NorenCredit ──collateral──► NorenLiquidity.liquidate
                                       │                   ├─ sell to best maker (SwapVM) → USDG to NorenVault
                                       │                   ├─ bonus (5% of debt, in collateral) → keeper
                                       └─ rest of collateral → borrower
```

| Component | License | Location |
| --- | --- | --- |
| `NorenOraclePeg` (SwapVM instruction, opcode 34) | SwapVM-1.1 | `packages/aqua/swapvm-ext/src/instructions/NorenOraclePeg.sol` |
| `NorenAquaSwapVMRouter` (AquaOpcodes table + NorenOraclePeg) | SwapVM-1.1 | `packages/aqua/swapvm-ext/src/routers/NorenAquaSwapVMRouter.sol` |
| `NorenLiquidity`: builds canonical maker orders, keeps the strategy registry, routes to the best quote, books fees, sells collateral | MIT | `packages/robinhood/contracts/src/NorenLiquidity.sol` |
| `NorenGateway`: pay with stocks/ETH through makers, vault fallback | MIT | `packages/robinhood/contracts/src/NorenGateway.sol` |
| `NorenCredit`: Pay in 3, `liquidatePlanViaAqua`, `liquidateLineViaAqua` | MIT | `packages/robinhood/contracts/src/NorenCredit.sol` |
| `NorenVault`: vault-backed Aqua strategy (owner) | MIT | `packages/robinhood/contracts/src/NorenVault.sol` |

The MIT contracts never compile SwapVM source. They call the router and Aqua through ABI interfaces (`interfaces/IAquaSwapVM.sol`). The router is deployed from its build artifact (`vm.getCode` plus the deterministic CREATE2 deployer).

## The NorenOraclePeg instruction

Program shape: `Salt(8 bytes) ‖ NorenOraclePeg(117 bytes)`. The salt lets one maker ship several otherwise identical strategies. The instruction computes the whole swap. It is an Aqua order with no signature, no hooks, and the maker as receiver.

| Arg | Bytes | Meaning |
| --- | --- | --- |
| base, quote | 20 + 20 | e.g. NVDA, USDG |
| baseFeed, quoteFeed | 20 + 20 | Chainlink NVDA/USD, USDG/USD (quoteFeed 0 values the quote token at $1) |
| baseMaxAgeOpen / baseMaxAgeClosed / quoteMaxAge | 4 + 4 + 4 | 90,000 s / 3 days / 90,000 s, taken from NorenAssetOracle |
| bidSpreadBps / askSpreadBps | 2 + 2 | maker buys at oracle·(1−bid), sells at oracle·(1+ask); ask `0xFFFF` = buy only |
| closedExtraBps | 2 | added to both spreads Saturday, Sunday and Monday before 06:00 UTC (weekend gap risk) |
| quoteMaxDepegBps | 2 | USDG/USD must be within this band of $1 (200 bps) |
| flags | 1 | `0x01` apply the live `uiMultiplier()`, `0x02` 24/5 market hours |
| minPriceUsd8 / maxPriceUsd8 | 8 + 8 | maker circuit breaker (0 = off) |

**Pricing.** One raw base unit is worth `num/den` raw quote units, where `num = price8 · uiMultiplier · 10^quoteDec` and `den = usdgPrice8 · 1e18 · 10^baseDec`. When the maker buys base, `amountOut = amountIn · num·(1−bid) / den` (floor) and exact-out uses the ceiling inverse. Selling is symmetric with `(1+ask)`. Rounding always favours the maker. A test checks that exact-in followed by exact-out never returns more than was put in, and that splitting a trade never beats a single trade.

**Data Feeds safety, on every quote and swap:**
- `decimals()` is read live.
- `answer > 0`, `updatedAt != 0`, `answeredInRound >= roundId`, `updatedAt <= now`.
- Per-asset maximum age, with a longer age inside the closed window for 24/5 stock feeds.
- The USDG depeg band.
- The optional price band.

Holidays are not in the instruction's calendar. On a weekday holiday the open-market age applies, so the strategy stops quoting once the feed is older than that (fail-closed). NorenAssetOracle keeps the owner-maintained holiday list for Noren's own checks.

**Funding check.** Aqua virtual balances are allocations, not escrow. A maker can promise more USDG than it holds, or revoke its allowance. The instruction therefore requires the output to be covered by the Aqua virtual balance (`NorenOraclePegInsufficientBalance`) and by `min(walletBalance, allowance to Aqua)` (`NorenOraclePegMakerUnderfunded`). An under-funded maker fails at quote time with a readable error, and NorenLiquidity skips it instead of failing at settlement.

## Positions

| Position | What it is on-chain | Shown by |
| --- | --- | --- |
| Maker strategy | USDG and asset in the maker's wallet, virtual balances `Aqua.balances[maker][router][strategyHash][token]`, registry entry in NorenLiquidity (fills, volume, fees) | `makerPositions(maker)`, `NorenLiquidity.balances/strategy`, `test_makerStrategySetup` |
| Two-sided inventory | Stock bought at oracle−bid is resold at oracle+ask through the same strategy (Aqua push adds it to the virtual balance) | `test_makerSellsInventoryAtOraclePlusSpread` (120 bps round trip) |
| Vault-backed maker | `NorenVault.shipAquaStrategy`: idle lender-pool USDG backs a strategy without leaving the vault. A fill pulls exactly the invoice and the stock becomes vault inventory | `test_vaultIdleUsdgBacksAMakerStrategy` (NAV grows by the fee; stops quoting when LP withdrawals leave idle USDG below a fill) |
| Pay-in-3 plan | Collateral locked in NorenCredit; 3 installments every `installmentInterval` (configurable; 14 days by default, 15 min on the demo fork) | `liquidationInfo(planId)` |
| Liquidated plan | Collateral split between the maker (sold), keeper (bonus) and borrower (rest); vault repaid | `test_missedPaymentsLiquidationSellsCollateralToMakerExactDeltas` |

## Fee flow

- **Maker:** buys at Chainlink − bid. `NorenLiquidity` books `fee = ChainlinkValue(assetIn) − usdgOut` per fill: `MakerFill` event, `strategy(h).feesUsdg`, `makerFeesUsdg(maker)`. With a 50 bps bid the fee is 0.5% of the conversion. Inventory is resold at Chainlink + ask, or held at market risk.
- **Customer:** pays the maker's bid spread instead of the vault's spread. `maxSpreadBps` (300 by default) caps what a strategy may charge Noren customers.
- **Lender pool (vault):** keeps the 3% merchant fee on Pay in 3. When it backs a strategy itself, it also earns that strategy's spread.
- **Keeper:** gets collateral worth `liquidationBonusBps` (5%) of the debt. It pays nothing up front.
- **Protocol:** Noren takes no fee on maker conversions.

## Pay with stocks

`NorenGateway._quote` asks `NorenLiquidity.bestQuoteForUsdg(asset, invoice)`. It quotes every registered strategy through `router.quote` (a static call) and skips any that revert: stale feed, under-funded, docked, or a blocklisted maker. It picks the lowest asset-in. `pay()` pulls exactly that amount from the customer and calls `sellForUsdg`, which runs `router.swap` with the merchant as the recipient. The merchant receives the full invoice from the maker's wallet, and the vault is not touched.

**Fallback.** If no maker can fill, the payment goes to the vault inventory path (Chainlink + gateway spread) when `vaultFallback` is on (the default). Otherwise it reverts with `NoMakerLiquidity(asset, amountUsdg)`. `quoteRoute()` and the SDK's `quote().route` say which route applies (`aqua-maker` / `vault` / `usdg`).

## Pay in 3 and liquidation

- `INSTALLMENTS = 3` and `MISSED_TO_DEFAULT = 2` are public constants. Installments are due at start + k·`installmentInterval` (k = 1..3), and the last one takes the rounding remainder.
- A plan is liquidatable when two installments are each past due plus grace, or when the final one is, or when the collateral value is below 110% of the outstanding debt. One missed installment that is not the last is never a default on its own (`test_oneMissedPaymentIsNotADefaultButAMissedFinalOneIs`).
- The app sentence comes from `liquidationInfo(planId)`. The liquidation price is `X = debtUsd8 · 1.10 · 1e18 · 10^dec / (amount · uiMultiplier)`. A fork test moves the real `uiMultiplier` to 0.1% above and below X and checks that `planLiquidatable` flips there. Before and after the first installment on the demo fork, it said:

  > Your 3.0023 NVDA liquidates if NVDA < $109.91 or if you miss two payments
  >
  > Your 3.0023 NVDA liquidates if NVDA < $73.27 or if you miss two payments

- `liquidatePlanViaAqua(planId)` / `liquidateLineViaAqua(lineId)` call `NorenLiquidity.liquidate`:
  - **Covered** (collateral ≥ debt × 1.05): sell exactly enough for the debt (exact-out) to the best maker. USDG goes to the vault, collateral worth 5% of the debt goes to the keeper, and the rest goes back to the borrower (credited for `claim()` if the token refuses the transfer).
  - **Underwater:** the keeper gets `amount · 5/105` and the rest is sold exact-in. Proceeds up to the debt go to the vault and the shortfall is recorded in `badDebtUsdg`.
  - **Guard:** the sale must clear within `maxLiquidationSlippageBps` (3%) of the Chainlink value, otherwise `LiquidationSlippage`. A maker quoting far below the oracle can't buy defaulted collateral cheaply. `liquidatePlan` / `liquidateLine` (the liquidator brings USDG) remain as the fallback.

## Best execution vs Uniswap v4

`bestExecution({asset, amountIn})` puts the best maker quote next to the live Uniswap v4 NVDA/USDG pool (V4Quoter `0x8Dc178eF…`, fee 0.3%, tick spacing 60) and the Chainlink value. Noren quotes Uniswap but never trades on it; conversions always go to the maker. Fork run on Nov 6:

| NVDA sold | Chainlink | Aqua maker (bid 50 bps) | Uniswap v4 |
| --- | --- | --- | --- |
| 1 | 184.75 USDG | 183.83 (−50 bps) | 184.37 (−20 bps) |
| 50 | 9,237.89 USDG | 9,191.70 (−50 bps) | 9,156.35 (−88 bps) |

The pegged maker's price does not move with size, while the pool's does. For small sales the pool was cheaper in this run. Inside the closed window, makers add `closedExtraBps` (300 in the demo).

## Tests

| Suite | Command | Result |
| --- | --- | --- |
| swapvm-ext (Foundry, 0.8.30, fresh fork, port 8761) | `sh packages/aqua/scripts/test-swapvm.sh` | **18 passed** |
| Robinhood contracts (Foundry, fresh fork) | `NOREN_RH_TEST_PORT=8762 sh packages/robinhood/scripts/test-fork.sh` | **112 passed**: the 94 existing tests (updated to Pay in 3, none removed), 1 new Pay-in-3 rule test, and 17 in `NorenAqua.t.sol` |
| Robinhood SDK and underwriter (Vitest, warmed snapshot + live mainnet reads) | `NOREN_RH_RPC=http://127.0.0.1:8765 pnpm --filter @noren/robinhood test` | **18 passed** (4 in `sdk/test/aqua.fork.test.ts`) |

The attacks covered:

| Attack | Where |
| --- | --- |
| Stale oracle: makers stop quoting, the vault refuses the asset, liquidation can't run | `test_stalePriceRefusesToQuote`, `test_staleOracleStopsMakersVaultAndLiquidations` |
| Weekend window: older stock price allowed, wider spread | `test_weekendWindowAllowsOlderStockPriceWithWiderSpread` |
| USDG depeg | `test_quoteTokenDepegRefusesToQuote` |
| Price manipulation beyond the spread | Taker can't beat the peg (`test_takerCannotBeatThePeg`); maker circuit breaker (`test_priceOutsideMakerBandRefusesToQuote`); spread cap at registration (`test_spreadAboveCapCannotRegister`); a 9% maker can't buy liquidations (`test_wideSpreadMakerCannotBuyLiquidationsCheaply`) |
| Under-funded maker | Virtual balance cap and wallet/allowance check (`test_underfundedMakerFailsAtQuote`, `test_virtualBalanceCapsTheFill`, `test_underfundedMakerSkippedThenVaultFallbackOrError`) |
| Reentrancy | A maker hook re-entering the same strategy is stopped by SwapVM's transient lock (`test_reentrantHookCannotDoubleFill`); an ETH payer re-entering the gateway from its refund is stopped by `ReentrancyGuard` (`test_reentrantEthRefundCannotPayTwice`); hooked orders can't enter Noren's registry (`test_hookedOrderCannotRegister`) |

## Final demo (on-chain token transfers on a local fork)

```
sh packages/aqua/scripts/aqua-demo.sh     # port 8760, ~2 min, stops its anvil on exit
```

The script forks mainnet, deploys Noren, seeds the maker (demo account #3) and runs ten steps. Each step prints its fork transaction hashes and the real ERC-20 deltas. A recorded run is in [`packages/aqua/demo/aqua-demo-transcript.txt`](../packages/aqua/demo/aqua-demo-transcript.txt). It was recorded before NorenLiquidity gained its ask side (`bestAskForAsset`, `buyFromMakers`), when the fork deployed it at `0xF19E8291e051c543690e5A7B8B3A4A1b41e9f992`; the current deploy puts it at `0xb5D2237d8e79Fb6A0f16ecD02F435CE7063b49EC`. Apps read the address from `packages/robinhood/.fork/deployment.json`, never from the transcript. Highlights from it (all hashes are **fork** transactions, block 107370002, not mainnet):

- Maker ships 4 strategies, e.g. `Aqua.ship` `0x8d14b67e…c760` and `NorenLiquidity.register` `0x670763f5…b2d9`.
- A 250 USDG invoice paid with 1.359921 NVDA (`0x4c8e15d8…3e5d`): merchant +250 USDG, maker −250 USDG and +1.359921 NVDA, maker fee 1.25 USDG.
- A 100 USDG invoice paid with 0.045187 ETH through the WETH maker (`0xc975c112…8e13`).
- Pay in 3: `openPlan` `0xaf3a4665…37c8`, repay `0xa66a0f57…4eba`, then two missed payments.
- `liquidatePlanViaAqua` `0xb7c254aa…ea34`: maker bought 1.087936 NVDA for 200 USDG → vault +200 USDG, keeper +0.054124 NVDA, borrower +1.857938 NVDA back, bad debt 0.
- SPY (no maker) routes to the vault. With the fallback off, the quote reverts `NoMakerLiquidity`.
- Final maker position: 2.56 USDG of spread fees over 3 fills (550 USDG volume).

## SDK (for the Noren app and web agent)

`createNorenRobinhood({ publicClient, walletClient, addresses })` from `@noren/robinhood/sdk`. `addresses` is `.fork/deployment.json`, which now includes `liquidity`, `swapRouter`, `aqua` and `makerStrategies`.

| Function | Returns |
| --- | --- |
| `quote({merchant, invoiceId, asset})` | `assetIn`, `priceUsd8`, `marketClosed`, `route` (`aqua-maker`/`vault`/`usdg`), `strategyHash` |
| `pay(...)` | as before, plus `makerFill` (maker, assetIn, usdgOut, feeUsdg) |
| `liquidationInfo(planId)` | schedule (3 installments, due and default times), `missedPayments`, `liquidationPriceUsd8`, `priceUsd8`, `bufferBps`, `message` ("Your 10 NVDA liquidates if NVDA < $X or if you miss two payments") |
| `lineLiquidationInfo(lineId)` | the same for an Arc credit line |
| `liquidatePlanViaAqua(planId)`, `liquidateLineViaAqua(lineId)` | receipt, `PlanLiquidated` / `CreditLineLiquidated`, `CollateralSoldToMakers` |
| `buildMakerStrategy`, `shipMakerStrategy`, `dockMakerStrategy` | maker onboarding: approve Aqua, ship, register / dock, remove |
| `makerPositions(maker)` | wallet USDG, total fees, per strategy: Aqua balances, fills, volume, fees, inventory value |
| `bestExecution({asset, amountIn})` | Chainlink value, maker quote, Uniswap v4 quote (or the reason it is unavailable), winner |
| `readPositions(borrower)` | plans now include `liquidation` (the `liquidationInfo` above) |

`INSTALLMENTS` and `MISSED_TO_DEFAULT` are exported, and on-chain `NorenCredit.INSTALLMENTS()` returns 3.

## License

- **SwapVM** (`LicenseRef-Degensoft-SwapVM-1.1`) and **Aqua** (`LicenseRef-Degensoft-Aqua-Source-1.1`) are source-available Degensoft licenses. Modifying SwapVM is copyleft: modified or extended parts must be published under the same license, keep the notices, carry "Powered by SwapVM — © Degensoft Ltd 2025", mark changes with dates, and ship build instructions (§3.1).
- **Noren's SwapVM modifications live only in `packages/aqua/swapvm-ext/`.** That covers the new instruction, the router, the tests that compile them, and the foundry config. The folder carries `LICENSE` (SwapVM-1.1), `LICENSES/`, `THIRD_PARTY_NOTICES.upstream` and `NOTICE`, which lists the dated changes, upstream commits and reproducible build/deploy steps. Each source file has the SPDX header and an `@custom:change` line.
- Upstream SwapVM and Aqua are pinned devDependencies (`github:1inch/swap-vm#32c687c…`, `github:1inch/aqua#b51f3b6…`) and are never edited in place.
- **Everything else stays MIT** (Copyright (c) 2026 Nivesh Gajengi). NorenLiquidity, NorenGateway, NorenCredit, NorenVault, the SDK and scripts only call Aqua and SwapVM through their published ABIs: Pure Caller Use (§2.2), and independent code is excluded from copyleft (§3.3). They never import SwapVM or Aqua source.
- This is a hackathon prototype under §4 (non-commercial use). Production use with fees above the §5 thresholds would need a Degensoft Commercial License. No endorsement by 1inch or Degensoft is implied.

## What is fork-only

- Everything runs on a local Anvil fork of Robinhood mainnet. The official Aqua and SwapVM are used as deployed. The Noren router, NorenLiquidity and the Noren contracts exist only on the fork; nothing is deployed to mainnet.
- The demo maker, keeper, customer and merchant are Anvil dev accounts, funded from the Uniswap v4 PoolManager by impersonation on the fork.
- Fork time travel stands in for two weeks of missed payments. The demo uses 15-minute installments.
- Uniswap v4 is quoted from its live pool state at the fork block and never traded.

## Risks

- **Maker inventory risk.** Makers hold the stock they buy. A price gap (weekend, earnings) is the maker's loss; `closedExtraBps` and the price band are its tools. The vault is exposed in the same way when it backs a strategy.
- **Oracle dependency.** Pricing is only as good as the Chainlink feeds. A feed that keeps reporting a wrong but fresh price is not detected beyond the maker's band and NorenLiquidity's 3% liquidation guard. Robinhood Chain has no listed L2 sequencer-uptime feed.
- **Liquidity availability.** With no maker (or only under-funded ones) a liquidation needs a USDG-paying liquidator (`liquidatePlan`). A paused Stock Token can't be sold at all.
- **Registry bound.** At most `maxStrategiesPerAsset` (8) strategies per asset are quoted on-chain, to bound gas.

## Partial Dutch-auction liquidations (NorenDutchDecay, opcode 35)

Instead of selling a defaulted plan's whole debt worth of collateral at once (with a 5% keeper bonus on top), a Dutch auction sells **only enough collateral to bring the plan back to health 1.10**. The price starts close to Chainlink and slowly gets cheaper until a keeper fills. The borrower keeps the rest of the collateral and the plan stays open.

Fork-only, like everything on this page. The instruction is in the swapvm-ext build on this branch. It is **not** in the Arc Testnet router (`0x8717…e295`, built from commit `a044e6a` with opcode 34 only). It ships with the next router redeploy.

### The instruction

`NorenDutchDecay` is opcode 35 in `NorenAquaSwapVMRouter` (opcodes 0–34 are unchanged). It is licensed SwapVM-1.1 like NorenOraclePeg, lives in `packages/aqua/swapvm-ext/src/instructions/NorenDutchDecay.sol`, and is listed with a date in the folder's `NOTICE`.

Program shape: `Salt(8) ‖ NorenDutchDecay(30) ‖ NorenOraclePeg(117, bid 0, buy-only, no weekend extra)`. Like upstream `Fee`, the instruction runs the rest of the program itself and then scales the amounts:

```
totalDiscount(t) = startBps + (capBps - startBps) · min(t - auctionStart, duration) / duration
makerDiscount(t) = totalDiscount(t) · (1 - keeperShareBps)
maker buy price  = Chainlink price · (1 - makerDiscount(t))
```

| Arg | Bytes | Meaning |
| --- | --- | --- |
| house | 20 | the auction house (NorenDutchAuction). It is the only taker accepted and the source of the auction start |
| startBps / capBps | 2 + 2 | 50 / 800 (0.5% rising to 8%). The cap is never exceeded; the instruction rejects caps above 50% |
| duration | 4 | seconds from start to cap (3,600 on the fork) |
| keeperShareBps | 2 | part of the total discount that goes to the keeper, not the maker (2,500 = 25%) |

- **Auction start.** The 32-byte taker instruction argument is the auction id (`bytes32(planId)`). The instruction reads the start on-chain with `house.dutchAuctionStart(id)`. A closed or unknown auction returns 0, which reverts (`NorenDutchDecayNoActiveAuction`), and so does a start in the future.
- **Only the house can take.** `taker != house` reverts (`NorenDutchDecayTakerNotHouse`). Nobody can sell their own NVDA to a maker at the auction discount.
- **Rounding.** Exact-in prices `amountIn − ceil(amountIn·d)`, and exact-out grows `amountIn` by a ceiling division. Both round in the maker's favour.
- **Oracle checks.** Every Chainlink check (staleness, weekend window, USDG depeg, maker funding) is NorenOraclePeg's, unchanged.
- **Router size.** To stay under EIP-170, the router is compiled with `optimizer_runs` 50 (24,546 B; 24,637 B at 200). The instruction decodes its args with shifts and calls the house with a raw `staticcall` for the same reason.

### NorenDutchAuction (MIT)

`packages/robinhood/contracts/src/NorenDutchAuction.sol` calls the router and Aqua through ABIs only, and builds the canonical Dutch maker order. NorenCredit gains `auctionSeize` (only the configured auction may call it), `cumulativeDue` and `setDutchAuction`. `repay()` now counts any part of an installment a fill already paid.

| Function | Who | What |
| --- | --- | --- |
| `buildOrder(maker, asset, salt)`, `register(asset, salt)`, `remove(hash)` | maker | ship a Dutch strategy to Aqua (USDG stays in the maker's wallet), then register it |
| `openAuction(planId)` | anyone | only when health < 1 (collateral below 110% of the debt) or two installments are missed (NorenCredit's rules) |
| `previewFill(planId, maxRepayUsdg)` | view | the fill below, as a static call |
| `fill(planId, maxRepayUsdg)` | anyone (keeper) | sells to the best Dutch maker. USDG goes straight to the lender pool, the keeper gets its bonus in collateral and pays nothing |
| `closeAuction(planId)` | anyone | closes an auction whose plan is no longer liquidatable (repaid, or the price recovered) |
| `auctionStatus(planId)`, `discountWad`, `healthOf` | view | for the app |

**How much a fill sells.** Plan health is `H = collateral value / (debt · 1.10)`. With keeper share `dk` and maker discount `dm`, removing collateral worth `R · c` repays `R`, where `c = (1 + dk) / (1 − dm)` (1.005 at the start, 1.085 at the cap). The fill repays

```
R = (target · threshold · debt − value) / (target · threshold − c)      (target 1.10, threshold 1.10)
```

That is rounded up, plus 2e-8 USD to absorb the oracle's 8-decimal floor. For an overdue plan, `R` is at least the missed installments. `R` is never more than the debt or `maxRepayUsdg`. The maker sells exactly `R` USDG for collateral `S` (exact-out), and the keeper gets `S · dk`, which is its share of the discount. So the borrower's whole cost is `discount · value sold`, with no bonus on top. Fills can repeat while the plan is still liquidatable, and the auction keeps its clock. Once a fill leaves the plan healthy and current, the auction closes.

**Limits, stated plainly.** A fill can restore the target only while collateral value ≥ `c · debt`. If a position falls further, or a fill waits until the cap, all collateral is sold (keeper share first) and the shortfall is recorded as `badDebtUsdg`, never hidden (`test_underwaterSellsAllAndRecordsBadDebt`). Fills cost the borrower least when keepers fill early.

**Guards on every fill.**
- The maker may pay no more than the oracle value of what it bought (`FillAboveOracle`) and no less than oracle · (1 − cap) (`FillBelowCap`).
- There is no fill without an open auction, and none once the plan is no longer liquidatable (`NotLiquidatable`, `AuctionNotOpen`).
- A stale feed reverts (NorenAssetOracle's rules). `auctionStatus` then sets `error` instead of showing a health.
- `nonReentrant` is on the house and on `auctionSeize`. The Dutch orders are Aqua orders without hooks, so nothing calls back during settlement.

### Demo (fork transactions)

```
sh packages/aqua/scripts/dutch-demo.sh     # port 8860, ~3 min, stops its anvil on exit (pnpm --filter @noren/aqua demo:dutch)
```

Transcript: [`packages/aqua/demo/dutch-demo-transcript.txt`](../packages/aqua/demo/dutch-demo-transcript.txt). The fork is of block 107589797, and every hash is a **fork** transaction.

1. The borrower opens a 300 USDG Pay-in-3 plan against 2.2 NVDA (NVDA $188.41, health 1.257): `openPlan` `0xa0893981…d285`.
2. NVDA's value falls 23.6%. On the fork, this is the real Stock Token multiplier admin path, impersonated (`0x9ce3056a…7b00`). Health is now 0.96.
3. For comparison, the old `liquidatePlanViaAqua` (`0x421f7146…db13`, then reverted with `evm_revert`) gives the borrower back **0.00203 NVDA**.
4. `openAuction` `0x48df1d1b…9079`. The discount climbs from 0.5% (t+0) to 1.75% (t+10 min) to 3% (t+20 min).
5. `fill` at a 3% discount (`0x8caa8fc9…257a`):
   - the maker paid 257.71 USDG for 1.83096 NVDA, straight to the vault;
   - the keeper got 0.013751 NVDA and paid nothing;
   - health is restored to **1.1**, and the auction closed.
6. The plan stays Active with **0.355288 NVDA** still locked for the borrower and 42.28 USDG left to pay. **The borrower kept 0.355288 NVDA vs 0.00203 NVDA under full liquidation**: equity $8.87 vs $0.29.

### Tests

| Suite | Command | Result |
| --- | --- | --- |
| swapvm-ext (Foundry, fresh fork) | `NOREN_AQUA_TEST_PORT=8861 sh packages/aqua/scripts/test-swapvm.sh` | **27 passed, 1 skipped** (the weekend test skips on weekdays); 10 of them in `NorenDutchDecay.t.sol` |
| Robinhood contracts (Foundry, fresh fork) | `NOREN_RH_TEST_PORT=8862 sh packages/robinhood/scripts/test-fork.sh --match-contract NorenDutch` | **16 passed** (`NorenDutch.t.sol`). The full suite was 149 of 150 on Nov 6. The failure, `test_weekendAllowsStaleStockButNotEth`, compares the live feed's age at fork time and is unrelated to this change |
| Robinhood SDK on the warmed snapshot | `NOREN_RH_RPC=http://127.0.0.1:8864 pnpm --filter @noren/robinhood test` | **20 passed** (1 in `sdk/test/dutch.fork.test.ts`) |

What the tests cover:
- the discount grows over time (`vm.warp`) and is flat at the cap;
- a partial fill restores health 1.10 exactly (1.1000000009);
- multiple fills share one auction clock;
- an overdue plan is cured by paying exactly the missed installments, and the plan then completes normally;
- the borrower keeps more than under the old full liquidation;
- no bad debt on six tested price paths;
- the sell-all path records bad debt;
- attacks:
  - a direct taker can't take the discount;
  - an early fill on a healthy plan is refused;
  - a first fill happens at the start discount and never above the oracle;
  - a fill after recovery is refused;
  - a stale price blocks fills;
  - only the auction may seize;
  - a bad schedule is rejected.

### SDK

`createNorenDutch({ publicClient, walletClient, addresses })` from `@noren/robinhood/sdk`. `addresses.dutchAuction` is the NorenDutchAuction address.

| Function | Returns |
| --- | --- |
| `auctionStatus(planId)` | `open`, `discountWad` (with maker and keeper parts), `healthWad`, `targetHealthWad`, `overdue`, `liquidatable`, `fills`, collateral and debt, `error`, `schedule`, `message` (the app sentence) |
| `previewPartialLiquidation({ planId, maxRepayUsdg? })` | `repayUsdg`, `collateralSold`, `keeperBonus`, `discountWad`, `healthAfterWad`, `collateralLeft`, `outstandingAfterUsdg`, `sellAll`, `badDebtUsdg` |
| `fillPartialLiquidation({ planId, maxRepayUsdg?, open? })` | receipt, `filled` (the `AuctionFilled` event), `preview`, `auctionClosed`; `open: true` opens the auction first |
| `openAuction(planId)`, `closeAuction(planId)` | receipt and event |
| `buildDutchStrategy`, `shipDutchStrategy({ asset, usdgAmount, salt? })` | maker onboarding: approve Aqua, ship, register |
