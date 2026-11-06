# ETHGlobal Mumbai submission: Noren

> **Nick, before you press submit:**
> 1. Make the Arc Studio app shareable and check it in a private window (on Nov 7 03:05 IST it still redirected to the Circle sign-in).
> 2. Paste the demo video link.
> 3. Pick the partner prizes: **1inch, Chainlink, Arc**.
> 4. Update the GitHub repo description. It still says "Private checkout for merchants on Arc…". Optionally set the homepage to https://noren-app-beta.vercel.app.

## Project name
Noren

## Short description (≤ 100 characters)
Merchants accept stablecoins, stocks or credit — privately. DEX + stablecoin payments on Arc.

(93 characters)

## Description

**Noren lets merchants accept stablecoins, stocks or credit — privately.** A DEX and stablecoin payment network on Arc: private settlement for merchants, credit from lending pools that are 1inch Aqua liquidity, and USDC from any chain.

**The problem.** Paying a shop from a crypto wallet hands it your address, your balance and every other payment you've made. Card networks never worked that way. Crypto credit has the opposite problem: collateral sits idle in a lending contract and earns nothing.

**What Noren does.**
- **Private settlement by default.** The customer pays from a Kohaku privacy pool on Arc. The browser makes a zero-knowledge proof bound to that exact invoice (merchant, amount, expiry, refund address). The merchant relays it and pays the gas. The merchant gets USDC and a signed webhook, never the payer's address. Tamper with the invoice, replay it, relay someone else's, pay after expiry or prove against a stale root, and the contract reverts; all five cases are tested on-chain. Refunds go back into a shielded inbox.
- **Credit against collateral that keeps earning.** Customers lock Stock Tokens (Robinhood Chain) or Earn vault shares. Noren's lender pool and Earn vaults are 1inch Aqua makers, so the same balance backs the loan, earns the spread on every fill and buys liquidated collateral in partial Dutch auctions. A keeper can repay the loan with those fees (`harvestToRepay`). A Chainlink CRE workflow carries the credit line to Arc, where it pays any Noren checkout, publicly or privately ("Pay later, privately" draws the line into the pool).
- **Arc as the hub.** USDC arrives from other chains over Circle CCTP V2. A hook can pay an invoice, open an Aqua order or shield the funds on arrival. Chainlink CCIP carries credit instructions into the same router. Swaps go to Uniswap v4 first; Noren's Aqua maker fills only when it quotes better.
- **Real humans only for unsecured credit.** World ID gives one small starter line per human, and Noren keeps only the nullifier. A sealed model on 0G Private Computer gives a second credit opinion without seeing the address.

**Three surfaces, one product.** Noren Merchant (payment links priced in 9 currencies by Chainlink, refunds, webhooks, balances, credit exposure). The Noren app (one balance, Pay, Send privately, Bridge, Swap, Earn, Borrow, Credit). The Noren SDK (`createNoren`, `verifyWebhook`, `shield`, `proveInvoicePayment`).

**What's live.** A hosted demo: the Noren app and landing at https://noren-app-beta.vercel.app, Noren Merchant and the hosted checkout at https://noren-merchant.vercel.app, and the Aubelle demo shop at https://noren-shop.vercel.app. Frontends are on Vercel, backends on a VPS. Arc is the public Arc testnet, and the Robinhood side is a Robinhood Chain · mainnet snapshot (an Anvil node with real mainnet state; no real money). Hosted, the private checkout runs on public Arc testnet (a hosted end-to-end payment: `0x38b8ce96…b0f5`), Bridge and Swap work, and stock payments run on the snapshot. Pay later and Pay in 3 need the CRE credit bridge, which runs in the CRE CLI simulator, so they work on the local stack only. Visitors fund the app's test key from the Circle faucet (Arc Testnet USDC).

Also on public testnets: the Arc contracts and a private payment, refund and P2P send; a credit line drawn into the pool and paid privately; CRE writes; CCTP from Base, Arbitrum, Ethereum Sepolia and Robinhood testnet into Arc; 10 CCIP messages; and swaps on Arc from the app. The README has every link, and all 135 transaction links, 32 addresses and 10 CCIP messages were re-checked on-chain on Nov 7.

## How it's made

