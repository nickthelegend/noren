# ETHGlobal Mumbai submission: Noren

> **Before submitting (Nick):** the repo `nickthelegend/noren` is **private**. Make it public, or give the judges access, before you submit. Then paste the demo video link and, if you take the Arc track, the Arc Studio URL.

## Project name
Noren

## Short description (≤ 100 characters)
Private stablecoin checkout for EVM. Or pay with stocks, or pay later on a stock-backed credit line.

(100 characters)

## Description
Paying a shop from a crypto wallet hands it your whole wallet: your address, your balance and every other payment you've made, visible to the shop, its analytics vendor and anyone with a block explorer. Card networks never worked like that.

Noren is a payments stack with three surfaces.

- **Noren Merchant** is a dashboard with payment links, refunds, signed webhooks, balances and API keys. Links can be priced in EUR, JPY, GBP and six other currencies, quoted from Chainlink Data Feeds.
- **The hosted checkout and the Noren app** are for customers. "Pay privately" pays from a Kohaku privacy pool on Arc. The proof is made in the customer's browser and binds the exact invoice, so the merchant gets USDC and a receipt but never the payer's wallet ("Customers identified: 0"). Tamper with the invoice, replay it, relay someone else's, pay after expiry or prove against a stale root, and the contract reverts. We test all five.
- **The Noren SDK** gives merchants `createNoren` and `verifyWebhook`, and gives wallets `shield` and `proveInvoicePayment`.

Customers who want more than private USDC have two more options:

- **Pay with stocks.** Robinhood Chain Stock Tokens (NVDA, TSLA, AAPL…) are sold to Noren's vault at the Chainlink price plus a 0.5% spread, and the merchant receives USDG.
- **Pay later.** The customer locks Stock Tokens on Robinhood Chain. An underwriter reads the wallet's on-chain history and signs an EIP-712 credit attestation, and a sealed model on 0G Private Computer gives a second opinion with a request ID. A Chainlink CRE workflow carries the credit line to Arc, where it pays any Noren checkout upfront. Repayments flow back to Robinhood through the same workflow.
- **No stock?** A customer can verify once with World ID for a small unsecured starter line. Noren keeps only the nullifier.

The checkout says it plainly: only "Pay privately" hides you.

## How it's made
- **Private payments:** EF Kohaku SDK + 0xbow Privacy Pools (Groth16 withdraw circuit, LeanIMT, Entrypoint), with our `NorenCheckout` as the pool's processooor. The withdrawal context commits to (invoiceId, merchant, amount, expiry, refund precommitment, receipt commitment). The merchant's server relays the proof and pays the gas. An ASP postman approves deposits only if Arc USDC's own `isBlacklisted` is false and posts Merkle roots. Refunds go into a shielded refund inbox. Proofs are generated in the browser with snarkjs, using artifacts served by the app itself.
- **Chainlink:** Data Feeds on Arc mainnet (read-only) quote fiat links. A **CRE** TypeScript workflow (cron + HTTP `eth_call`) writes those rates to `NorenRateOracle` on Arc, and the server checks each invoice's quote with `verifyQuote` at its own round IDs. A second CRE workflow is the credit bridge: EVM log triggers on `CreditLineOpened`/`CreditLineClosed` (Robinhood) write `NorenCreditLine.onReport` (Arc), log triggers on `Drawn`/`Repaid` (Arc) write `NorenCredit.onReport` (Robinhood), and an HTTP trigger opens World ID starter lines. Everything runs in the CRE CLI simulator with `--broadcast` through the real MockKeystoneForwarders. Stock collateral is valued with Chainlink stock feeds on Robinhood Chain.
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
  | `pnpm test` | 96 offline tests |
  | `pnpm e2e` | 9/9 Foundry checkout tests, 5/5 attacks reverted, 39.0 s |
  | `pnpm e2e:credit` | 8/8 steps in 24.5 s; CRE Robinhood→Arc in 6.0 s |
  | Robinhood contracts | 94 Foundry tests |
  | `NorenCreditLine` | 47 tests |
  | `NorenRateOracle` | 22 tests |
  | CRE workflows | 31 + 8 bun tests |

  In a browser, a private payment took a 1.13 s proof and 6.0 s from click to paid.
- **AI usage:** Claude (Anthropic) and Codex wrote and reviewed most of the code, tests and docs, as several coordinated agents working on separate branches. We checked every on-chain claim against the forks, and the README numbers come from our own runs. ChatGPT generated the app icon and illustrations, and Google Gemini (Veo) the landing film. The 0G credit check is itself an AI model, and its decision is shown with its request ID.

## Partner prizes (pick at most 3)

**Recommended three: EF Best CROPS App, World Best Use of IDKit, Chainlink Best workflow with CRE.** The alternates (Arc, 0G, 1inch Aqua) are built, or partly built, but each has a hard gap noted below. One EF prize per project; Arc allows one track.

