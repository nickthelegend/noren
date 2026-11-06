# ETHGlobal Mumbai submission: Noren

> **Before submitting (Nick):** the repo `nickthelegend/noren` is public. Paste the demo video link and the Arc Studio URL (make the Studio app shareable first).

## Project name
Noren

## Short description (≤ 100 characters)
DEX and stablecoin payments on Arc: liquidity, credit, cross-chain settlement. Payers stay private.

(99 characters)

## Description
**Noren is a DEX and stablecoin payment infrastructure on Arc (liquidity, credit lines and cross-chain settlement), and every payment is private: a merchant never learns which customer paid.**

- **1inch Aqua** is the engine that turns anything into the merchant's USDC: stock payments, liquidations and cross-chain fills.
- **Circle CCTP V2 and Chainlink CCIP** bring money and orders from other chains to Arc, into one `NorenArcActionRouter`.
- **Chainlink CRE** orchestrates the chains and checks prices against Chainlink Data Feeds.
- **World ID and 0G** grant credit safely to real humans; **Earn/Borrow** is where the credit comes from.
- Swaps and bridges are public. The payment is what's private: Kohaku privacy pools on Arc.

Paying a shop from a crypto wallet hands it your whole wallet: your address, your balance and every other payment you've made, visible to the shop, its analytics vendor and anyone with a block explorer. Card networks never worked like that.

Noren is a payments stack with three surfaces.

- **Noren Merchant** is a dashboard with payment links, refunds, signed webhooks, balances and API keys. Links can be priced in EUR, JPY, GBP and six other currencies, quoted from Chainlink Data Feeds.
- **The hosted checkout and the Noren app** are for customers. "Pay privately" pays from a Kohaku privacy pool on Arc. The proof is made in the customer's browser and binds the exact invoice, so the merchant gets USDC and a receipt but never the payer's wallet ("Customers identified: 0"). Tamper with the invoice, replay it, relay someone else's, pay after expiry or prove against a stale root, and the contract reverts. We test all five.
- **The Noren SDK** gives merchants `createNoren` and `verifyWebhook`, and gives wallets `shield` and `proveInvoicePayment`.

Customers who want more than private USDC have two more options:

- **Pay with stocks.** Robinhood Chain Stock Tokens (NVDA, TSLA, AAPL…) are sold to a 1inch Aqua maker at a Chainlink-pegged price, quoted by our own SwapVM instruction. Noren's vault is the fallback. The merchant receives USDG.
- **Pay later.** The customer locks Stock Tokens on Robinhood Chain. An underwriter reads the wallet's on-chain history and signs an EIP-712 credit attestation, and a sealed model on 0G Private Computer gives a second opinion with a request ID. A Chainlink CRE workflow carries the credit line to Arc, where it pays any Noren checkout upfront. Repayments flow back to Robinhood through the same workflow.
- **No stock?** A customer can verify once with World ID for a small unsecured starter line. Noren keeps only the nullifier.

**From any chain.** A customer can bring USDC to Arc from 10 CCTP V2 testnets, or pay a checkout from another chain: Circle burns the USDC there, Noren's Chainlink CRE relay fetches Circle's attestation and mints it on Arc through `NorenArcHook`, and a PAY_INVOICE hook pays the merchant on arrival (live: Base Sepolia → Arc, `InvoicePaid`). Chainlink CCIP carries credit instructions into the same router (live: Ethereum Sepolia → Arc pay-on-credit, delivered; Robinhood → Base hub → Arc). A cross-chain swap sells NVDA on Robinhood Chain for USDC on Arc from a 1inch Aqua maker, with CRE carrying the order and the fill (fork demo).

The checkout says it plainly: "Pay privately" is the default, and it is the only method that hides the payer.

