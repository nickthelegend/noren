# Noren credit on Robinhood Chain

Noren's Robinhood Chain module lets a customer pay a merchant with USDG, ETH or a Robinhood Stock Token, buy now and pay in four USDG installments against stock or ETH collateral, and open a USDC credit line that a Chainlink CRE workflow carries to Arc, where it can be spent at Noren merchants.

Code: [`packages/robinhood`](../packages/robinhood) (package `@noren/robinhood`). Everything below runs on a **local Anvil fork of Robinhood Chain mainnet (chain 4663)** with the real USDG, WETH, Stock Tokens and Chainlink feeds. No mainnet transaction is ever sent. The contracts are unaudited.

## Contracts

| Contract | Role |
| --- | --- |
| `NorenAssetOracle` | Chainlink Data Feeds pricing with the safety rules below, Stock Token `uiMultiplier`, market-hours calendar, Stock Token pause/blocklist pre-checks |
| `NorenVault` | ERC-4626 USDG vault (`nvUSDG`, 12 decimals). LPs fund merchant payouts. Holds the assets customers pay with as inventory and sells them back at the oracle price plus a spread. NAV = idle USDG + Pay-in-4 receivables + inventory at oracle prices. Withdrawals are capped at idle USDG |
| `NorenGateway` | Merchant invoices in USDG. `pay(invoiceId, merchant, asset, maxAssetIn)` with USDG, native ETH (`asset = address(0)`) or a Stock Token, plus `payWithPermit` (EIP-2612) |
| `NorenCredit` | EIP-712 underwriting, Pay in 4, liquidations, and the Arc credit line (`openCreditLine`, `onReport`, `closeCreditLine`) |

Source: `packages/robinhood/contracts/src`. Addresses of the Robinhood mainnet tokens, feeds and the real role holders used on forks are in `contracts/script/RobinhoodMainnet.sol`.

### Pricing rules (`NorenAssetOracle`)

- `decimals()` of every feed is read on every call and the answer is normalised to 8 decimals.
- The answer must be positive, `updatedAt` non-zero and not in the future, and `answeredInRound >= roundId`.
- Each asset has its own maximum age. USDG/USD and ETH/USD: 90,000 s (the 86,400 s heartbeat plus one hour) at all times.
- Stock feeds (24/5) also get 90,000 s while markets are open, and 3 days inside the closed window: Saturday and Sunday (UTC), Monday until 06:00 UTC, and owner-marked holidays plus six hours after.
- New risk taken while markets are closed gets a 5% haircut: payments need 5% more stock, collateral counts 5% less. Health checks for liquidation use the unhaircut price, so a weekend alone never makes a position liquidatable.
- Every USDG conversion requires USDG/USD within 2% of $1 (`UsdgDepeg` otherwise). A USDG-to-USDG payment does not touch any feed.
- Stock Token value = raw amount × `uiMultiplier()` / 1e18 × price. The multiplier is read live. It is exactly 1e18 for TSLA and AMZN (no dividends) and above 1e18 for dividend payers (NVDA 1.000775, SPY 1.001718 on Nov 6), so the feed prices one share and one raw token is `uiMultiplier` shares.

### Stock Token behaviour observed on the fork

The tokens are beacon proxies (beacon and access registry `0xe10b6f6B275de231345c20D14Ab812db62151b00`). Role holders were found from `RoleGranted` logs and confirmed with `eth_call` simulations, then impersonated only on forks:

| Behaviour | Real role holder | Noren handling |
| --- | --- | --- |
| Registry blocklist (`isBlocked`, `blockAccounts`) stops sends and receipts | `0x913cA87347391218e5De2C17c5A0AEba8B0b28fD` | Readable `AccountBlocked` before transfers. Collateral returned to a blocked borrower is credited for `claim()` instead of reverting, so repayment and CRE reports can never be blocked |
| `pause()` stops all transfers | `0xFCcF56B674113d9C4eb0F9B3370930ceD9E6Ab23` | Readable `AssetPaused`. Liquidation of paused collateral is impossible until unpause (documented risk) |
| `updateMultiplier()` changes value immediately | `0x92905e8d0e2301BA143215B8D86D63fFD4188143` | Live read on every valuation; tests use it as a real price-drop path |
| EIP-2612 `permit` (domain version "1") | - | `payWithPermit` |

## Pay in 4

