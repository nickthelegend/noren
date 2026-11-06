# Noren and the Arc (Circle) prize

## Track: Best DeFi / Onchain Finance App Built End to End in Arc Studio ($3,000)

Arc gives one prize per project, so Noren enters this one track. The submission must name this bounty.

Why this track:
- **It fits the track's own categories.** The prize page lists "payments and liquidity infrastructure" and "credit and collateral systems". Noren is private payment infrastructure that settles in USDC on Arc (NorenCheckout on a Privacy Pools USDC pool). It also adds a USDC credit line on Arc (NorenCreditLine) whose limit is backed by collateral.
- **It doesn't depend on a Circle product Noren doesn't use.**
  - *Mobile Web Consumer Agent* needs the Marketplace Discovery API and Nanopayments. Noren uses neither.
  - *Bridge Kit for Non-USDC Assets* needs CCTP/Bridge Kit. Noren has none.
  - *Continuity* is for Continuity Track participants with a project from before the event. Noren doesn't qualify.
- **Advanced Stablecoin Logic was the runner-up.** NorenCheckout is reusable, and its conditional, multi-step settlement (an invoice-bound proof, then payout, then a private refund) fits that track well. We picked DeFi for two reasons:
  - Fūtō, the Arc privacy idea in `FRIEND-ARC-PRIVACY-IDEAS.md`, targets Advanced Stablecoin Logic. Our research notes say to take DeFi if both enter.
  - The credit line puts Noren clearly in "onchain finance".

## Requirement-by-requirement

Status: ✅ done · 🟡 partly done · ⛔ blocked (named step for Nick) · ❌ gap