## How it's made
- **Private payments:** EF Kohaku SDK + 0xbow Privacy Pools (Groth16 withdraw circuit, LeanIMT, Entrypoint), with our `NorenCheckout` as the pool's processooor. The withdrawal context commits to (invoiceId, merchant, amount, expiry, refund precommitment, receipt commitment). The merchant's server relays the proof and pays the gas. An ASP postman approves deposits only if Arc USDC's own `isBlacklisted` is false and posts Merkle roots. Refunds go into a shielded refund inbox. Proofs are generated in the browser with snarkjs, using artifacts served by the app itself.
- **Chainlink:** Data Feeds on Arc mainnet (read-only) quote fiat links. A **CRE** TypeScript workflow (cron + HTTP `eth_call`) writes those rates to `NorenRateOracle` on Arc, and the server checks each invoice's quote with `verifyQuote` at its own round IDs. A second CRE workflow is the credit bridge: EVM log triggers on `CreditLineOpened`/`CreditLineClosed` (Robinhood) write `NorenCreditLine.onReport` (Arc), log triggers on `Drawn`/`Repaid` (Arc) write `NorenCredit.onReport` (Robinhood), and an HTTP trigger opens World ID starter lines. A third, the settlement desk, approves moving a merchant's USDG to USDC on Arc only when live Relay and Across quotes agree with Chainlink USDG/USD and USDC/USD; a keeper then deposits into Relay (on a fork no relayer fills the Arc side). Everything runs in the CRE CLI simulator with `--broadcast` through the real MockKeystoneForwarders. Stock collateral is valued with Chainlink stock feeds on Robinhood Chain.
- **1inch Aqua + SwapVM:** `NorenOraclePeg` is a new SwapVM instruction (opcode 34) that prices a Stock Token from its Chainlink feed and `uiMultiplier`, with a maker-set spread. `NorenAquaSwapVMRouter` is the official AquaSwapVMRouter plus that opcode, against the official Aqua registry on Robinhood Chain. `NorenLiquidity` registers maker strategies, routes each stock payment to the best maker quote (vault fallback) and sells liquidated collateral to makers.
- **Circle CCTP V2:** `NorenArcHook` on Arc testnet is the `destinationCaller` of every Noren burn, so only Noren can finish it; it mints through Circle's MessageTransmitterV2 and hands hook actions to `NorenArcActionRouter`. A CRE workflow (`packages/cctp/cre/cctp-relay`) watches `MessageSent` on 10 chains, fetches the Iris attestation with HTTP consensus and writes it to the hook. `@noren/cctp` (`bridgeToArc`, `burnFromArc`) drives the Noren app's "Bring USDC to Arc" and the checkout's "Pay from another chain".
- **Chainlink CCIP:** `NorenCcipGateway` on Arc, Base Sepolia, Ethereum Sepolia and Robinhood testnet, a `NorenCcipHub` on Base Sepolia (Robinhood has no lane to Arc) and `NorenCcipInbox` for the reverse path. Every message carries a Noren envelope; replay, out-of-order and failed-action cases are handled and tested on forks of the real CCIP 2.0 contracts.
- **Cross-chain Aqua:** `NorenCrossChainEscrow` on the source chain locks the taker's token and reads its Chainlink round; CRE carries the order to `NorenCrossChainSettler` on Arc, which fills it from a maker's `NorenOraclePeg` strategy through the official Aqua bytecode; CRE carries the fill back and the escrow releases the token. `pnpm dev:all` deploys it and the Noren app's Swap tab has a Cross-chain toggle.
- **Robinhood Chain:** `NorenCredit` (EIP-712 attestations, credit tiers that move with repayment history, liquidation), `NorenGateway` (pay an invoice with USDG, ETH or Stock Tokens), `NorenVault` (ERC-4626 USDG liquidity) and `NorenAssetOracle` (uiMultiplier-aware, with a haircut when markets are closed). They run against the real Stock Token, USDG and Chainlink contracts on a warmed snapshot of mainnet state, because Robinhood testnet has no feeds.
- **Arc:** `NorenCheckout`, `NorenCreditLine` (revolving USDC credit pool, one draw per invoice) and `NorenRateOracle`. Gas and settlement are in USDC. `scripts/deploy-arc.ts` measures a dry run of the deploy on a fork from the real deployer.
- **0G Private Computer:** model 0GM-1.0 in private (TeeML) mode, a strict JSON schema, policy caps, and independent checks of the TEE signer and TDX quote. The request ID and `tee_verified` are shown next to the decision. There is no fallback scorer.
- **World ID:** IDKit 4 with server-signed requests, verification with World's API, and a nullifier registry (one starter line per human).
- **Web:** React + Vite. Noren Merchant, the Noren app, the hosted checkout and the landing page. Geist and Instrument Serif fonts are self-hosted, so the client makes no third-party requests.
- **Hacky bits:**
  - CRE only knows Robinhood *testnet*, but the stock feeds live on mainnet. We serve the mainnet snapshot as chain 46630 and copy testnet's real simulation forwarder onto it.
  - Anvil's built-in signer keeps the old chain id after `anvil_setChainId`, so the merchant's Robinhood transactions are sent as an impersonated account.
  - A fork of Robinhood's public RPC dies after about 10 minutes, so we use a warmed state dump.
