# Test results

## Integrated build (branch `web-integration`, Nov 6 2026)

Everything ran on local nodes: an Anvil fork of Arc testnet (chain 5042002) and the Robinhood package's warmed snapshot of Robinhood Chain mainnet state (served as chain 46630 for the CRE simulator). No public transaction was sent; Arc mainnet, Robinhood mainnet, Relay, Across and World were only read.

| Command | Result |
|---|---|
| `pnpm test` | **99 passed**, 0 failed, 14 files: core + server 19, World ID 43, 0G credit check 25, Robinhood SDK/underwriter (offline) 9, settlement keeper 3. Fork (`*.fork.test.ts`) and live (`*.live.test.ts`) suites run in their packages. |
| `pnpm exec tsc --noEmit`, `packages/web` typecheck and `vite build` | pass |
| `pnpm e2e` | **9/9** Foundry checkout tests, **5** attack reverts (`IncorrectASPRoot`, `ContextMismatch`, `NotMerchant`, `Expired`, `AlreadyPaid`), first proof 1.277 s, re-proof 1.139 s, refund approved, 39.03 s total |
| `pnpm e2e:credit` (against `pnpm dev:all`) | **8/8** steps, 20.1–33.7 s across runs: fork faucet; EIP-712 attestation from the history underwriter (tier 1, collateral-only floor) verified by `NorenCredit.applyAttestation`; 2 NVDA locked (collateral $371.41 at Chainlink); CRE Robinhood → Arc in 5.0–7.0 s; pay later settled by the merchant server (`payInvoice` 108,892–143,092 gas); pay with stocks filled by a 1inch Aqua maker (0.040798 NVDA at $184.61 → 7.50 USDG, maker fee 0.0377 USDG); CRE carries `Drawn` and `Repaid` back to `NorenCredit` |
| Headless Chromium, private payment against `pnpm dev:all` | ASP approval ~6 s after the shield; proof in the browser 1.09–1.13 s; click to paid 2.0–6.0 s; payer address in the tx: none |
| CRE pricing at `dev:all` start | `NorenRateOracle` written through the MockKeystoneForwarder in 5.0–5.3 s; a €6.90 invoice (7.740672 USDC) passes `verifyQuote` at its own Chainlink rounds |
| CRE credit bridge relay | one simulator run per event, 4.6–5.2 s, `--broadcast` through the Arc and Robinhood forwarders |
| Settle to Arc | CRE settlement-desk workflow approved 7.50 USDG (Relay 7.475568, Across 7.491332 USDC quoted; fair 7.501225; minimum 7.426212) in 6.4–7.1 s. The Across SpokePool is not on the snapshot node, so the deposit for an Across approval is shown, not executed. |
| Robinhood contracts (`sh packages/robinhood/scripts/test-fork.sh`) | **111 passed**, 8 suites, fresh mainnet fork (incl. Aqua maker routing, Pay in 3, SwapVM liquidations) |
| 1inch Aqua SwapVM extension (`sh packages/aqua/scripts/test-swapvm.sh`) | **18 passed** (`NorenOraclePeg`, router against the official Aqua registry) |
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
