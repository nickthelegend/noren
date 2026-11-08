# Test results

## Current totals (`main`, Nov 7 2026)

**656 passed, 1 skipped, 0 failed, across 21 suites.** Forks are local Anvil nodes of Arc testnet or Robinhood Chain mainnet. "Live" suites read public networks. The skip is a SwapVM test that only runs while US markets are closed.

On Nov 7 (02:58–03:10 IST) the release branch (`main` plus the `v5`, `deploy-web` and `deploy` merges and the new pay-with-every-asset test) re-ran every suite marked **run** below, one at a time, all green. The three suites marked *count* were not re-run; their figure is the latest recorded run, and for the Foundry ones it equals the number of `test*` functions in their files. The web production build (`pnpm --filter @noren/web build`) also passed.

| # | Suite | Command | Passed | Nov 7 |
|---|---|---|---|---|
| 1 | Offline suites: core, server incl. Privy sign-in and Reclaim, World ID (43), 0G policy, Robinhood underwriter score, CCTP SDK, CCIP SDK, settlement keeper. `pricing.test.ts` reads Arc mainnet Chainlink feeds. | `pnpm test` | **155** (22 files) | run |
| 2 | Demo shop (node:test) | `pnpm --dir examples/shop test` | 5 | run |
| 3 | `NorenRateOracle` | `cd packages/contracts && forge test --no-match-contract NorenCheckout` | 22 | run |
| 4 | `NorenCreditLine` unit | `cd packages/arc-credit && forge test` | 47 | run |
| 5 | `NorenCreditLine.drawToPool` against the live Arc pool (fork) | `cd packages/arc-credit && FOUNDRY_PROFILE=fork forge test` | 15 | run |
| 6 | `NorenArcHook`, unit + Circle-contract forks | `cd packages/cctp && forge test` | 27 | run |
| 7 | CCIP router unit + audit regressions | `cd packages/ccip && forge test` | 14 | run |
| 8 | CCIP 2.0 forks + `NorenShieldSink` | `cd packages/ccip && FOUNDRY_PROFILE=fork forge test` | 23 | run |
| 9 | CCIP API status (live) | `pnpm test:live` in packages/ccip | 2 | run |
| 10–14 | CRE workflows (bun): credit bridge, pricing, CCTP relay, settlement desk, cross-chain Aqua | `bun test` in each workflow | 31 + 8 + 8 + 15 + 14 | run |
| 15 | `NorenOraclePeg` + `NorenDutchDecay` + Aqua SwapVM router | `sh packages/aqua/scripts/test-swapvm.sh` | 27 (+1 weekend-only skip) | run |
| 16 | Robinhood contracts on a fresh local fork of Robinhood Chain mainnet, incl. `NorenPayEveryAsset` (an invoice paid with each of SPY, MSFT, AMZN, GOOGL, META, TSLA, AAPL, NVDA, ETH and USDG) | `sh packages/robinhood/scripts/test-fork.sh` | **188** (185 + 3 new) | run |
| 17 | Robinhood SDK fork tests (Aqua makers, Dutch cure, self-repay) | `pnpm exec vitest run sdk/test/{aqua,dutch,selfrepay}.fork.test.ts` against a served snapshot | 4 + 1 + 1 | *count* (Nov 6 run) |
| 18 | Cross-chain Aqua (Arc fork + Robinhood snapshot, Arc fork + Base Sepolia fork) | `sh packages/xchain-aqua/scripts/test-forks.sh` | 31 | *count* (Nov 6 run; 18 + 13 functions) |
| 19 | 1inch Aqua v1.0.0 stack on an Arc testnet fork | `sh packages/xchain-aqua/scripts/test-aqua-live.sh` | 8 | *count* (Nov 6 run; 8 functions) |
| 20 | Private payment end to end (`NorenCheckout` Foundry tests, real 0xbow pool and Groth16 verifier) | `pnpm e2e` | 9, plus **5/5** on-chain attack reverts | run (41.7 s; proof 4.35 s cold, re-proof 1.05 s) |
| 21 | Arc swap quotes (live, read-only) | `pnpm exec vitest run packages/web/src/app/arc-swap.live.test.ts` | 1 | run |