- **Private payments (EF Kohaku + 0xbow Privacy Pools).** `@kohaku-eth/privacy-pools` handles shielding and Groth16 proving in the browser (snarkjs, with the prover artifacts served by the app). Our `NorenCheckout` is the pool's processooor. The withdrawal data commits to (invoiceId, merchant, amount, expiry, refund precommitment, receipt commitment), so the pool's context check rejects any change (`ContextMismatch`). An ASP postman approves deposits only if Arc USDC's own `isBlacklisted` is false. A small local patch lets Kohaku's prover make a custom-processooor withdrawal.
- **1inch Aqua + SwapVM.** We wrote two SwapVM instructions. `NorenOraclePeg` (opcode 34) prices a Stock Token from its Chainlink feed and `uiMultiplier`, with a maker spread that widens while markets are closed. `NorenDutchDecay` (opcode 35) runs partial liquidation auctions. Both are compiled into the official AquaSwapVMRouter. `NorenVault` (the lender pool) and `NorenDepositVault` (Earn) ship strategies to Aqua from their own balances. `NorenLiquidity` routes each stock payment to the best maker quote and sells liquidations to makers. `NorenBorrow.harvestToRepay` pays a loan down with realised fees. On Arc testnet, 1inch's Aqua v1.0.0 runs unmodified at our own address (1inch's CREATE3 factory isn't on Arc testnet); its runtime matches Arc mainnet's Aqua except the metadata hash.
- **Chainlink CRE (5 workflows, TypeScript, `@chainlink/cre-sdk`).**
  - CCTP relay: log triggers on 10 chains, plus Circle Iris over HTTP with consensus. It writes the attestation to `NorenArcHook`.
  - Credit bridge: `CreditLineOpened`/`Closed` on Robinhood write `NorenCreditLine.onReport` on Arc; `Drawn`/`Repaid` on Arc write `NorenCredit.onReport` on Robinhood; an HTTP trigger opens World ID starter lines.
  - Pricing: a cron reads Arc mainnet Chainlink FX feeds over HTTP and writes them to `NorenRateOracle`.
  - Cross-chain Aqua: carries orders and fills between the escrow and the Arc settler.
  - Settlement desk: approves USDG → Arc USDC only when live Relay and Across quotes agree with the Chainlink USDG/USD and USDC/USD feeds.

  All five run as `cre workflow simulate --broadcast` through the MockKeystoneForwarders, with real writes on Arc testnet.
- **Chainlink CCIP 2.0.** `NorenCcipGateway` runs on Arc, Base Sepolia, Ethereum Sepolia and Robinhood testnet. `NorenCcipHub` sits on Base Sepolia, because Robinhood has no lane to Arc. `NorenArcActionRouter` on Arc is the one router that both CCIP and CCTP land in. Messages carry a Noren envelope, with replay, out-of-order and failed-message (`retryFailed`) handling. These are tested on forks of the real CCIP 2.0 Router, OnRamp and OffRamp.
- **Circle CCTP V2 on Arc.** `NorenArcHook` is the `destinationCaller` of every Noren burn, so only Noren can finish it. It mints through MessageTransmitterV2 and hands PAY_INVOICE, AQUA_ORDER, SHIELD and CREDIT_LINE actions to the router. `@noren/cctp` (`bridgeToArc`, `burnFromArc`) drives the app's Bridge tab.
- **Chainlink Data Feeds.** Arc mainnet fiat feeds price the invoices, and `NorenRateOracle.verifyQuote` re-checks each quote at its own round IDs. Robinhood stock, ETH and USDG feeds value collateral (`NorenAssetOracle`) and peg the makers.
- **Robinhood Chain · mainnet snapshot.**
  - `NorenCredit`: EIP-712 credit attestations from a history underwriter, tiers that move with repayments, Pay in 3, liquidation.
  - `NorenGateway`: pay with stocks, ETH or USDG. Ten assets pay at checkout: SPY, MSFT, AMZN, GOOGL, META, TSLA, AAPL, NVDA, ETH and USDG, each stock and ETH filled by its own Aqua maker (a fork test pays an invoice with all ten). QQQ and COIN have Chainlink feeds on Robinhood Chain but no verified Stock Token address, so they are not accepted.
  - `NorenBorrow` / `NorenReputation`: LTV from 66% up to 80%.

  These run against the real Stock Tokens, USDG and Chainlink feeds.
- **World ID.** IDKit 4 with server-signed requests, `/api/v4/verify` on the server, and a nullifier registry.
- **0G Private Computer.** TeeML mode, a strict JSON schema, policy caps, and our own checks of the enclave signature and the TDX quote. The request ID is shown next to the decision.
- **Web.** React + Vite: the landing page, Noren Merchant, the Noren app and the hosted checkout. Sign-in with a wallet, a browser wallet (EIP-6963) or Privy.
- **Hacky bits.**
  - CRE knows only Robinhood *testnet*, so on the local stack we serve the Robinhood Chain · mainnet snapshot as chain 46630 and install testnet's simulation forwarder on it.
  - A fork of Robinhood's public RPC dies after about 10 minutes, so we load a warmed state dump (the Robinhood Chain · mainnet snapshot, also what the hosted demo serves).
  - Anvil's signer keeps the old chain id after `anvil_setChainId`, so the merchant's Robinhood transactions are sent as an impersonated account.
- **Tests.** **656 passed, 1 skipped, 0 failed, across 21 suites** (TESTING.md has every command; 18 suites re-run on Nov 7): `pnpm test` 155, Robinhood fork 188 (incl. paying with each of the 10 assets), SwapVM 27, CRE 76, CCTP 27, CCIP 37 + 2 live, `NorenCreditLine` 62, `NorenRateOracle` 22, cross-chain Aqua 39, `pnpm e2e` 9 plus 5/5 attacks reverted. `pnpm e2e:credit` passes 8/8 steps in 26–31 s.
- **AI usage.** Claude (Anthropic) and Codex wrote and reviewed most of the code, tests and docs, as coordinated agents on separate branches. On-chain claims were checked against the chains. ChatGPT made the icon and illustrations; Google Gemini (Veo) made the landing film.