| Requirement (prize page) | Evidence in this repo | Status |
|---|---|---|
| Arc Studio is the starting point | The import pipeline is ready (`arc-studio/import.sh`): the Arc contracts go into a Studio app, which compiles and tests them, deploys them to Arc testnet and builds a live console page. **The CLI isn't logged in on this Mac, so the Studio app doesn't exist yet.** **Honest gap:** Noren's code was written before the Studio app, so Studio can only become the place where the Arc contracts are imported, built, tested and deployed. A judge who reads "starting point" strictly may mark this down. | ⛔ + ❌ |
| Shareable Arc Studio project URL judges can open | `import.sh` writes the URL to `arc-studio/studio.json`. Nick then checks that the workspace is shared or public in the Studio web UI. | ⛔ |
| Studio shown in the demo | Demo beat 1 below. | ⛔ (needs the URL) |
| Working MVP: frontend | `packages/web`: landing page, merchant dashboard and hosted checkout, with proofs made in the browser. Measured on the local Arc fork: browser proof in 1.06–4.77 s (README). The Studio console page (prompt task D) adds a second frontend that reads the testnet contracts. | 🟡 (runs on a local fork until the testnet deploy) |
| Working MVP: backend | `packages/server` (invoices, relay, signed webhooks, SSE) and `packages/postman` (ASP: USDC blacklist check, roots). `pnpm e2e` passes on an Arc testnet fork: 9/9 Foundry checkout tests, 5 attack reverts, payment and refund (re-run Nov 6 on branch `arc-studio`). | ✅ (fork) |
| Architecture diagram | [ARCHITECTURE.md](ARCHITECTURE.md), [img/architecture.png](img/architecture.png) | ✅ |
| Video demo covering the core functions, Arc Studio and Circle's developer tools | Beat list below. Circle tools used: **USDC on Arc** (settlement and gas) and **USDC's `isBlacklisted`** (the ASP's compliance check). Not used: Circle Wallets, Gateway, CCTP, Nanopayments. | ❌ (not recorded) |
| Detailed documentation | README, [API.md](API.md), [CHAINLINK.md](CHAINLINK.md), [ARCHITECTURE.md](ARCHITECTURE.md), this file, TESTING.md | ✅ |
| GitHub or Replit repo link | `nickthelegend/noren` is **private**. Nick must make it public, or grant judges access, before submitting. | ❌ (Nick) |
| DeFi / onchain finance app on Arc | Private checkout on a Privacy Pools USDC pool, plus the NorenCreditLine credit line (branch `cre-bridge`). | 🟡 (credit line not merged yet) |
| Settles in USDC or EURC | NorenCheckout pays merchants in USDC `0x3600…0000`. Refunds are USDC deposits into the customer's shielded inbox. NorenCreditLine pays merchants USDC. | ✅ |
| Public deployment on Arc testnet (needed for "working", and for judges to check) | `scripts/deploy-arc.ts` was verified by a fork dry run (below). The live deploy needs 0.45 testnet USDC on the deployer. | ⛔ (faucet) |

**Risk to raise with Nick: one chain per project.** Tsuke runs on Robinhood Chain (a local fork) and reaches Arc through a CRE workflow. For the Arc judges, the demo should stay on Arc, with Tsuke shown as the source of the credit limit. Nick's own rule after ETHOnline is "never mix two chains in a hackathon entry", so he should decide whether Tsuke appears in the Arc submission at all.

## Arc Studio

**Status: BLOCKED.** `arc-studio whoami` reports "Not authenticated", and `arc-studio doctor` shows `creds none` (checked Nov 6, CLI 1.2.2, backend `https://studio.arc.io`). Logging in needs Nick's browser.

**Nick's steps** (about 5 minutes, then a 5–20 minute Studio turn):
1. In a normal Terminal (not inside an agent sandbox), run `arc-studio login --paste`. Approve in the browser and paste the token at the prompt. It is stored in `~/.arc-studio/credentials.json` (mode 0600), which agents can use without seeing the token.
2. Run `arc-studio whoami`. It must exit 0.
3. From the Noren checkout on branch `arc-studio` (or main once it's merged), run `sh arc-studio/import.sh`.
4. Open the URL it prints. In the Studio web UI, make the workspace shareable. Then paste the URL into the submission form and into the table below.
5. If Studio deployed the contracts, run `pnpm exec tsx arc-studio/adopt.ts`. It checks the Studio-reported addresses on-chain (code plus Entrypoint → pool → USDC and checkout wiring) and writes `deployments/5042002.json`.

**Studio URL:** _not created yet (BLOCKED, steps above)_

What `import.sh` does:
- **Sends contracts, not a repo clone.** Arc Studio can't clone private repos, so `forge flatten` produces one file per deployable contract. The list:
  - PoseidonT3, PoseidonT4
  - WithdrawalVerifier, CommitmentVerifier
  - Entrypoint, ERC1967Proxy
  - PrivacyPoolComplex
  - NorenCheckout, NorenQuoter
  - NorenRateOracle and NorenCreditLine, once those branches are merged

  These are sent with `--file` to `contracts/noren/` in the Studio sandbox. ARCHITECTURE.md, this file, the real-proof fork test and the deploy script go along as read-only context.
- **Fixes one ordering problem in the flattened files.** `forge flatten` puts Privacy Pools' `interface IState` after `IPrivacyPool is IState`, and solc rejects that (error 2449). `arc-studio/reorder.mjs` moves that one block. Nothing else changes.
- **Checks the bundle before uploading anything.** It compiles the bundle on its own in a sandbox-like Foundry project and compares bytecode with the repo build (`arc-studio/compare.mjs`). Measured Nov 6: **all 9 contracts compile, and their bytecode is identical to the repo build.** Entrypoint is 13,490 bytes and PrivacyPoolComplex 7,720 bytes, under the 24,576-byte limit. Run `sh arc-studio/import.sh --stage` to repeat the check without Studio.
- **Gives Studio one prompt** (`arc-studio/prompt.md`, under the 10,000-character limit):
  - compile, without editing the imported files;
  - write Foundry tests for the non-proof guards and the wiring (no faked proofs; the real-proof path is tested in this repo);
  - deploy to Arc testnet in the same order as `deploy-arc.ts`, with Noren's operator `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80` as ASP postman and co-owner;
  - build a "Noren on Arc" console page: pool balance, deposits, ASP root, a live Paid/Refunded feed and merchant registration.
- **Records what Studio returns.** `arc-studio/record.mjs` saves the URL and the Studio-reported deployments to `arc-studio/studio.json`. Studio's prose is not copied (it is untrusted output).

## Public Arc testnet deployment

**Status: BLOCKED on testnet USDC.** Getting it means solving the Circle faucet's CAPTCHA, which only Nick can do.

| | |
|---|---|
| Address to fund | `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80` (Noren testnet deployer and ASP postman; its key is in the main checkout's gitignored `.env.arc-deployer`) |
| Amount | **at least 0.45 USDC** on Arc Testnet (one faucet drip is enough) |
| Faucet | https://faucet.circle.com → Arc Testnet → USDC |
| Then | `pnpm exec tsx scripts/deploy-arc.ts` from the repo root |

Dry run measured on Nov 6 (`pnpm exec tsx scripts/deploy-arc.ts --dry-run`):
- **Setup:** an Anvil fork of `https://rpc.testnet.arc.io` on 127.0.0.1:8705, deploying from the real deployer address (impersonated on the fork only).
- **Result:** 9 transactions and 14,978,568 gas, which cost 0.222 USDC at fork prices.
- **Funding:** at the live gas price of 20 gwei, the deployer needs **0.4494 USDC** (1.5× margin).
- **Checks:** the wiring check passed (Entrypoint → pool → USDC; checkout → Entrypoint + pool).
- **Record:** `deployments/5042002-dryrun.json` (fork addresses, labelled as such).

The deployer's nonce is 0. If the first nine transactions it sends are this deploy, the live addresses will match the fork's. These are **predictions, not deployments:**

| Contract | Predicted address |
|---|---|
| Entrypoint (proxy) | `0xa22f3200ecb4319b48dca49677c2f73cd7260ad5` |
| PrivacyPoolComplex (USDC) | `0x393d8d46e1dff8a719820e36d70ba509896ea57d` |
| NorenCheckout | `0xe18a80506fdb7f5498aad7387a21134118a77547` |
| WithdrawalVerifier | `0x015306ac6f866bf9b2dd157a79d65159697fb4cf` |
| CommitmentVerifier | `0xe57a438a8ded2ad7d1a12ddf497a0da0bd2d2ba3` |

What the deploy script guarantees:
- **Before sending anything:** it refuses a chain other than 5042002. It runs the fork dry run first and won't send a transaction unless the live balance covers the measured cost. It also refuses to overwrite a `deployments/5042002.json` whose checkout is already live, unless `--redeploy` is passed.
- **While deploying:** it checks for code at every new address and reads the wiring back.
- **Output:** it prints contract names and addresses only. The key is loaded from env, `.env` or `.env.arc-deployer` and is never printed.
- **Local runs:** `pnpm e2e` and `pnpm dev:stack` call the same `deployArc()`. A local RPC now writes `deployments/5042002-fork.json`. Before this change, every e2e run overwrote `deployments/5042002.json` with fork addresses that don't exist on Arc testnet, and the server and postman read that file when started against the real testnet.

**Studio or script: deploy once.** If Studio's wallet can pay for its own deploy, Studio's deployment is the better story for this track: use `adopt.ts` and skip the faucet. Otherwise use the script.

## Demo beats for the Arc judges (4 min)

1. **Arc Studio (30 s).** The Noren app in Studio: the imported contracts, the test run, the deployments panel and the console preview. Show the shareable URL on screen.
2. **The problem (20 s).** A plain USDC payment on the Arc explorer, with payer and amount visible to everyone.
3. **Private checkout (90 s).**
   - The merchant creates a EUR-priced link (Chainlink quote).
   - The customer shields USDC and pays; the proof is made in the browser.
   - The dashboard shows "customer: unknown".
   - The explorer shows NorenCheckout paying the merchant, with no link to the customer.
4. **Refund (30 s).** It lands in the customer's private inbox.
5. **Credit on Arc (40 s, if merged and Nick keeps it).** The CRE workflow writes a credit limit to NorenCreditLine, and the customer pays an invoice from the line.
6. **Architecture slide (20 s).** `docs/img/architecture.png`.