1. The underwriter signs `CreditAttestation(address borrower,uint8 tier,uint256 limitUsdg,uint16 collateralRatioBps,uint256 nonce,uint64 expiry)` with EIP-712 domain `NorenCredit` / `1` / chain id / `NorenCredit` address. Anyone may relay it with `applyAttestation`. Nonces are sequential per borrower, so an attestation applies once and an older, more generous one can't be replayed after a downgrade. The ratio can't go below the liquidation threshold plus 10 points (120%). The profile expires with the attestation.
2. Repayment history moves the tier from the attested baseline: every two clean plans lift it a step, each late installment drops it one, each liquidation drops it two. A step is ±10 percentage points of collateral and ∓25% of the limit, and tier 0 means no credit.
3. `openPlan(invoiceId, merchant, collateral, amount)` checks the limit and collateral ≥ invoice × ratio, locks the collateral (ETH is wrapped to WETH), marks the invoice paid and has the vault pay the merchant the invoice minus a 3% merchant fee (the LPs' yield).
4. Installments are due at start + k × interval (production 14 days; tests use 15 minutes). `repay(planId, count)` / `repayWithPermit` pull USDG to the vault. The last installment returns the collateral.
5. A plan is liquidatable when an installment is unpaid after the grace period (production 3 days) or the collateral value is below 110% of the debt. The liquidator pays the whole outstanding USDG to the vault and receives collateral worth the debt plus 5%. The rest goes back to the borrower. If the collateral is worth less than that, the liquidator takes all of it and pays its value / 1.05, and the shortfall is recorded as `badDebtUsdg`.

## Arc credit line (fixed interface)

- `openCreditLine(collateral, amount, limitUsdc6, expiry)` locks collateral at the borrower's tier ratio (USDC valued at $1.00: Robinhood Chain has no USDC feed), uses the limit from the borrower's credit and emits `CreditLineOpened(address indexed borrower, bytes32 indexed lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8)`.
- `onReport(metadata, report)` accepts only the configured CRE forwarder. `report = abi.encode(bytes32 lineId, uint256 drawnUsdc6, uint256 repaidUsdc6, uint64 asOf)`. `asOf` must increase strictly (replay protection) and may be at most 300 s in the future. The owner can also pin the CRE workflow ID and owner, decoded from `metadata` as in Chainlink's `ReceiverTemplate`. `supportsInterface` reports `IReceiver` and `IERC165`.
- `utilisation(lineId)` returns the last reported `(drawn, repaid, asOf)`; the CRE bridge reads it before writing Arc activity back.
- A line is liquidatable when Arc debt is outstanding after expiry plus grace, or the collateral value is below 110% of it.
- Closing has two steps so collateral can't leave while Arc debt is in flight. `closeCreditLine` emits `CreditLineClosed(bytes32 indexed lineId)` (the bridge should zero the Arc limit). The collateral comes back once an Arc report dated at or after the close shows `repaid >= drawn`. That report settles the line inside `onReport`, or the borrower calls `closeCreditLine` again. Liquidation also emits `CreditLineClosed`.

**Bridge requirement beyond the fixed interface:** the CRE workflow should also trigger on `CreditLineClosed` (Robinhood). It should write `limitUsdc6 = 0` to `NorenCreditLine` on Arc and push a fresh `(drawn, repaid, asOf)` report back. Without that report a closed line whose Arc balance never changes waits forever.

## Underwriter

`packages/robinhood/underwriter` builds a wallet history, decides terms and signs the EIP-712 attestation. Every factor in the response names its source:

| Factor | Max | Source |
| --- | --- | --- |
| Account age | 25 (linear 7→180 days) | Robinhood **mainnet**: earliest inbound USDG/WETH/Stock Token `Transfer` via `eth_getLogs` in 10M-block windows. Ranges over the 10,000-log cap are bisected. The result is a lower bound, cached 10 min, and the scan has a 30 s budget (`NOREN_RH_AGE_SCAN_MS`). A wallet with nonce 0 and no token balance is `unknown` without scanning. Busy bot addresses can exhaust the budget and are then `unknown`. Blockscout PRO is used only if `BLOCKSCOUT_API_KEY` is set |
| Transaction count | 20 (log scale, 500 txs) | Robinhood **mainnet** `eth_getTransactionCount` |
| Stock Token holdings | 25 ($10,000) | the **contract chain** (`NOREN_RH_RPC`: the fork in dev, mainnet in production): `balanceOf` × `uiMultiplier` × Chainlink price |
| Total holdings incl. ETH/USDG | 10 ($25,000) | contract chain, same method |
| Noren repayment record | 20 | contract chain: `InstallmentPaid` / `PlanRepaid` / `PlanLiquidated` / `CreditLineLiquidated` events and `history()` |

Why no binary search for age: the public RPC prunes state older than ~10 minutes (`historical state … is not available`, measured Nov 6), so old nonces and balances can't be read. The public Blockscout API returns a Cloudflare challenge (HTTP 403) to scripts, and Blockscout PRO returns HTTP 402 without a key, so the underwriter doesn't depend on either. An unknown factor scores 0 and says why.

**Deterministic score.** Score → tier: <30 → 0, 30–49 → 1, 50–64 → 2, 65–79 → 3, ≥80 → 4. Limits are 250 / 1,000 / 2,500 / 5,000 USDG plus 10% of stock holdings (capped at 2× base), and collateral ratios are 150 / 140 / 130 / 125%. Any liquidation caps the tier at 1.

**Collateral-only floor.** History can only improve terms. A wallet that holds Stock Tokens on the contract chain always gets at least tier 1: 150% collateral and a limit of min(250 USDG, 50% of the stock's Chainlink value). A brand-new wallet can therefore open a fully secured line, and the contract still enforces collateral ≥ limit × ratio at open. A wallet with no Stock Tokens and no history is declined, and the response lists every factor.

**0G credit check.** Each `/attest` first runs `creditCheck(featuresFromHistory(history))` from `@noren/ai-underwriter` (sealed model on 0G Private Computer, see [0G.md](0G.md)). Its policy caps (tier limits 500/2,000/5,000/10,000 USDG, ratio floors 150/140/130/125%, never below NorenCredit's `minCollateralRatioBps()` = 120%) contain both the deterministic tiers and the floor. `attestationLogEntry(check)` with the 0G request ID is logged and the decision is appended to `.fork/credit-decisions.jsonl`. Without `ZG_PC_API_KEY`, 0G returns "Setup required". The response then carries `decision.source = "deterministic-score"` (or `"collateral-floor"`) and the 0G refusal, and never claims 0G ran. Any other 0G refusal is final except for the fully secured floor.

**Signing.** The key comes from `NOREN_RH_UNDERWRITER_KEY`. Only on a loopback RPC whose chain id is 4663 or 46630 (the fork re-tagged as Robinhood testnet for the CRE simulator) does it fall back to Anvil's published key #9, and the response says so. The EIP-712 domain uses the chain id the RPC reports, which is the contract's `block.chainid`. Before signing, the underwriter checks the signer equals `underwriter()`, the ratio is at least `minCollateralRatioBps()`, and its digest equals `hashAttestation()` on-chain.

HTTP (port 8721): `GET /health`, `GET /score/:address`, `POST /attest {"borrower": "0x..."}`.

## EIP probes (`pnpm --filter @noren/robinhood probe`, Nov 6 2026)

| EIP | Result |
| --- | --- |
| EIP-2612 permit | **Supported.** USDG (domain "Global Dollar", version 1, standard `PERMIT_TYPEHASH`) and Stock Tokens (`eip712Domain()` version 1). Permit, `payWithPermit`, `repayWithPermit` and `depositWithPermit` pass on the fork |
| EIP-7702 | **Accepted by the live sequencer's RPC:** `eth_estimateGas` for a type-4 transaction with a signed authorisation returned 46,382 gas (21,000 + 25,000 per empty-account authorisation), nothing broadcast. On the fork the delegation indicator `0xef0100‖WETH` was installed. Noren does not depend on 7702 yet |
| EIP-8141 | **Not available.** Frame transactions exist only on an EF devnet, not on Robinhood Chain or Arc |

`ArbSys.arbOSVersion()` returns 116 on Robinhood Chain.

## Local chains

The Robinhood public RPC is not an archive node. It serves state for roughly the last 5,000–10,000 blocks (about 10–15 minutes at ~9 blocks/s). After that an Anvil fork fails on any slot it has not cached (`historical state … is not available`). So:

- **Tests** always start a fresh fork: `sh scripts/test-fork.sh` (port 8723, stopped on exit).
- **Demos and SDK tests** use a warmed snapshot. `sh scripts/fork-snapshot.sh` forks mainnet on 8722, deploys with CREATE2 (salt `noren-robinhood-v1`) and seeds balances from the Uniswap v4 PoolManager (a real holder). It then simulates every demo flow with state-diff recording (`Warm.s.sol`, no broadcast) and writes each account and storage slot those flows read, at its real fork-block value, into the fork (`apply-warm.ts`). That step is needed because Anvil's dump keeps only state touched by its own transactions or `anvil_set*`. Finally it dumps the state. `sh scripts/serve-snapshot.sh` serves it on 8720 with no upstream. State that was never warmed reads as zero, which is correct for fresh addresses; extend `Warm.s.sol` for new flows.
- The deploy script and the underwriter also accept chain id 46630 on a loopback fork, for the web stack's `anvil_setChainId(46630)` (CRE Robinhood-testnet simulation).

Demo accounts (Anvil published keys, local only): #0 owner and LP (250,000 USDG in the vault), #1 customer (5,000 USDG, 20 NVDA, 10 TSLA, 10 AAPL, ETH), #2 merchant, #8 stand-in CRE forwarder, #9 underwriter signer.

## Risks

- **Vault inventory risk.** The vault buys stock and ETH at the oracle price and holds it. A fall in price before it is resold is an LP loss. The spread (0.5% stocks, 0.3% ETH) and the weekend haircut are the only buffer. There is no on-chain hedge or DEX exit yet. `buyInventory` lets anyone buy inventory back at oracle + 0.5%.
- **Oracle and market-hours risk.** Stock feeds freeze while US markets are closed, and Monday can open with a gap. Weekend intake is haircut 5%, but a gap bigger than the collateral buffer creates bad debt. The holiday calendar is owner-maintained. Robinhood Chain has no L2 sequencer-uptime feed listed, so sequencer downtime is not detected.
- **Stock Token restrictions.** Robinhood Stock Tokens are for eligible non-US customers under Robinhood's terms (`terms()` on each token points to `https://robinhood.com/stocktoken/rhj`). They can be paused and accounts can be blocklisted. A paused token cannot be liquidated, and a blocklisted borrower's collateral waits in `claimable`. Any production use needs jurisdiction gating and KYC that this hackathon build does not have.
- **Cross-chain settlement.** Arc draws are funded by the Arc pool, while line liquidation proceeds land in the Robinhood vault. Moving that value back to Arc (e.g. via CCTP) is not automated. Between a draw on Arc and its CRE report, Robinhood sees stale utilisation.
- **USDC valued at $1** when sizing Arc lines (no USDC feed on Robinhood Chain).
- **Trusted roles.** The owner sets feeds, risk parameters, the forwarder and the underwriter (`Ownable2Step`). A compromised underwriter key can grant tiers up to the on-chain floor (120% collateral). Collateralisation still bounds the loss to price moves.
- **Self-dealing.** A borrower can invoice themselves. That amounts to an over-collateralised USDG loan that pays the 3% fee, which is allowed.

## Tests

`sh scripts/test-fork.sh` (Foundry, fresh Robinhood mainnet fork): **94 passed, 0 failed**. The suites are RobinhoodBehaviour (6), NorenAssetOracle (16), NorenGateway (17 + 1), NorenVault (9), NorenCredit (28) and NorenCreditLine (17). They cover:

- **Payments:** stale price, weekend window, holiday, depeg, unsupported or disabled asset, slippage, invoice replay, expiry and cancellation, blocked payer, paused token.
- **Underwriting:** wrong-key, tampered, replayed, expired, malformed and below-floor attestations; tier upgrades and downgrades.
- **Pay in 4:** over-limit and under-collateralised opens; early collateral withdrawal (impossible until the last installment); overdue liquidation math (vault made whole, liquidator gets debt + 5%); price-drop liquidation through a real `updateMultiplier`; bad debt when underwater; blocklisted borrower.
- **Arc line:** forwarder-only, stale or replayed reports, future `asOf`, workflow metadata, two-step close, past-due and under-collateralised liquidation.

`pnpm --filter @noren/robinhood test` (Vitest, snapshot served on 8720 plus live mainnet reads): **14 passed, 0 failed** in 5 files:

- **score (9):** tier boundaries, liquidation cap, unavailable factors, and the collateral-only floor: one TSLA on a fresh wallet gives a tier-1, 150%, 173 USDG line, a fresh wallet without stock is declined with all five factors, history is never lowered.
- **history.live (1):** real mainnet history of the Uniswap v4 PoolManager.
- **attest.fork (1):** sign, apply, replay → `BadNonce`.
- **floor.fork (2):** a brand-new key funded with 1 real NVDA gets the floor terms from `/attest` logic and opens a fully secured Arc line; a new key without stock is declined.
- **sdk.fork (1):** USDG and NVDA paid by EIP-2612 permit, ETH paid natively, attestation applied, Pay in 4 opened and repaid by permit, Arc credit line opened, positions read.

`pnpm exec tsc -p tsconfig.json --noEmit` passes. The 0G path was not exercised here (`ZG_PC_API_KEY` is not set in this environment), so the decisions above came from the labelled deterministic score and floor.