End-to-end runs (not counted above): `pnpm e2e:credit` **8/8** steps (26.4–30.9 s, Nov 6), plus the browser runs below. The hosted demo's first private payment on public Arc testnet: [`0x38b8ce96…`](https://explorer.testnet.arc.io/tx/0x38b8ce96c9ad3a2957467def0194eeba8e2cf0d2d26f5aae9df7b7b8fa12b0f5) ([docs/DEPLOY.md](docs/DEPLOY.md#hosted-public-demo-nov-7-2026)).

**Not in the total** (they exist, but no recent run is recorded): `NorenSettlementDesk` Foundry (22 test functions), `NorenQuoter` fork (5), `XChainReverse` (1), and the other Robinhood SDK and underwriter fork or live files.

**Corrections to earlier totals.** The section headings below said 574, 589, 590 and 599. Those sums counted the 7 `@noren/ccip` SDK tests twice, since they also run inside `pnpm test`, and they predate the Privy tests (+6 in `pnpm test`). The table above is the recount.

## self-repay: loans that pay themselves down (branch `self-repay` from `v3`, Nov 6 2026)

`NorenBorrow.harvestToRepay` repays a loan with the realised Aqua fees its locked shares earned ([docs/EARN.md](docs/EARN.md#loans-that-pay-themselves-down)). The suites the change touches were rerun on the branch HEAD, one at a time:

| Suite | Command | Result |
|---|---|---|
| Robinhood contracts, fresh mainnet fork | `NOREN_RH_TEST_PORT=8900 sh packages/robinhood/scripts/test-fork.sh` | **158 passed**, 11 suites (150 before + **8 new** in `NorenSelfRepay.t.sol`; no existing test changed) |
| Robinhood SDK and underwriter on the rebuilt warmed snapshot (mainnet block 107689497) + live mainnet reads | `NOREN_RH_RPC=http://127.0.0.1:8902 pnpm --filter @noren/robinhood exec vitest run` | **21 passed**, 9 files (new: `sdk/test/selfrepay.fork.test.ts`) |
| Robinhood SDK and web typecheck, web production build | `pnpm --filter @noren/robinhood typecheck`; `cd packages/web && pnpm exec tsc --noEmit -p . && pnpm exec vite build` | pass |
| `pnpm e2e:credit` against this branch's `pnpm dev:all` (rebuilt snapshot) | `NOREN_MERCHANT_TOKEN=<printed> pnpm e2e:credit` | **8/8** in 26.4 s; CRE Robinhood → Arc in 6.0 s; 0.039949 NVDA at $188.34 filled by an Aqua maker (fee 0.0301 USDG) |

So the total becomes **599 passed** (590 + 8 Foundry + 1 SDK fork test), 1 weekend-only skip.

**Browser, built-in preview at 1440 and 375 px against this branch's `pnpm dev:all` (fresh browser test key, fork faucet):** deposit 1 NVDA and 0.9 ETH in Earn, lock both in Borrow, and the card reads "no fills since it was locked" with a disabled "No loan to pay down" button. Then borrow 500 USDG. dev:all's demo trader makes six real Aqua fills (ETH buys 0.2 and 0.1, a 0.1 sell-back; NVDA buys 0.5 and 0.25, a 0.25 sell-back), and the card's "Earned, not used yet" climbs live to 4.2528 USDG from 6 fills, both vaults already in USDG. **Use earnings to pay down loan** takes the debt from **500 to 495.7472 USDG** (fork tx `0x6131a9404add81e232dd3a7da4e27e8cd7ffcc0e95d179620b5b0b92ff623aee`), and the health factor goes from 3.72 to 3.75. The card then reads "Paid by your collateral's trading fees: 4.2528 USDG from 6 Aqua fills · 1 harvest", debt without earnings 500. There is no horizontal overflow at 375 px.

## v3: product polish (branch `v3`, Nov 6 2026)

`v3` is `private-credit` plus the app Home, the four ways to pay, Uniswap v4 as the default swap route (live on Arc testnet), Aqua makers shown in Earn and Borrow, and the Robinhood ⇄ Arc bridge hero. Suites the changes touch were rerun on its HEAD, one at a time:

| Suite | Command | Result |
|---|---|---|
| Offline suites | `pnpm test` | **136 passed**, 20 files |
| Arc swap quotes, live and read-only (Uniswap v4 USDC/EURC pool via V4Quoter; Noren's Aqua maker) | `pnpm exec vitest run packages/web/src/app/arc-swap.live.test.ts` | **1 passed** (new); 1 USDC → 0.831320 EURC on Uniswap, 0.888729 from the Aqua maker, Chainlink fair 0.891395 |
| Demo shop (node:test) | `pnpm --dir examples/shop test` | **5 passed** |
| Web typecheck and production build | `cd packages/web && pnpm exec tsc --noEmit -p . && pnpm exec vite build` | pass |
| `pnpm e2e` (fresh Arc testnet fork) | `pnpm e2e` | **9/9** Foundry checkout tests, **5/5** attacks reverted, first proof 5.03 s (cold), re-proof 1.06 s, 54.8 s |
| `pnpm e2e:credit` against `pnpm dev:all` | `NOREN_MERCHANT_TOKEN=<printed> pnpm e2e:credit` | **8/8** in 30.9 s; the NVDA payment was filled by the lender pool's Aqua strategy (fee 0.0301 USDG, `makerFeesUsdg(NorenVault)` = 0.030120) |

So the total becomes **590 passed** (589 + the live Arc swap test), 1 weekend-only skip.

**Browser, headless Chromium against `pnpm dev:all` (fresh wallets):**
- **Pay privately from the app's Home:** pick an open link → one-step fork USDC into the private balance → proof 1.12 s, tap to paid 6.2 s, payer address in the tx: none.
- **Pay later, privately:** Credit tab locks 1 NVDA (line on Arc via CRE), then the checkout reached with `?m=later` draws into the pool and pays 12.00 USDC: proof 1.12 s, "Your address in it: none".
- **Pay with USDC:** the checkout reached with `?m=usdc` (after another checkout, no reload) pays 6.10 USDC from the Arc wallet.
- **Pay with stocks and Pay in 3:** `pnpm e2e:credit` above.
- No horizontal overflow at 1440 or 375 px on Home, Pay, Bridge, Swap, Earn, Borrow, Credit, the checkout and the landing page; no page errors.

**Public testnets, from the app's UI** (the browser's test key, funded by `scripts/live/fund-test-key.ts` with 1 USDC on Arc and 0.003 ETH on Robinhood): Arc → Robinhood 0.60 USDC (14 s), Robinhood → Arc 0.50 and 0.10 USDC (12 s), a Uniswap v4 swap and an Aqua maker swap on Arc. Hashes in [docs/CCTP.md](docs/CCTP.md#live-runs-public-testnets-nov-6-2026) and [docs/AQUA-LIVE.md](docs/AQUA-LIVE.md).

## Private credit (branch `private-credit`, Nov 6 2026)

`private-credit` is `final` (1670f26) plus `film-v2` plus "Pay later, privately" ([docs/PRIVACY.md](docs/PRIVACY.md#private-credit-pay-later-privately)). It adds one suite, **15 fork tests**, so the total below becomes **589 passed**. The suites the change touches were rerun on its HEAD:

| Suite | Command | Result |
|---|---|---|
| `NorenCreditLine.drawToPool` against the live Arc Entrypoint and USDC pool (Arc testnet fork, USDC shim): lands as a pool deposit under the borrower's precommitment, debt equal to a `payInvoice` draw, limit, non-borrower, expired, frozen, paused, blocklisted borrower, bad / reused precommitment, below the 1 USDC pool minimum, pool insufficient, off until `setPrivacyPool`, ragequit guards | `cd packages/arc-credit && FOUNDRY_PROFILE=fork forge test` | **15 passed** (new) |
| `NorenCreditLine` unit (unchanged behaviour of `payInvoice`, reports, repay) | `cd packages/arc-credit && forge test` | **47 passed** |
| Offline suites (server incl. the pool-draw skip) | `pnpm test` | **136 passed**, 20 files |
| CRE credit bridge | `bun test` in packages/cre-bridge/credit-bridge | **31 passed** |
| Web typecheck and production build | `cd packages/web && pnpm exec tsc --noEmit -p . && pnpm exec vite build` | pass |
| Pay later, privately end to end on an Arc testnet fork (CRE simulator opens the line, `drawToPool`, ASP, private 0.40 USDC payment) | `pnpm exec tsx scripts/live/private-credit-live.ts --fork` | pass: borrower and credit line absent from the payment tx, 0.60 USDC left private, debt 1.00 USDC |
| Same run on the **public Arc testnet** | `pnpm exec tsx scripts/live/private-credit-live.ts` | pass, 10 txs, [record](scripts/live/private-credit-runs.json), payment tx [0xf3b78257…](https://explorer.testnet.arc.io/tx/0xf3b782579b4f8076d220085df9d192eaccd0336eb20b974a689993e1fc02723a) |

**Browser (the real app on `pnpm dev:all`, 1440 and 375 px):** locked 1 NVDA for a 125.70 USDC line (CRE to Arc in 4.5 s), paid a 24.00 USDC and a 0.40 USDC invoice with **Pay later, privately** (draw, compliance check, proof 1.17 s / 1.00 s, relay); Noren Merchant shows **Customer: Private**; the Noren app shows the 24.00 USDC debt and **Repay** labelled Public, and a repay of 8.00 USDC went through. No horizontal overflow at 375 px. Screenshots: `docs/img/private-credit-*.jpg`.

## Final integrated build (branch `final`, Nov 6 2026)

`final` is `app-dex` plus `ui-polish`, `cctp-bridge`, `xchain-aqua`, `ccip`, `aqua-live`, `privacy`, `film` and `dutch-liquidation`. Every suite below ran on its final HEAD, one at a time. Forks are local Anvil nodes; "live" suites read public testnets.

**574 tests pass, 0 fail, 1 skipped** (589 with the private-credit fork suite above) (a weekend-window SwapVM test that skips itself while US markets are open), plus the two end-to-end runs and the browser check. After the `dutch-liquidation` merge, the suites it touches were rerun (SwapVM, Robinhood fork incl. `NorenDutch`, Robinhood SDK fork tests on a rebuilt snapshot); the rest are from the run before it, on code that merge doesn't change. `pnpm e2e`, `pnpm e2e:credit` and the browser check were not rerun after it (a film recording owned the dev stack).

| Suite | Command | Result |
|---|---|---|
| Offline suites across the monorepo (core, server incl. private send, World ID, 0G credit check, Robinhood SDK/underwriter, settlement keeper, CCTP SDK, CCIP SDK) | `pnpm test` | **136 passed**, 20 files |
| Demo shop (node:test) | `pnpm --dir examples/shop test` | **5 passed** |
| Web typecheck and production build | `cd packages/web && pnpm exec tsc --noEmit -p . && pnpm exec vite build` | pass |
| `NorenRateOracle` | `cd packages/contracts && forge test --no-match-contract NorenCheckout` | **22 passed** |
| `NorenCreditLine` | `cd packages/arc-credit && forge test` | **47 passed** |
| `NorenArcHook`: unit (incl. SHIELD validation) + forks of Arc and Robinhood testnets with Circle's contracts | `cd packages/cctp && forge test` | **24 passed** (17 + 7) |
| `@noren/cctp` SDK, incl. live Iris and the deployed hook | `cd packages/cctp && pnpm exec vitest run` | **19 passed** (also inside `pnpm test`) |
| CCIP router unit | `cd packages/ccip && forge test` | **9 passed** |
| CCIP forks (real CCIP 2.0 Router/OnRamp/OffRamp on 4 testnet forks) + `NorenShieldSink` against the live Arc pool | `cd packages/ccip && FOUNDRY_PROFILE=fork forge test` | **23 passed** (12 + 11) |
| `@noren/ccip` SDK / live CCIP API | `pnpm test:sdk` / `pnpm test:live` in packages/ccip | **7** / **2 passed** |
| CRE workflows (bun) | `bun test` in each workflow | credit bridge **31**, pricing **8**, CCTP relay **8**, settlement desk **15**, cross-chain Aqua **14** |
| `NorenOraclePeg` + `NorenDutchDecay` (opcode 35) + Aqua router (SwapVM) | `sh packages/aqua/scripts/test-swapvm.sh` | **27 passed, 1 skipped** (18 + 10; weekend-only case) |
| Robinhood contracts on a fresh mainnet fork, incl. `NorenDutch` (partial Dutch-auction liquidations, 16) | `sh packages/robinhood/scripts/test-fork.sh` | **150 passed** |
| Robinhood SDK on the rebuilt warmed snapshot: Aqua makers and `createNorenDutch` (overdue plan cured by one partial fill) | `NOREN_RH_RPC=<served snapshot> pnpm exec vitest run sdk/test/aqua.fork.test.ts` / `dutch.fork.test.ts` | **4** / **1 passed** |
| Cross-chain Aqua, Arc fork + Robinhood snapshot, then Arc fork + Base Sepolia fork | `sh packages/xchain-aqua/scripts/test-forks.sh` | **31 passed** (19 + 12) |
| 1inch Aqua stack on an Arc testnet fork (official Aqua v1.0.0) | `sh packages/xchain-aqua/scripts/test-aqua-live.sh` | **8 passed** |
| Private payment end to end on an Arc testnet fork | `pnpm e2e` | **9/9** Foundry checkout tests, **5/5** attacks reverted, proof 1.26 s, re-proof 1.08 s, refund approved, 47.6 s |
| Stocks + pay later end to end against `pnpm dev:all` | `pnpm e2e:credit` | **8/8** steps in 30.3 s; CRE Robinhood → Arc in 6.0 s; 0.040803 NVDA at $184.59 filled by an Aqua maker |

**Browser (headless Chromium against `pnpm dev:all`, 1440 and 375 px):** landing, Noren app Pay / Bridge / Swap (cross-chain on), checkout (Pay privately default, Pay with USDC, Pay from another chain), Noren Merchant home and payments, and the live Arc panel. No horizontal overflow on any route, no page errors.
- **Cross-chain swap, clicked in the app (fork):** 1 NVDA locked on the Robinhood fork, filled on the Arc fork by the Aqua maker through the CRE simulator, NVDA released to the maker: 183.81 USDC received, exactly the quote.
- **Bring USDC to Arc:** live balance and gas reads on the selected CCTP testnet and Circle's live fast-fee quote (1.3 bps Base Sepolia → Arc). The browser's test key holds no testnet funds, so the app stops at "Setup required" with the address to fund; the transfer itself was not sent from the browser. The same SDK path ran live from scripts (docs/CCTP.md, docs/PRIVACY.md).
- **Noren Merchant, from other chains:** reads `InvoicePaid` from the live `NorenArcActionRouter`: the Base Sepolia → Arc CCTP payment (0.399948 USDC) and the Ethereum Sepolia → Arc CCIP pay-on-credit (0.10 USDC) both show with their source chain.
- **Live oracle:** `NorenRateOracle` on Arc testnet answered €100 = 112.18 USDC with 21 h old rounds (limit 25 h); past that the panel says "price stale" instead of erroring.

## Integrated build (branch `web-integration`, Nov 6 2026)

Everything ran on local nodes: an Anvil fork of Arc testnet (chain 5042002) and the Robinhood package's warmed snapshot of Robinhood Chain mainnet state (served as chain 46630 for the CRE simulator). No public transaction was sent; Arc mainnet, Robinhood mainnet, Relay, Across and World were only read.

| Command | Result |
|---|---|
| `pnpm test` | **99 passed**, 0 failed, 14 files: core + server 19, World ID 43, 0G credit check 25, Robinhood SDK/underwriter (offline) 9, settlement keeper 3. Fork (`*.fork.test.ts`) and live (`*.live.test.ts`) suites run in their packages. |
| `pnpm exec tsc --noEmit`, `packages/web` typecheck and `vite build` | pass |
| `pnpm e2e` | **9/9** Foundry checkout tests, **5** attack reverts (`IncorrectASPRoot`, `ContextMismatch`, `NotMerchant`, `Expired`, `AlreadyPaid`), first proof 1.277 s, re-proof 1.139 s, refund approved, 39.03 s total |
| `pnpm e2e:credit` (against `pnpm dev:all`) | **8/8** steps, 20.1–33.7 s across runs (25.8 s on the rebuilt snapshot after the Aqua merge; stock step filled by an Aqua maker, 0.040798 NVDA at $184.61, fee 0.0377 USDG): fork faucet; EIP-712 attestation from the history underwriter (tier 1, collateral-only floor) verified by `NorenCredit.applyAttestation`; 2 NVDA locked (collateral $371.41 at Chainlink); CRE Robinhood → Arc in 5.0–7.0 s; pay later settled by the merchant server (`payInvoice` 108,892–143,092 gas); pay with stocks filled by a 1inch Aqua maker (0.040798 NVDA at $184.61 → 7.50 USDG, maker fee 0.0377 USDG); CRE carries `Drawn` and `Repaid` back to `NorenCredit` |
| Headless Chromium, private payment against `pnpm dev:all` | ASP approval ~6 s after the shield; proof in the browser 1.09–1.13 s; click to paid 2.0–6.0 s; payer address in the tx: none |
| CRE pricing at `dev:all` start | `NorenRateOracle` written through the MockKeystoneForwarder in 5.0–5.3 s; a €6.90 invoice (7.740672 USDC) passes `verifyQuote` at its own Chainlink rounds |
| CRE credit bridge relay | one simulator run per event, 4.6–5.2 s, `--broadcast` through the Arc and Robinhood forwarders |
| Settle to Arc | CRE settlement-desk workflow approved 7.50 USDG (Relay 7.475568, Across 7.491332 USDC quoted; fair 7.501225; minimum 7.426212) in 6.4–7.1 s. The Across SpokePool is not on the snapshot node, so the deposit for an Across approval is shown, not executed. |
| Robinhood contracts (`sh packages/robinhood/scripts/test-fork.sh`) | **112 passed**, 8 suites, fresh mainnet fork (incl. Aqua maker routing, Pay in 3, SwapVM liquidations) |
| 1inch Aqua SwapVM extension (`sh packages/aqua/scripts/test-swapvm.sh`) | **18 passed** (`NorenOraclePeg`, router against the official Aqua registry) |
| 1inch Aqua demo (`sh packages/aqua/scripts/aqua-demo.sh`) | ten steps with fork tx hashes and real ERC-20 deltas; recorded run in `packages/aqua/demo/aqua-demo-transcript.txt` |
| `NorenCreditLine` (`forge test` in packages/arc-credit) | **47 passed** |
| `NorenRateOracle` (`forge test` in packages/contracts) | **22 passed** (the `NorenCheckout` suite needs the e2e fixture and runs inside `pnpm e2e`) |
| CRE workflows (`bun test`) | credit bridge **31 passed**, pricing **8 passed** |

Browser QA at 1440 and 375 px (landing, Noren Merchant home/payments/payment/balances, Noren app, checkout with all three methods): no horizontal overflow on any route.

## Earlier results

### Phase 2

## Local stack update (2026-11-06)

`pnpm test`: **9 passed, 0 failed** across 2 Vitest files. The server tests cover draft binding, dev config, merchant token protection, invoice listing, faucet rate limiting, and exact payment validation. `pnpm exec tsc --noEmit`: passed. `pnpm e2e`: **9 Foundry tests passed, 0 failed, 0 skipped** against the real pool and verifiers; the HTTP invoice flow now creates a draft and binds customer commitments before proving. The e2e summary reported 5 attack reverts and 41.03 s total.

`pnpm dev:stack` started the Anvil fork, deployed the contracts, printed RPC/server/ASP URLs and one merchant token, and served `/config`. A live faucet request returned both gas and USDC transaction hashes; a repeated request for the same address was rejected. Ctrl-C stopped the server and the fork. A throwaway Vite 7.2.2 production build under `/private/tmp` succeeded with the `assert` alias in [packages/core/BROWSER.md](packages/core/BROWSER.md); browser proving itself was not run.

The earlier baseline measurements follow.

Run on 2026-11-06 (local Arc testnet fork at chain 5042002; no public transactions). Commands:

```sh
pnpm install --store-dir '/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.pnpm-store'
pnpm test
pnpm exec tsc --noEmit
pnpm e2e
```

`pnpm test`: **7 passed, 0 failed** across 2 Vitest files (3 core encoding cases, 4 server validation cases). `pnpm exec tsc --noEmit`: passed. The e2e command ran **9 Foundry tests passed, 0 failed, 0 skipped** against the real 0xbow pool and Groth16 verifier using a fresh Kohaku proof.

The full e2e finished in **40.78 s**. A 20 USDC shield deposit used **352,744 gas** with the fork-only USDC shim. The first 7.50 USDC invoice proof took **1.245 s** with the artifact cache warm; after a new ASP root, re-proving took **1.080 s**. The merchant paid through the HTTP server, refunded 2.50 USDC, and the customer's separate refund account showed 2.50 as pending and then approved after the postman published a new root. A separate pool deposit from an address marked blacklisted in the fork USDC shim left the ASP root unchanged.

Exact on-chain revert checks: stale ASP root → `IncorrectASPRoot`, altered payee → `ContextMismatch`, outsider relay → `NotMerchant`, expired invoice → `Expired`, replay → `AlreadyPaid`. Each check also submitted a transaction and observed a reverted receipt. The stale-root proof was regenerated and then paid successfully.

Selected local-fork transaction hashes from this run:

| Action | Hash |
| --- | --- |
| 20 USDC shield | `0xb593120a56f9b99fa9697fc2f39a6da349020063079f1d1e7a900feaffb27031` |
| Blacklisted pool deposit | `0xb27f31503444c3086490cf9837d3bc5b6aafdcd915b33dddbe2d1db949ea7ca0` |
| Initial ASP root | `0x03516fd26a16db9fec842711d75a8461f3a9d507aef3c855cd1a9d3dc9116134` |
| New ASP root | `0xe67ea8c756d8c217eb7980787cb2af1dc59fb46d1eb1af12dde26df2d609e078` |
| Merchant payment | `0x8106fc58cafad0d7d6690b271b0feab14e74db61a1752db31f15b67a2614398d` |
| Refund approval | `0x137f2c2e5d67d59e730539e20234d226d9b06b3d580267d704084252df38225d` |
| Refund deposit | `0xa0f9e67cdb3f704fc83f2df8a3cf780f7b9891baee6c1bf47a83d9ef3ef8d41e` |
| Refund ASP root | `0xf46913daf1026ea0bda460e94fa5f9bad9cdbcbbf68709d4c0e7fc6a3e3779da` |

The Anvil-only USDC shim is necessary because stock Anvil cannot execute Arc's native USDC bridge; the pool, Entrypoint, and verifiers were not mocked. These hashes disappear when the fork exits. Live Arc gas and browser proving time remain unmeasured. Arc testnet deployment was intentionally not attempted.

## Browser flow (packages/web, Nov 6 2026)

Headless Chromium against `pnpm dev:stack` (local fork): merchant console created a 7.50 USDC invoice; a fresh browser wallet took test USDC from the fork-only faucet, approved USDC to the Entrypoint, shielded 20 USDC (ASP approval after ~6 s), bound the invoice, **proved in the browser in 2.18 s**, and the merchant server relayed the payment (~4.5 s click-to-paid). The console showed `Paid`, then `Refunded` after a 2.50 refund; the customer saw 12.50 private balance and 2.50 in the refund inbox. Two bugs found and fixed in this run: the shield step must approve USDC first (Kohaku returns only the deposit), and the ASP tree endpoint needed CORS for browsers.
# World is Flat edition (`wif`, November 9, 2026)

| Check | Result |
|---|---|
| Real deployed v4 WIF and USDG pools on a latest-block Robinhood Chain fork (`NorenWifRouterTest`) | **1 passed**: exact USDG output for WIF and USDG-funded WIF buy |
| WIF gateway fork suite (`NorenWifEditionTest`) | **3 passed**: WIF pays invoice with slippage bound and fee waiver; USDG and NVDA accrue fees; `burnAccrued` emits the amount burned, reduces real WIF total supply by that amount, and pays a keeper tip; owner-only fee caps and threshold |
| Existing TypeScript suites, `pnpm test` | **157 passed**, 23 files, after excluding the local `.pnpm-store` cache from Vitest discovery |
| `NOREN_EDITION=wif pnpm --filter @noren/web build` | **passed** |
| `DeployWif.s.sol --broadcast` against a fresh local Anvil fork | **passed**, creating the gateway, WIF router, vault and oracle; the WIF server `/config` and fork gateway `totalWifBurned()` read succeeded |
| Local fork runbook sequence on that deployment | **passed**: created 10 USDG and 25 USDG invoices, paid the first with real WIF through the two live v4 pools and the second with real NVDA through the vault, then called `burnAccrued`; the live WIF `totalSupply` fell by exactly **52.906344733525617488 WIF**, matching `totalWifBurned`. Fork-only tx hashes: WIF payment `0xefbff650c143b15c4ad7229e3002d15c12c0f86a0cf288cc2fa4b44e3673068a`, NVDA payment `0x40ca6b15019361e5aaca370eefe1903c8a792680d0d57b62ffad36fa27f835fe`, burn `0xcd26896a716e91bbd81d4378741623ea0cdb260de4523fe9d061dff7bb96deda`. These hashes exist only on the local fork. |
| Full `sh packages/robinhood/scripts/test-fork.sh` | **179 passed, 10 failed, 3 skipped** across 17 suites. All new WIF tests passed in this run. The failures are in older oracle, Aqua, credit and liquidation tests with fixed assumptions about Stock Token feed age, current market price or maker-v4 relative quotes. The WIF router is unset in those fixtures, so their changed gateway/credit paths are inactive. A browser visual check was unavailable because the computer-use browser host could not be reached. |

The full-suite failures mean the requested blanket `forge test` gate is **not yet green**. Do not report it as passed. The public RPC prunes old state, so use a fresh fork at the latest block for further runs.