- **Tests:**

  | Suite | Result |
  |---|---|
  | All suites on the final build (TESTING.md) | **543 passed**, 0 failed, 1 weekend-only skip |
  | `pnpm test` | 136 offline tests |
  | `pnpm e2e` | 9/9 Foundry checkout tests, 5/5 attacks reverted, 47.6 s |
  | `pnpm e2e:credit` | 8/8 steps in 30.3 s; CRE Robinhood→Arc in 6.0 s |
  | Robinhood contracts incl. Aqua routing and Pay in 3 | 134 Foundry tests on a fresh mainnet fork |
  | CCTP (`NorenArcHook`) / CCIP (gateways, hub, router, `NorenShieldSink`) | 24 / 32 Foundry tests, incl. forks of the real Circle and CCIP 2.0 contracts |
  | Cross-chain Aqua / Aqua on Arc | 31 / 8 fork tests |
  | `NorenOraclePeg` / Aqua router (SwapVM) | 17 + 1 weekend-only |
  | `NorenCreditLine` / `NorenRateOracle` | 47 / 22 |
  | CRE workflows (bun) | 31 + 8 + 8 + 15 + 14 |

  In a browser, a private payment took a 1.13 s proof and 6.0 s from click to paid.
- **AI usage:** Claude (Anthropic) and Codex wrote and reviewed most of the code, tests and docs, as several coordinated agents working on separate branches. We checked every on-chain claim against the forks, and the README numbers come from our own runs. ChatGPT generated the app icon and illustrations, and Google Gemini (Veo) the landing film. The 0G credit check is itself an AI model, and its decision is shown with its request ID.

## Partner prizes (pick at most 3)

**Recommended three: 1inch Build an Aqua App, Chainlink (CRE, with CCIP now live), Arc.** They match the positioning: Aqua is the engine, CCTP and CCIP bring money and orders to Arc, CRE orchestrates and checks prices, Arc is the hub. **World IDKit is the alternate** (needs one real World App verification on camera). EF CROPS and 0G remain eligible alternates. Arc allows one track; one EF prize per project.

