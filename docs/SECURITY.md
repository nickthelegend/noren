# Noren contracts: security review

Internal review of every Noren-authored Solidity contract, on branch `audit` (from `main` 1965bbf), Nov 6 2026. It is **not a third-party audit**. Vendored code (OpenZeppelin, 1inch Aqua / SwapVM, 0xbow / Kohaku privacy pools, Chainlink interfaces) was not reviewed beyond how Noren calls it.

**Scope.** `packages/contracts/src` (NorenCheckout, NorenRateOracle, NorenQuoter, ForkUSDC), `packages/arc-credit/src` (NorenCreditLine, test harness), `packages/cctp/src` (NorenArcHook), `packages/ccip/src` (NorenCcipBase, Gateway, Hub, Inbox, NorenArcActionRouter, NorenShieldSink, libraries) and its scripts, `packages/xchain-aqua/contracts/src` (NorenCrossChainSettler, NorenCrossChainEscrow, NorenEscrowReceipt, NorenRelayedFeed, NorenRateOracleFeed, XChain*), `packages/bridge-settlement/src` (NorenSettlementDesk), `packages/robinhood/contracts/src` (NorenCredit, NorenShareLines, NorenCreditLens, NorenBorrow, NorenDutchAuction, NorenAssetOracle, NorenReputation, NorenLiquidity, NorenDepositVault, NorenVault, NorenGateway), and `packages/aqua/swapvm-ext/src` (NorenOraclePeg, NorenDutchDecay, NorenAquaSwapVMRouter).

**Checklist applied to each contract.**
- Access control and owner/pause powers.
- Reentrancy and checks-effects-interactions.
- Oracle staleness, decimals and L2 sequencer.
- Rounding direction.
- Share inflation and donation attacks.
- Liquidation math: bad-debt paths, health-factor monotonicity, partial targets, keeper incentive.
- Replay and nonces across CCTP, CCIP and CRE.
- Unchecked return values and open approvals.
- Events.