## Partner prizes (3)

### 1. 1inch: Build an Aqua App
*Requirement: "a sophisticated DeFi position on official Aqua/SwapVM contracts; custom SwapVM opcodes … scored higher; onchain token transfers in the demo (forks ok); real git history."*

Noren's lending pools are Aqua makers. `NorenVault` (lender pool) and `NorenDepositVault` (Earn) each ship a Chainlink-pegged strategy from their own balance. That one balance:
- backs loans;
- earns the spread on fills (stock payments, cross-chain orders, swaps where it beats Uniswap);
- buys liquidated collateral in partial Dutch auctions.

`harvestToRepay` repays a loan from those fees. On a local fork of Robinhood Chain mainnet, 500.000001 USDG of debt fell to 497.055664 after two real fills.

We added two SwapVM opcodes: `NorenOraclePeg` (34) and `NorenDutchDecay` (35), with 27 tests. The official Aqua registry runs on the Robinhood Chain · mainnet snapshot. Aqua v1.0.0, unmodified, runs on Arc testnet, with live swaps there:
- direct swap: `explorer.testnet.arc.io/tx/0xc7dfd911…`
- from the app: `0x12df0a9c…`
- cross-chain fills from CCTP burns on Arbitrum and Ethereum Sepolia: `0xe6dab620…`, `0x243cc90e…`

The history is 400+ commits on `main` since Nov 6 03:57 IST. **Verify in 2 min:** README → Sponsor integrations → 1inch row (source lines and tx links); `docs/AQUA-LIVE.md`.

### 2. Chainlink: Best workflow with CRE, and Best use of CCIP 2.0
*CRE requirement: "a CRE Workflow that's used as an orchestration layer … integrate at least one blockchain with an external API … a successful simulation (via the CRE CLI) … meaningfully used."*

Five workflows are the orchestration layer: CCTP relay (Circle Iris), credit bridge (Robinhood ⇄ Arc), pricing (Arc mainnet feeds), cross-chain Aqua, and settlement desk (Relay and Across quotes against Chainlink feeds). Each runs with `cre workflow simulate --broadcast`, and each has public Arc testnet writes:
- FX rates: `0xa7f67bcc…`
- credit line: `0x2b066d78…`
- CCTP arrival paying an invoice: `0x5f752147…`

76 workflow tests.

*CCIP requirement: "use Chainlink CCIP … to make a state change on a blockchain … inside your smart contracts."*

`NorenCcipGateway` and `NorenCcipHub` are CCIP receivers. 7 live runs (10 messages, all SUCCESS on ccip.chain.link):
- Base → Arc opened a credit line;
- Ethereum Sepolia → Arc paid a merchant on Arc, after an out-of-order arrival was fixed by `retryFailed`;
- Robinhood → Base hub → Arc paid on credit;
- Arc → hub → Robinhood reported the line back.

**Verify:** `docs/CCIP.md` § Live runs, `docs/CRE-PRICING.md`, `docs/BRIDGE.md`.

### 3. Arc: Best DeFi / Onchain Finance App Built End to End in Arc Studio
*Requirement: Arc Studio as the starting point with a shareable URL shown in the demo; working frontend and backend; architecture diagram; video; repo.*

Arc is where every payment, credit line and cross-chain transfer lands, in USDC. The checkout, Privacy Pools USDC pool, `NorenRateOracle`, `NorenCreditLine`, CCTP hook, CCIP gateway, action router and Aqua all run on Arc testnet, with the live private payment, refund, pay-later-privately, CRE writes, CCTP and CCIP arrivals linked in the README.

The Studio app (https://studio.arc.io/app/074b59c4-98ec-44d4-908e-92f5d97d462b) imported and compiled the Arc contracts, ran 24 Foundry tests (24/24 re-run locally), verified the live deployment and built a console.

**Honest gap:** the code came before the Studio app, so a strict reading of "starting point" counts against us. The URL must be made shareable (Nick).

### Alternate: World: Best Use of IDKit
One unsecured starter line per human, with Selfie Check. IDKit 4 server-signed requests, server verification via `/api/v4/verify`, and a nullifier registry (43 tests). The success, cancelled and already-used paths are handled. One real production verification is recorded: Proof of Human (Orb credential) in World App on Nov 6 2026, 11:01 UTC, verified by `/api/v4/verify` (action `noren-credit`); the 25 USDC starter line it triggered was written on the local Arc fork. The film shows it at 1:54.

Also eligible, but not picked: EF Best CROPS App (README § CROPS; privacy comes from the invoice-bound proof) and 0G Private Computer (the sealed credit check, [docs/0G.md](docs/0G.md)).

## Links
- Repo: https://github.com/nickthelegend/noren (`main`)
- Live demo: https://noren-app-beta.vercel.app (app + landing) · https://noren-merchant.vercel.app (Noren Merchant + checkout) · https://noren-shop.vercel.app (Aubelle shop)
- Demo video: _(paste)_
- Arc Studio: https://studio.arc.io/app/074b59c4-98ec-44d4-908e-92f5d97d462b _(make shareable)_