### ✅ 1. Ethereum Foundation: Best CROPS App (recommended)
Requirements: censorship resistant, open source, private, secure; privacy that is structural, not cosmetic; a README CROPS section; a demo of the moment it matters.
- [x] Privacy is structural. The payer is unknown on-chain and to the merchant because of the invoice-bound ZK proof (Kohaku / Privacy Pools), not because of a UI choice. The five on-chain attack checks pass.
- [x] README section titled "CROPS", one paragraph per letter, including what each third party learns.
- [x] No third-party requests from the client: self-hosted fonts and prover artifacts; RPC only to the chain.
- [x] Open source: MIT, one-command local build (`pnpm dev:all`). **Nick: make the repo public.**
- [ ] Demo (≤ 3 min) leads with the property: Noren Merchant shows the payment with "Customer: Private" and "Customers identified: 0". (Record.)

### ✅ 2. World: Best Use of IDKit (recommended)
Requirements: a real "trust moment", the minimum sufficient credential, verification on the server or on-chain.
- [x] Trust moment: an unsecured credit line has no collateral, so one human must get only one (Sybil resistance). World ID unlocks a 25 USDC starter line.
- [x] Minimum sufficient credential: Selfie Check by default (configurable to Proof of Human or Passport). Noren stores only the nullifier.
- [x] Server-side verification with World's verify API, IDKit 4 server-signed requests, and a nullifier registry; success, cancelled and already-used paths are handled.
- [ ] **BLOCKED (Nick):** create the World Developer Portal app (action `noren-credit`) and set `WORLD_APP_ID`, `WORLD_RP_ID` and `WORLD_RP_SIGNING_KEY` in `.env`. Until then the app shows "Setup required". Then record the success and already-used paths.

### ✅ 3. Chainlink: Best workflow with CRE (recommended)
Requirements: "a CRE Workflow that's used as an orchestration layer within your project"; "integrate at least one blockchain with an external API, system, data source, LLM, or AI agent"; "a successful simulation (via the CRE CLI) or a live deployment"; "meaningfully used".
- [x] Two workflows, both used in the product. The credit bridge (Robinhood Chain ↔ Arc: 3 log triggers + 1 HTTP trigger) carries every credit line, draw and repayment. The pricing workflow brings Chainlink fiat feeds from Arc mainnet (external RPC) to `NorenRateOracle` on Arc, where invoices are re-verified.
- [x] Successful simulations with `--broadcast` through the forwarders: 4.6–5.2 s per event; `pnpm e2e:credit` drives both directions.
- [x] Also uses Chainlink Data Feeds (Arc fiat feeds, Robinhood stock, ETH and USDG feeds).
- [ ] Show `cre workflow simulate` output in the demo.

### Alternate: Arc (Circle): Best DeFi / Onchain Finance App Built End to End in Arc Studio
Requirements: start in Arc Studio with a shareable Studio URL shown in the demo; working frontend and backend; architecture diagram; video; repo.
- [x] Working frontend + backend on an Arc testnet fork; USDC settlement; credit pool on Arc; architecture diagram ([docs/img/architecture.png](docs/img/architecture.png)).
- [ ] **BLOCKED (Nick):** `arc-studio login` → `pnpm studio:import` → share the Studio URL. **Honest gap:** the code predates the Studio app, so Studio can only be where the Arc contracts are imported, built, tested and deployed. A strict reading of "starting point" may count against it.
- [ ] **BLOCKED (Nick):** at least 0.45 testnet USDC to `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80` (Circle faucet), then `pnpm deploy:arc`.

### Alternate: 0G: Build with 0G Private Computer
Requirements: inference on 0G Private Computer is in the main user flow; request IDs are shown.
- [x] The credit decision for pay later runs on 0GM-1.0 in private (TeeML) mode, with independent TEE checks. The Noren app shows the decision, rationale, request ID and `tee_verified`.
- [ ] **BLOCKED (Nick):** `ZG_PC_API_KEY` (private-mode key at pc.0g.ai). Until then the check is refused ("Setup required") and the deterministic history score decides, labelled as such.

### Alternate: 1inch: Build an Aqua App
Requirements: a sophisticated position on the official Aqua / SwapVM contracts; on-chain token transfers in the demo (forks OK); real git history.
- [ ] In progress on branch `aqua-liquidity`: maker strategies at Chainlink-pegged prices for pay-with-stocks conversion and liquidations, on the official Aqua + SwapVM deployments on Robinhood Chain. Not merged into this submission yet.

## Links
- Repo: https://github.com/nickthelegend/noren (**private: make public before submitting**)
- Demo video: _(record ≤ 3 min; paste link)_
- Arc Studio URL: _(BLOCKED, see above)_