### ✅ 1. 1inch: Build an Aqua App (recommended): Aqua is the engine
Requirements: a sophisticated DeFi position on the **official** Aqua / SwapVM contracts (custom SwapVM instructions score higher); **on-chain token transfers in the demo** (forks are allowed); **real, steady git history**.
- [x] Official contracts: the official Aqua registry `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` on Robinhood Chain (4663). SwapVM is the official AquaSwapVMRouter (`0x111111338c5091E8440b67B168bAe16a668AC0De`, v1.0.2) plus one custom opcode, `NorenOraclePeg` (custom instructions score higher). Because it has the added opcode, the router is redeployed on the fork rather than called at the official address.
- [x] The position: Aqua makers quote Stock Tokens at Chainlink-pegged prices (`NorenOraclePeg`) from one wallet balance shared across strategies. They fill pay-with-stocks payments (best execution, with `NorenVault` as fallback) and buy collateral in Pay in 3 and credit-line liquidations.
- [x] On-chain token transfers on a Robinhood mainnet fork: `pnpm e2e:credit` pays an invoice with 0.040798 NVDA, filled by an Aqua maker (`MakerFill`, fee 0.0377 USDG), and Noren Merchant shows the maker and strategy. Liquidation through SwapVM is covered by the package's fork tests.
- [ ] Show the Aqua-filled stock payment (and a liquidation) in the demo.
- [x] Steady commit history: separate commits per contract and test suite on `aqua-liquidity` (`git log origin/aqua-liquidity`).
- [x] **Cross-chain fills:** an Arc maker fills orders opened on Robinhood Chain (NVDA) and Base Sepolia (WETH) from one USDC wallet, priced by the same `NorenOraclePeg`; CRE carries order and fill. Fork tests in `packages/xchain-aqua`, and the Noren app's Swap → Cross-chain runs it end to end on `pnpm dev:all` (1 NVDA → 183.81 USDC on Arc, escrow released to the maker).
- [x] **Live on Arc testnet** ([docs/AQUA-LIVE.md](docs/AQUA-LIVE.md)): official Aqua v1.0.0, unmodified, at `0x550CD499f1E2da71527f14d6469364461966895B` (the canonical `0x1111…` address can't be reproduced on Arc testnet: 1inch's CREATE3 factory has no code there); our SwapVM router (official SwapVM + `NorenOraclePeg`) at `0x8717…e295`; `NorenCrossChainSettler` at `0xd9f9…d016`. A maker ships a Chainlink-pegged USDC → EURC strategy; direct swap [`0xc7dfd911…`](https://explorer.testnet.arc.io/tx/0xc7dfd9119afe91a1f77cb253d1ae9f75420ccd65e61fcba55dbe10ac21d96cd8) (0.5 USDC → 0.444364 EURC).
- [x] **Cross-chain fills, live:** CCTP V2 burns on Arbitrum Sepolia and Ethereum Sepolia carry an AQUA_ORDER hook; CRE mints on Arc (`AquaOrderOpened` on the router) and a CRE ROUTER_ORDER report fills it from the same maker ([`0xe6dab620…`](https://explorer.testnet.arc.io/tx/0xe6dab62029db1e6924cb6ff6e229248e7bbb29d6863c2157fdb0a9dd01568dd7), [`0x243cc90e…`](https://explorer.testnet.arc.io/tx/0x243cc90eed57c6273fc790d91e73ec5af25bd29a0c3d38c20c0bbd26f955dd93)).
- [ ] Show the cross-chain fill in the demo (Swap → Cross-chain).
- [x] Merged into `web-integration`; the Robinhood snapshot was rebuilt with the Aqua makers and `pnpm e2e:credit` passes 8/8.

### ✅ 2. Chainlink: Best workflow with CRE (recommended), plus CCIP now that it is live
Requirements: "a CRE Workflow that's used as an orchestration layer within your project"; "integrate at least one blockchain with an external API, system, data source, LLM, or AI agent"; "a successful simulation (via the CRE CLI) or a live deployment"; "meaningfully used".
- [x] Five workflows, all used in the product:
  - **CCTP relay** (log triggers on 10 chains + Iris HTTP with consensus) finishes every CCTP transfer into Arc; live writes on Arc testnet from Base, Arbitrum and Robinhood burns.
  - **Cross-chain Aqua** carries each order and its Chainlink round to the Arc settler and the fill back to the source escrow.
  - **Credit bridge** (Robinhood Chain ↔ Arc; 3 log triggers + 1 HTTP trigger) carries every credit line, draw and repayment.
  - **Pricing** brings Chainlink fiat feeds from Arc mainnet (external RPC) to `NorenRateOracle` on Arc, where every invoice quote is re-verified.
  - **Settlement desk** approves USDG → Arc USDC settlements by checking live Relay and Across quotes (external APIs) against Chainlink USDG/USD and USDC/USD.
- [x] Successful simulations with `--broadcast` through the MockKeystoneForwarders: 4.6–5.2 s per bridge event; `pnpm e2e:credit` drives both directions.
- [x] Also uses Chainlink Data Feeds: Arc fiat feeds, and Robinhood stock, ETH and USDG feeds.
- [x] **CCIP live, 7 messages, all delivered** ([docs/CCIP.md](docs/CCIP.md) "Live runs"), including the two-hop Robinhood → Base hub → Arc (CREDIT_LINE, PAY_ON_CREDIT 0.25 USDC), the reverse Arc → hub → Robinhood line report, an out-of-order delivery fixed by `retryFailed`, and a CCIP-BnM transfer finished by manual execution. Honest caveat: messages into Arc carry instructions only; value comes over CCTP, because no CCIP lane carries USDC or BnM into Arc.
- [x] Contracts: `NorenCcipGateway` on Arc, Base Sepolia, Ethereum Sepolia and Robinhood testnet, `NorenCcipHub` on Base Sepolia, `NorenArcActionRouter` on Arc. Messages: Base Sepolia → Arc CREDIT_LINE [`0xc54e5cf9…`](https://ccip.chain.link/msg/0xc54e5cf92c21ef23e7784dd1148e48a91b75eb9a0ff2bc52ab6d4de80664d504) (SUCCESS), Ethereum Sepolia → Arc PAY_ON_CREDIT [`0x3414a5d3…`](https://ccip.chain.link/msg/0x3414a5d397f5c4222aa8a30bc75c085b53127533b62376dc132923b6ec2df1a4) (SUCCESS; `InvoicePaid` on Arc [`0x78d3a38f…`](https://explorer.testnet.arc.io/tx/0x78d3a38fd41c1c2b9bee066a94ad2c83837203cd5b00b9e0bd001155edc7d7ec)), Robinhood → Base hub → Arc [`0x8bf11c20…`](https://ccip.chain.link/msg/0x8bf11c2010e50817e88d2c61a896dbcffde95af5352cda9b0c342f073bac477d) and [`0x5b04344b…`](https://ccip.chain.link/msg/0x5b04344b6baea78121553f912df5dc3e959e320df7712ca4d82a5763559df93d), Arc → Base [`0x8dc21f93…`](https://ccip.chain.link/msg/0x8dc21f93991c32eb1319f9ce95907708c3fa7a27d577fe5b460e5bcc61639ceb). Noren Merchant reads `InvoicePaid` from the live router and shows the source chain.
- [ ] Show `cre workflow simulate` output and a ccip.chain.link message page in the demo.

### ✅ 3. Arc (Circle): Best DeFi / Onchain Finance App Built End to End in Arc Studio (recommended): Arc is the hub
Requirements: start in Arc Studio, with a shareable Studio URL shown in the demo; a working frontend and backend; an architecture diagram; a video; a repo.
Arc is where every payment, credit line and cross-chain transfer lands, in USDC. It is fully qualified once Nick makes the Studio app shareable.
- [x] **Live on Arc testnet** (chain 5042002): NorenCheckout, the Privacy Pools Entrypoint and pool, NorenRateOracle and NorenCreditLine, with a real private 2.50 USDC payment, a 1.00 USDC refund and both Chainlink CRE writes ([docs/LIVE.md](docs/LIVE.md), README "Live on public testnets").
- [x] **Circle CCTP V2 into Arc** from 10 testnets through `NorenArcHook` [`0x8845…B20d`](https://explorer.testnet.arc.io/address/0x8845ae4B87D706c31606182D5A9529b67ee6B20d): Base Sepolia → Arc with the invoice paid on arrival, Arbitrum Sepolia → Arc (plain and an Aqua order), Robinhood ↔ Arc ([docs/CCTP.md](docs/CCTP.md)).
- [x] **Arc Studio app:** https://studio.arc.io/app/074b59c4-98ec-44d4-908e-92f5d97d462b (24 Foundry tests pass locally). **Honest gap:** the code predates the Studio app, so Studio is where the Arc contracts are imported, built, tested and deployed. A strict reading of "starting point" may count against it.
- [x] Working frontend and backend; USDC settlement; credit pool on Arc; architecture diagram ([docs/img/architecture.png](docs/img/architecture.png)). The app, checkout and Noren Merchant switch between the local fork and the live Arc testnet deployment.
- [ ] **Nick:** make the Studio app shareable and show it in the demo video.

### Alternate (first choice): World: Best Use of IDKit
Requirements: a real "trust moment", the minimum sufficient credential, verification on the server or on-chain.
- [x] Trust moment: an unsecured credit line has no collateral, so each human must get only one (Sybil resistance). World ID unlocks a 25 USDC starter line.
- [x] Minimum sufficient credential: Selfie Check by default (Proof of Human or Passport are configurable). Noren stores only the nullifier.
- [x] Server-side verification with World's verify API, IDKit 4 server-signed requests and a nullifier registry. The success, cancelled and already-used paths are handled.
- [x] The World Developer Portal app exists (production RP `rp_84fc8425acb7b1e9`, action `noren-credit`); fake proofs are rejected with 403. A successful verification also records NorenReputation's `verifiedHuman` milestone (EIP-712 attestation), so the borrow LTV tier rises immediately.
- [ ] **Nick:** do one real verification on camera (scan the IDKit QR with World App, Selfie Check; the Orb is paused in India and the simulator is staging-only), then show the already-used path.

### Alternate: Ethereum Foundation: Best CROPS App
Requirements: censorship resistant, open source, private, secure; privacy that is structural, not cosmetic; a README CROPS section; a demo of the moment it matters.
- [x] Privacy is structural. The payer is unknown on-chain and to the merchant because of the invoice-bound ZK proof (Kohaku / Privacy Pools), not because of a UI choice. The five on-chain attack checks pass.
- [x] README section titled "CROPS", one paragraph per letter, including what each third party learns.
- [x] No third-party requests from the client: fonts and prover artifacts are self-hosted, and RPC goes only to the chain.
- [x] Open source: MIT, with a one-command local build (`pnpm dev:all`). The repo is public.
- [ ] Demo (≤ 3 min) that leads with the property: Noren Merchant shows the payment with "Customer: Private" and "Customers identified: 0". (Record.)

### Alternate: 0G: Build with 0G Private Computer
Requirements: inference on 0G Private Computer is in the main user flow; request IDs are shown.
- [x] Live: the pay-later credit decision runs in private (TeeML) mode on glm-5.3 (0GM-1.0's only TeeML provider fails its TLS handshake). A decision is accepted only when Noren's independent check verifies the enclave signature, the quote binding and the TeeML provider record. Live requests `a30b5e94-169c-4cf9-ad71-864acffa1881` and `e3fa908f-0a8e-4ca3-a5c2-0956b918345d` (the second opened a real credit line in the app e2e), both independently verified.
- [x] The Noren app shows the decision, the rationale, the request ID and "verified independently (TeeML)". Each live call is paid, so the app shows the stored decision and asks before a new one.

## Links
- Repo: https://github.com/nickthelegend/noren
- Demo video: _(record ≤ 3 min; paste link)_
- Arc Studio URL: https://studio.arc.io/app/074b59c4-98ec-44d4-908e-92f5d97d462b (make it shareable before submitting)
