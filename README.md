# Noren (暖簾)

**Private payments for EVM, with stocks and credit when you want them.** Merchants get payment links, a hosted checkout, refunds, signed webhooks and USDC on Arc. Customers pay from a [Kohaku](https://github.com/ethereum/kohaku) privacy pool, so the merchant gets the money and a receipt but never the customer's wallet. Customers who'd rather pay with Robinhood Chain Stock Tokens, or pay later on a credit line backed by them, can do that too. A Chainlink CRE workflow carries the credit line from Robinhood Chain to Arc.

ETHGlobal Mumbai entry. Everything below runs on local forks; every number was measured on Nov 6, 2026.

![Noren checkout: pay privately, pay with stocks, or pay later](docs/img/checkout-methods.png)

## One product, three surfaces

| Surface | Route | What it does |
|---|---|---|
| **Noren Merchant** | `#/dashboard` | Payments with the method used (private pool, pay with stocks, pay later), payment links priced in 9 currencies by Chainlink, refunds, balances, webhooks, API keys, credit-line exposure, and **Settle to Arc** for USDG earned from stock payments. "Customers identified: 0" for private payments. |
| **Noren app** | `#/app` | The customer's side: private balance, Stock Tokens at live Chainlink prices, a credit score from on-chain history (and a sealed AI second opinion on 0G), lock stock for a credit line, watch Chainlink CRE bridge it to Arc, repay. No stock? Verify with World ID for a small starter line. |
| **Noren SDK** | `@noren/core` | `createNoren` (invoices, refunds, webhooks, `verifyWebhook`) for merchants; `shield`, `refundInbox`, `proveInvoicePayment` for customers. The hosted checkout `#/pay/:id` is the drop-in. |

```ts
import { createNoren, verifyWebhook } from "@noren/core/merchant";
const noren = createNoren({ server, token: process.env.NOREN_SECRET_KEY, merchant });
const { invoice } = await noren.invoices.create({ amount: 7_500_000n, description: "Flat white", expiresIn: 1800 });
// send the customer to /pay/{invoice.invoiceId}; later, in your webhook handler:
const event = await verifyWebhook(rawBody, req.headers["noren-signature"], secret); // payment.succeeded → fulfil
```

## Three ways to pay one invoice

| | Pay privately | Pay with stocks | Pay later |
|---|---|---|---|
| Customer pays with | USDC in a Kohaku privacy pool (Arc) | NVDA, TSLA, AAPL… Stock Tokens (Robinhood Chain) | A USDC credit line on Arc, backed by locked Stock Tokens |
| Merchant receives | USDC on Arc, in the payment tx | USDG on Robinhood Chain, from a 1inch Aqua maker (or Noren's vault as fallback) | USDC on Arc, upfront, from the credit pool |
| Merchant learns the payer | **no**: the proof binds the invoice, not a wallet | yes (public wallet) | yes (the line is public) |
| Contract | `NorenCheckout` + 0xbow Privacy Pools | `NorenGateway` → `NorenLiquidity` (1inch Aqua + SwapVM), `NorenVault` fallback | `NorenCredit` (Robinhood) ↔ CRE ↔ `NorenCreditLine` (Arc) |
| Price | Chainlink fiat feeds (Arc mainnet, read-only) | Chainlink stock feeds (Robinhood): makers quote through the `NorenOraclePeg` SwapVM instruction; the vault adds a 0.50% spread | Chainlink stock feeds value the collateral |

The checkout says it plainly: only "Pay privately" hides you.

## Measured (local forks, Nov 6 2026)

| What | Result |
|---|---|
| `pnpm test` (offline suites across the monorepo) | **99 passed**, 14 files |
| `pnpm e2e`: private payment on an Arc testnet fork, real 0xbow pool and Groth16 verifier | **9/9** Foundry checkout tests, **5/5** attacks reverted on-chain (`IncorrectASPRoot`, `ContextMismatch`, `NotMerchant`, `Expired`, `AlreadyPaid`), proof 1.28 s, re-proof 1.14 s, 39.0 s total |
| Private payment in headless Chromium against `pnpm dev:all` | shield approved by the ASP in **6.1 s**, proof made in the browser in **1.13 s**, click to paid **6.0 s**, payer address in the tx: **none** |
| `pnpm e2e:credit`: pay with stocks + pay later, end to end | **8/8** steps in **24.5 s**: fork faucet → EIP-712 attestation verified on-chain → 2 NVDA locked → **CRE Robinhood → Arc in 6.0 s** → invoice paid later and settled by the server → 0.040798 NVDA at $184.61 pays a 7.50 invoice, filled by a 1inch Aqua maker (fee 0.0377 USDG; merchant gets 7.50 USDG) → CRE carries `Drawn` and `Repaid` back to Robinhood |
| One CRE simulator run (bridge workflow, `--broadcast` through the MockKeystoneForwarder) | 4.6–5.2 s per event |
| Settle to Arc: CRE settlement-desk workflow on a 7.50 USDG request | live quotes Relay 7.475568 / Across 7.491332 USDC against a Chainlink fair value of 7.501225; approved Across with a 7.426212 minimum in 6.4–7.1 s |
| CRE pricing workflow → `NorenRateOracle` on Arc | written in 5.0 s; a €6.90 invoice (7.740672 USDC) passes `verifyQuote` at its own Chainlink rounds |
| Browser, Noren app | fresh wallet, fork faucet, tier-1 terms (score 13/100, collateral-only floor), 1 NVDA locked → 123.80 USDC line, live on Arc after one CRE run (4.8 s), a ¥1,200 checkout (7.60 USDC via Chainlink) paid later, 1.90 USDC repaid |
| Package suites | `NorenCredit`/`NorenGateway`/`NorenVault` **94** Foundry tests on a fresh Robinhood mainnet fork; `NorenCreditLine` **47**; `NorenRateOracle` **22**; CRE bridge **31** + pricing **8** (bun); World ID **43** and the 0G underwriter **25** run inside `pnpm test` |

Fork transaction hashes vanish when the fork stops, so the numbers above are reproducible with the commands below rather than linked.

## Screens

| Noren Merchant | Noren app |
|---|---|
| ![Noren Merchant home: payment methods, credit-line exposure, recent payments](docs/img/dashboard.png) | ![Noren app: stock on Robinhood, credit score, line bridged to Arc by Chainlink CRE](docs/img/app.png) |
| ![A pay-later payment in Noren Merchant](docs/img/payment-credit.png) | ![Checkout, pay with stocks: Chainlink price and vault spread](docs/img/checkout-stocks.png) |
| ![Balances: USDG from stock payments and Settle to Arc with the CRE approval](docs/img/balances.png) | ![Phone: the Noren app at 375 px](docs/img/mobile-app.png) |

## Architecture

![Noren architecture](docs/img/architecture.png)

Details and flows: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Credit line: [docs/CREDIT.md](docs/CREDIT.md), [docs/BRIDGE.md](docs/BRIDGE.md). Pricing: [docs/CHAINLINK.md](docs/CHAINLINK.md), [docs/CRE-PRICING.md](docs/CRE-PRICING.md). AI credit check: [docs/0G.md](docs/0G.md). World ID: [docs/WORLD.md](docs/WORLD.md). Arc: [docs/ARC.md](docs/ARC.md). API: [docs/API.md](docs/API.md).

## Run it

```sh
pnpm install
pnpm dev:all                    # Arc fork + Robinhood snapshot + contracts + server + ASP + both CRE workflows + underwriters
pnpm --filter @noren/web dev    # http://localhost:5190  (#/dashboard, #/app, #/pay/:id)
```

`pnpm dev:all` prints the merchant secret key for Noren Merchant and a "Setup required" line for anything it can't start. In one process it runs:

- **Arc testnet fork** on :8645 with the real Privacy Pools verifiers, Entrypoint, pool, `NorenCheckout`, `NorenRateOracle` and `NorenCreditLine`. A fork-only USDC shim stands in for Arc's native USDC, which stock Anvil can't execute.
- **Robinhood Chain** on :8646, from the Robinhood package's warmed snapshot of mainnet state: the real Stock Tokens, USDG and Chainlink feeds, with `NorenCredit`, `NorenGateway` and `NorenVault` deployed. The public RPC keeps only about 10 minutes of state, so a live fork breaks; build the snapshot once with `sh packages/robinhood/scripts/fork-snapshot.sh`. The node is served as chain 46630 (Robinhood testnet's id) because that is the only Robinhood chain the CRE simulator knows, and Robinhood testnet's real `MockKeystoneForwarder` is installed on it.
- **CRE**: the pricing workflow runs once at start (live Arc mainnet Chainlink reads, then a write to `NorenRateOracle`). The credit bridge workflow runs in the CRE simulator for every `CreditLineOpened`/`CreditLineClosed` on Robinhood and every `Drawn`/`Repaid` on Arc, with `--broadcast` through the forwarders. The run log is at `GET /credit/bridge`.
- **Merchant server** (:8790), **ASP postman** (:8788), **history underwriter** (:8791), **0G credit check** (:8792), **World ID** routes on the merchant server.

Other commands:

```sh
pnpm dev:stack       # the private-payments stack only (Arc fork)
pnpm test            # offline tests
pnpm e2e             # private payment + attacks + refund on a fresh Arc fork
pnpm e2e:credit      # pay with stocks + pay later against a running dev:all (NOREN_MERCHANT_TOKEN=<printed key>)
pnpm deploy:arc:dry  # measures the Arc testnet deploy on a fork from the real deployer; writes deployments/5042002-dryrun.json
pnpm deploy:arc      # the real Arc testnet deploy (needs NOREN_DEPLOYER_KEY and testnet USDC)
pnpm studio:import   # sends the Arc contracts to Arc Studio (needs arc-studio login)
```

Local runs write `deployments/5042002-fork.json` (e2e) and `deployments/31337-fork.json` (dev stack), never `5042002.json`.

## How a private payment works

- **Invoice-bound proofs.** The customer's Privacy Pools withdrawal proof binds the invoice, merchant, amount and refund address. Change any field and the pool rejects it (`ContextMismatch`).
- **The merchant relays.** The merchant's server submits the proof and pays about a cent of gas, so the customer needs no gas and no public wallet. Only the merchant can relay its own invoices.
- **Compliance.** The ASP postman approves a deposit only if Arc USDC's own `isBlacklisted(depositor)` is false.
- **Private refunds** go into a shielded refund inbox fixed when the customer paid. **Selective receipts** let the customer prove the purchase later, if they choose.
- **Any currency.** Links priced in EUR, GBP, JPY, CAD, AUD, MXN, BRL or KRW are quoted from Chainlink Data Feeds on Arc mainnet (read-only) and locked until expiry. Both round IDs are stored, and `NorenRateOracle` on Arc re-checks the quote at those rounds ("Rate verified on-chain").

## How pay later works

1. **Score.** The history underwriter reads the wallet's real Robinhood Chain history (account age, transaction count, Stock Token holdings at Chainlink prices, past Noren repayments) and scores it. A sealed model on **0G Private Computer** gives a second decision with a 0G request ID and TEE verification. Any wallet that locks Stock Tokens gets at least the collateral-only tier (150%); history only improves terms.
2. **Attest.** The underwriter signs an EIP-712 `CreditAttestation`; `NorenCredit.applyAttestation` verifies it on-chain.
3. **Lock.** `NorenCredit.openCreditLine` values the shares with Chainlink (with a weekend haircut when markets are closed) and emits `CreditLineOpened`.
4. **Bridge.** The Chainlink CRE workflow writes the limit to `NorenCreditLine` on Arc through the forwarder.
5. **Spend.** On any Noren checkout, "Pay later" calls `NorenCreditLine.payInvoice`; the merchant is paid USDC upfront and the server settles the invoice from the `Drawn` log.
6. **Repay.** USDC on Arc, in parts or at once; the app suggests `NorenCredit.INSTALLMENTS()` parts (3). CRE carries each `Drawn`/`Repaid` back to `NorenCredit`. Debt left after expiry plus grace, or collateral below 110% of the debt, makes the line liquidatable, and liquidation sells the collateral to 1inch Aqua makers through SwapVM.
7. **No stock?** Verify with World ID (IDKit, server-verified) for one small unsecured starter line per human. Noren stores only the nullifier.

## CROPS

- **Censorship resistant.** The customer's funds sit in a Privacy Pools contract, not with Noren: they can withdraw or pay any merchant without Noren's permission. Settlement is a contract call any merchant server can relay; the merchant runs its own.
- **Open source.** MIT (Noren) and Apache-2.0 (vendored Privacy Pools). One command builds and runs everything locally: `pnpm install && pnpm dev:all`.
- **Private.** What each party learns: the **merchant** learns that an invoice was paid in full, never the payer's address, balance or history. The **Noren server** never sees note secrets, keys or proof inputs; it relays a finished proof. The **ASP** sees only deposit addresses, which it checks against USDC's blacklist. **World ID** gives Noren a nullifier, not a person. The **0G** credit check gets numeric features without an address, inside a TEE. The web app makes **no third-party requests**: fonts and prover artifacts are served by the app itself. Pay with stocks and pay later are *not* private, and the UI says so.
- **Secure.** Keys, note secrets and Groth16 proofs stay in the customer's browser. Invoice-bound proofs make tampering, replay, squatting, expiry and stale roots fail on-chain (the 5 attack checks above). CRE reports are accepted only from the configured forwarder; credit attestations only with the underwriter's EIP-712 signature.

## Honest limits

- **Local forks only.** Arc testnet and Robinhood Chain run as local Anvil nodes; no real money or stock moves. The public Arc testnet deploy is **BLOCKED** on testnet USDC for `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80` (Circle faucet CAPTCHA, Nick). The Arc Studio app is **BLOCKED** on an Arc Studio login (Nick); steps in [docs/ARC.md](docs/ARC.md).
- **Robinhood testnet has no Chainlink feeds**, so the Robinhood side is a snapshot of mainnet state. CRE only knows Robinhood *testnet*, so that node is served as chain 46630 with testnet's simulation forwarder. CRE workflows run in the CRE CLI simulator, not on a DON.
- **Keys not yet created:** the 0G credit check needs `ZG_PC_API_KEY` and World ID needs `WORLD_APP_ID`, `WORLD_RP_ID` and `WORLD_RP_SIGNING_KEY`. Until then both say "Setup required" and nothing is faked; the history underwriter's deterministic score (labelled as such) decides terms.
- **Settle to Arc** runs the CRE approval for real, but no relayer fills a local fork, so the USDC fill on Arc stays pending. The Robinhood snapshot carries the Relay Depository's code but not the Across SpokePool, so an Across approval is shown and not deposited; `sh packages/bridge-settlement/scripts/fork-settle.sh` runs both deposits on a live fork.
- **1inch Aqua:** Aqua is the official registry `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` on Robinhood Chain. The SwapVM router is the official AquaSwapVMRouter (`0x111111338c5091E8440b67B168bAe16a668AC0De`) recompiled with one added opcode (`NorenOraclePeg`), so it is redeployed on the fork rather than called at the official address. Maker liquidity on the fork is seeded from a real USDG holder.
- Stock Tokens can't leave Robinhood Chain and their issuer can pause or block them; only stablecoin value crosses, as a credit limit carried by CRE. See [docs/BRIDGE-ROUTES.md](docs/BRIDGE-ROUTES.md).
- The privacy pool on a fresh fork has few depositors, so timing can link a payment to a deposit; the checkout shows the anonymity set.
- Browser proving was measured on a laptop, not yet on a phone. The contracts are unaudited.

## Repository

| Package | What |
|---|---|
| `packages/contracts` | `NorenCheckout`, `NorenQuoter`, `NorenRateOracle`, fork USDC shim; vendored Privacy Pools |
| `packages/core` | the SDK: chain config, invoice encoding, `@noren/core/merchant`, `@noren/core/customer`, Chainlink pricing |
| `packages/server` | merchant API, relay, webhooks, credit and stock settlement watchers, Robinhood fork faucet |
| `packages/postman` | ASP: USDC blacklist check, Merkle roots |
| `packages/web` | landing, Noren Merchant, Noren app, hosted checkout |
| `packages/robinhood` | `NorenCredit` (credit lines, Pay in 3), `NorenGateway`, `NorenLiquidity` (Aqua maker registry and routing), `NorenVault`, `NorenAssetOracle`, history underwriter, SDK |
| `packages/aqua` | `NorenOraclePeg` (a Chainlink-pegged SwapVM instruction) and `NorenAquaSwapVMRouter` (the official AquaSwapVMRouter plus that one opcode), under the SwapVM-1.1 license |
| `packages/arc-credit` | `NorenCreditLine` |
| `packages/bridge-settlement` | `NorenSettlementDesk`, the settlement CRE workflow and keeper (USDG → USDC on Arc via Relay or Across) |
| `packages/cre-bridge`, `packages/cre-pricing` | Chainlink CRE workflows (TypeScript) |
| `packages/ai-underwriter` | credit check on 0G Private Computer |
| `packages/world-id` | IDKit request signing, server verification, nullifier registry, `VerifyHuman` |
| `scripts` | `dev:all`, `dev:stack`, e2e runners, CRE runner, Arc deploy |

MIT © 2026 Nivesh Gajengi. Vendored Privacy Pools contracts keep their Apache-2.0 headers (see NOTICE). `packages/aqua/swapvm-ext` extends 1inch SwapVM and is distributed under the SwapVM-1.1 license that its files name.

### Assets
The app icon and the isometric illustrations were generated with ChatGPT; the curtain film on the landing page was generated with Google Gemini (Veo) and keeps Gemini's visible mark. Screenshots are real captures of this app on the local forks. Fonts: Geist, Geist Mono, Instrument Serif (OFL), bundled from Fontsource.