**Live contracts.** Contracts already deployed on public testnets keep their ABI. A fix to one of them is marked **fixed in source, needs redeploy**: the deployed bytecode is the pre-fix version, and its verified source on the explorer is that version too ([DEPLOY.md](DEPLOY.md#verified-source)).

## Findings

Severity: Critical / High / Medium / Low / Info. Tests are Foundry tests; the IDs are in each test's name.

| ID | Contract · function | Sev | Issue | Fix / reason | Regression test | Status |
|---|---|---|---|---|---|---|
| ARC-1 | NorenArcHook · `_receive` (`relay`, `onReport`) | **High** | The hook never checked that a CCTP message was addressed to Circle's TokenMessengerV2. A generic `MessageTransmitterV2.sendMessage` message with the hook as destinationCaller could carry a burn-shaped body with a forged depositor. The action router trusts that depositor as `sourceSender`, so the attacker could open `PAY_ON_CREDIT` on any borrower's router line. A fork test shows Circle's real Arc transmitter accepts such a message. | New immutable `tokenMessenger` (constructor argument 3); `header.recipient` must equal it, else `NotBurnMessage`. TokenMessengerV2 itself checks the remote sender. | `test_Audit_ARC1_genericMessageWithForgedDepositorRejected`, `test_Audit_ARC1_tokenMessengerIsRequired`, `test_Audit_ARC1_fork_forgedGenericMessageRejected` | Fixed in source, **needs redeploy** of the three live hooks (exposure today: the router `0x3D2d…A7A4` holds 0.15 USDC, and no CCTP credit authority is set) |
| ARC-2 | All CRE receivers (`onReport` on RateOracle, CreditLine, ArcHook, SettlementDesk, Settler, NorenCredit) | High (testnet config) | The live forwarder is Chainlink's `MockKeystoneForwarder` (CRE simulation). It checks no DON signatures, so anyone can route a report through it, workflow metadata included. | Not a code bug. The production path is the real KeystoneForwarder plus `setExpectedWorkflowOwner` / `setWorkflowPolicy` ([DEPLOY.md](DEPLOY.md#cre-forwarder)). `scripts/deploy-public.sh` refuses the mock unless `NOREN_CRE_MODE=simulate`. | — | Accepted for testnet |
| ARC-3 | RateOracle, CreditLine, SettlementDesk · workflow pin | Medium | `expectedWorkflowOwner` is zero by default, so under a real KeystoneForwarder any DON workflow could write. | Set at deploy: `deploy-public.sh` requires `CRE_WORKFLOW_OWNER` in production mode. | — | Accepted (config) |
| ARC-4 | NorenSettlementDesk · refunds | Medium | An unfilled Across or Relay deposit is refunded to the depositor, which is the desk itself, and there was no way to get it out. | `escrowedUsdg6` accounting and owner-only `recover()`, which can only take the balance above open escrow. | `test_Audit_ARC4_refundRecoverableButEscrowProtected`, `test_Audit_ARC4_cancelReleasesEscrow` | Fixed (not deployed publicly) |
| ARC-5 | NorenSettlementDesk · `onReport` | Low | The merchant's `maxSlippageBps` wasn't enforced on-chain (only the 5% cap was). | Floor = fair × (1 − merchant bps), the workflow's formula; zero prices rejected. | `test_Audit_ARC5_approvalBelowMerchantSlippageRejected` | Fixed |
| ARC-6 | NorenSettlementDesk · Relay | Medium | A report doesn't bind the Relay order id, so the keeper chooses the quote. | Keeper is a trusted role; Across is the trust-minimised path. | — | Accepted |
| ARC-7 | NorenCreditLine · kind-1 reports | Low | No `asOf` ordering; a close is final. | The fixed bridge interface has 4 fields; KeystoneForwarder rejects duplicate reports. | — | Accepted |
| ARC-8 | NorenCreditLine · `fund` | Info | A third party's `fund()` is a donation the owner can withdraw. | Documented. | — | Accepted |
| ARC-9 | NorenCreditLine · `repay` | Low | A 1-unit front-run makes an exact full repay revert `RepayTooMuch`; the attacker pays part of the debt. | Griefing only. | — | Accepted |
| ARC-10 | NorenRateOracle, NorenArcHook · ownership | Info | One-step `Ownable`; the owner sets the router and forwarder. | Owner powers listed below; use a multisig for production. | — | Accepted |
| ARC-11 | NorenCreditLine · `ragequitPoolDraw` | Low | Only the original pool deposit note can be ragequit, not a change note. | Kohaku pool semantics. | — | Accepted |
| ARC-12 | NorenCheckout · `refund` | Info | A reused refund precommitment makes that refund revert (customer side only). | — | — | Accepted |
| CCIP-1 | NorenCcipGateway / NorenCcipHub · `withdrawToken` | Medium | The owner could sweep tokens owed to users: gateway claimables, FAILED deliveries, hub custody. | A `reserved[token]` tally; `withdrawToken` is limited to `balance − reserved` (`ExceedsFree`). | `test_Audit_CCIP1_ownerCannotSweepClaimable`, `…_failedDeliveryIsReservedUntilRetriedOrRecovered`, `…_hubCustodyIsNotOwnerWithdrawable` | Fixed in source, needs redeploy |
| CCIP-2 | NorenCcipGateway · `send` | Low | Native value sent with an ERC-20 fee token stayed in the gateway. | Reverts `UnexpectedNative`. | `test_Audit_CCIP2_sendRejectsNativeWithErc20Fee` | Fixed in source, needs redeploy |
| CCIP-3 | NorenCcipGateway · nonce | Low | A replacement gateway restarts at nonce 1. Receivers key on `(originChain, nonce)`, so its messages are treated as duplicates. | Owner-only, forward-only `bumpNonce(uint64)`. | `test_Audit_CCIP3_bumpNonceAvoidsCollisionWithAReplacedGateway` | Fixed in source, needs redeploy |
| CCIP-4 | `Deploy.s.sol` (ccip) | Medium | The deployer EOA is the credit authority on Robinhood testnet, Base Sepolia and Sepolia. | Production must set NorenCredit's sender as the authority (DEPLOY.md). | — | Accepted (testnet config) |
| CCIP-5 | NorenArcActionRouter · invoice ids / AQUA refs | Low | Invoice ids and order refs are first-come. A squatter only bounces the real payment back to its payer as a claimable balance. | Clients salt refs. | — | Accepted |
| CCIP-6 | NorenArcActionRouter · PAY_ON_CREDIT | Low | A borrower is matched by address on any source chain, so lines must belong to EOAs (not counterfactual contract wallets). | Documented. | — | Accepted |
| CCIP-7 | NorenCcipHub · second-hop fees | Low | The hub pays the second hop from its own balance, so spam can drain it. If the fee token equals a custody token, custody can pay fees. | Owner funds and monitors the hub. | — | Accepted |
| XC-1 | NorenCrossChainSettler · `_relay` | Low | `PriceRound.decimals` was ignored, so a round in other units would misprice fills. | Reverts `WrongDecimals` unless it equals the relayed feed's. | `test_Audit_XC1_relayedRoundInOtherDecimalsIsRefused` | Fixed (the live settler has no relayed route) |
| XC-2 | NorenCrossChainSettler · `setMaxSpread` | Info | No event. | `MaxSpreadSet`. | — | Fixed |
| XC-3 | NorenCrossChainEscrow | Low | A fill reported after `refundAfter` loses to the refund; the minimum window is 1 hour. | By design. | — | Accepted |
| RH-C-1 | NorenDutchAuction · `openAuction` / `fill` | Medium | After a borrower cured the plan with `repay()`, the old auction start stayed, so the next liquidation filled at the grown discount. | A repayment outside the auction makes it stale (`AuctionStale`); `openAuction` restarts it. | `test_Audit_RHC1_auctionStaleAfterBorrowerCure` | Fixed |
| RH-C-2 | NorenDutchAuction · `_bestQuote*` | Medium | Aqua balances are virtual: a strategy shipped with USDG the maker doesn't hold won the quote and made every fill revert. Zero-cost strategies could also fill the 8 slots. | Only makers whose real balance and allowance cover the payment are quoted; the owner may remove any strategy. | `test_Audit_RHC2_unbackedStrategySkippedAndRemovable` | Fixed |
| RH-C-3 | NorenCredit · `onReport` | Medium | A faulty or compromised CRE report could invent Arc debt or roll back repayments, making a line liquidatable. | `BadReport` unless repaid ≤ drawn, neither total decreases, and drawn − repaid ≤ the line limit (Arc's own invariants). | `test_Audit_RHC3_reportOutsideArcInvariantsRejected` | Fixed |
| RH-C-4 | NorenAssetOracle · `price` | Low | `disableAsset` made `price()` revert, which froze valuation and liquidation of open positions. | `price()` only needs a configured feed; `isSupported` still gates new risk; NorenBorrow leaves disabled assets out of new borrowing. | `test_Audit_RHC4_*` (3) | Fixed |
| RH-C-5 | NorenAssetOracle | Low | No L2 sequencer uptime check (Robinhood Chain is an Arbitrum Orbit L2). | Optional `setSequencerUptimeFeed(feed, grace)`. Chainlink lists no uptime feed for Robinhood Chain today, so it is off. | `test_Audit_RHC5_sequencerDownBlocksPrices` | Fixed (hook only) |
| RH-C-6 | NorenCredit · `setDutchAuction` | Medium | The owner could repoint the auction and seize plan collateral through `auctionSeize`. | Set once, never zero. | `test_Audit_RHC6_dutchAuctionSetOnce` | Fixed |
| RH-C-7 | NorenCredit · `_settleLine` | Low | Closing an unused line counted as clean, so borrowers could lift their tier for free. | Clean only when drawn ≠ 0. | `test_Audit_RHC7_unusedLineIsNotClean` | Fixed |
| RH-C-8 | NorenCredit · owner params | Info | `setParams`, `setForwarder`, `setLiquidity` take effect immediately. | Multisig plus timelock for production. | — | Accepted |
| RH-C-9 | NorenAssetOracle · fail-closed | Info | Liquidations pause while a feed is stale or USDG is outside ±2%; repay still works. | By design. | existing stale/depeg tests | Accepted |
| RH-C-10 | NorenBorrow · `liquidateViaAqua`, `harvestToRepay` | Info | No keeper bonus when the vault's USDG alone repays. Anyone can trigger a harvest, which may sell yield up to 3% under Chainlink, but the health factor can't get worse (`HealthWorse`). | Design. | existing tests | Accepted |
| RH-C-11 | NorenReputation | Info | Self-funded Pay-in-3 plans can farm points. LTV is capped at 80%, below the 85% liquidation LTV. | Bounded. | existing tests | Accepted |
| RH-L-1 | NorenLiquidity · `register` / `remove` | Medium | Open registration: one address could fill all 8 strategy slots for an asset, and the owner couldn't remove a shipped strategy. | Owner may `remove` any strategy; optional allowlist (`setMakerAllowlist`, `setMakerApproved`). | `test_Audit_RHL1_ownerClearsSquattedSlotsAndAllowlistBlocksSquatter` | Fixed |
| RH-L-2 | NorenLiquidity · `buyFromMakers` | Low | An unpriceable fill (stale feed) booked the whole payment as maker fee, inflating `feesPerShare`. | Fee 0 when the value is 0. | `test_Audit_RHL2_unpriceableAskFillBooksNoFee` | Fixed |
| RH-L-3 | NorenLiquidity · `sellExactAsset` / `sellForUsdg` | Low | `to` = 0 or NorenLiquidity stranded the USDG (no sweep). | Pays the caller instead. | `test_Audit_RHL3_sellToZeroOrSelfPaysTheCaller` | Fixed |
| RH-V-1 | NorenVault · `buyInventory` | Low | Dust whose oracle value rounds to 0 handed over inventory for 0 USDG. | `DustAmount`. | `test_Audit_RHV1_dustInventoryIsNeverFree` | Fixed |
| RH-D-1 | NorenDepositVault, NorenVault · NAV | Medium | In the weekend window a stock price can be up to `maxAgeClosed` old, so a deposit at a stale NAV followed by `redeemInKind` can extract the mispricing times the vault's USDG share. | Fork-only contracts; `closedExtraBps` widens fills. Recommendation: a closed-market deposit fee. | — | Accepted |
| RH-A-1 | NorenVault, NorenDepositVault · `forceApprove(max)` to Aqua | Info | Unlimited approval to the Aqua registry. | Aqua pulls only through the registered router, up to the strategy's virtual balance, against priced fills; docking sets those balances to 0. Every other approval in Noren is exact and reset to 0. | — | Accepted (justified) |
| SV-1 | NorenOraclePeg | Info | Latency arbitrage ahead of a Chainlink update; no sequencer check. | Spreads must exceed the feed's deviation threshold. | — | Accepted |
| SV-2 | NorenOraclePeg · market calendar | Info | No holiday calendar. | Fails closed on a weekday holiday. | — | Not an issue |
| SV-3 | NorenOraclePeg · `quoteMaxDepegBps ≥ 10000` | Info | Underflow reverts. | Maker misconfiguration only; NorenLiquidity bakes in ≤ 1000. | — | Not an issue |
| SV-4 | NorenDutchDecay · args | Info | Reads a 32-byte word for a 30-byte argument. | Length checked, only the top 30 bytes used; discount capped at 50%. | — | Not an issue |
| SL-1 | NorenCredit + NorenShareLines · share-backed lines (new) | Info | `harvestLineToRepay` credits Arc debt on Robinhood (USDG to the vault); Arc's NorenCreditLine still shows the gross balance until a bridge report or treasury repayment reaches Arc. | A double payment (yield plus an Arc repayment) is refunded at settlement (`LineYieldRefunded`). | `test_ShareLine_settlementRefundsYieldPaymentsArcMadeUnnecessary` | Accepted (bridge follow-up) |
| SL-2 | NorenCredit · share liquidation (new) | Info | The keeper bonus applies only to the part of the debt not covered by the shares' USDG; 5% extra is redeemed so a maker's bid spread can't leave the sale short (the unsold asset goes back to the borrower). | Design, as NorenBorrow. | `test_ShareLine_pastDueLiquidationRedeemsOnlyWhatTheDebtNeeds`, `test_ShareLine_priceDropLiquidationViaAqua` | Accepted |
| SL-3 | NorenDepositVault · first depositor (existing defence, re-tested) | Info | Inflation/donation attack. | 6-decimal virtual share offset: the attacker loses part of the donation and the victim keeps its deposit. | `test_ShareVault_firstDepositorDonationAttackFails`, `test_ShareVault_donationOnlyAddsProRataValue` | Not an issue |
| RP-1 | NorenReputation · `recordAttestation` (new) | Info | The attester (underwriter key or owner-set attester) is trusted to have verified the proof off-chain. The `boostBps` weight is public. | Kinds count once, commitments are single-use; the server should use one fixed weight per kind to reveal nothing beyond the kind. | `test_PrivRep_*` (4) | Accepted |

**Not Noren's to fix:** vendored OpenZeppelin `Math` / `Address` hits from Slither (below), the Kohaku pool's own ASP trust model ([PRIVACY.md](PRIVACY.md)), and 1inch Aqua's virtual-balance design (handled by RH-C-2).

## Privacy of on-chain reputation

`NorenReputation.recordAttestation` stores, per borrower:
- the **kind** of proof (World ID, Reclaim credit score, KYC, balance, identity, on-chain repayment),
- a public weight,
- a salted commitment `keccak256(abi.encode(kind, proofId, salt))`.

The borrower's address and *which kinds* of proof it has are public. No name, score, balance or provider account goes on-chain. The salt and the proof stay on the Noren server.

## Owner and operator powers

All owners are the deployer EOA on testnet; production should be a multisig with a timelock on parameter changes.

- **NorenRateOracle, NorenArcHook, NorenCreditLine, settlement desk, settler, CCIP contracts.** The owner sets the forwarder, workflow pins, routes and rails. It can `recoverFailed` / `releaseCustody` / `releaseHold` funds that a failed cross-chain delivery left behind. Gateway and hub sweeps are limited to unreserved balances (CCIP-1).
- **NorenCredit.** The owner sets params, forwarder, liquidity, reputation and accepted share vaults. The Dutch auction can be set only once.
- **NorenVault.** Modules (NorenCredit, NorenBorrow, gateway) can `disburse` idle USDG.
- **Pause.** There is no global pause. NorenCreditLine has a `paused` flag for new draws (repayments keep working).

## Slither (0.11.6)

Run per Foundry package: `slither . --filter-paths "lib|node_modules|test|script|fork-test" --exclude-dependencies`.

| Package | Results | Triage |
|---|---|---|
| contracts, arc-credit, cctp, bridge-settlement | divide-before-multiply, reentrancy-events/benign, uninitialized-local, unused-return, missing-zero-check, timestamp | No true positive. Divide-before-multiply is the intended 32-byte round-up in `validateAction` and the workflow-identical floor in the desk. Reentrancy hits are under `nonReentrant` or only emit after calls to trusted contracts. Locals are always assigned before use. The ignored returns (`assetConfig`, `deposit`, `latestRoundData` startedAt) are intentional. Missing zero-checks mean "pin off". Timestamps are expiry windows. One real gap fixed: the missing event on `setMaxFeedAge` (`MaxFeedAgeSet`). |
| ccip | 34 | No true positive: reentrancy-no-eth on self-calls under `nonReentrant`, intentional zero-default locals, intentional unused `forward` return, Low missing-zero-checks on owner setters. |
| xchain-aqua | partial | "High uninitialized-state" on `XChainInbox` is a false positive (derived contracts set it). |
| swapvm-ext | 8 | No true positive: divide-before-multiply on the Dutch discount (maker-favoured rounding), unused `runLoop` / `latestRoundData` returns, constructor zero-check, timestamp comparisons. |
| robinhood/contracts | — | Slither 0.11.6 cannot resolve this solc 0.8.28 via-IR build ("Failed to resolve name for reference id"), so it gives no coverage here; the manual review above covers it. |

## Test counts on `audit`

| Suite | Command | Result |
|---|---|---|
| Robinhood contracts, fresh mainnet fork | `sh packages/robinhood/scripts/test-fork.sh` | **185 passed**, 14 suites (incl. 15 new share-line and private-reputation tests, 15 audit tests) |
| NorenArcHook unit + Circle-contract forks | `cd packages/cctp && forge test` | **27 passed** (was 24) |
| NorenSettlementDesk (Robinhood fork) | `cd packages/bridge-settlement && forge test` | **22 passed** (was 19) |
| NorenRateOracle | `cd packages/contracts && forge test --no-match-contract NorenCheckout` | **22 passed** |
| NorenCreditLine unit / Arc-pool fork | `cd packages/arc-credit && forge test` / `FOUNDRY_PROFILE=fork forge test` | **47** / **15 passed** |
| CCIP unit / CCIP 2.0 forks | `cd packages/ccip && forge test` / `FOUNDRY_PROFILE=fork forge test` | **14** (was 9) / **23 passed** |
| Cross-chain Aqua forks | `sh packages/xchain-aqua/scripts/test-forks.sh` | **32 passed** (the three clock-warping tests run in their own pass; in one combined run, `vm.warp` leaks into 4–7 Robinhood-phase tests, a harness ordering issue) |
| 1inch Aqua stack on an Arc fork | `sh packages/xchain-aqua/scripts/test-aqua-live.sh` | **8 passed** |
| SwapVM extension | `cd packages/aqua/swapvm-ext && forge test` | **27 passed, 1 skipped** (weekend-only) |

`NorenCheckout` (9 Foundry tests) runs inside `pnpm e2e` on the dev-stack ports; its source is unchanged on this branch.
