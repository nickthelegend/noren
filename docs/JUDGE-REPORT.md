# Judge report: Noren at ETHGlobal Mumbai

An independent pre-submission review of branch `v3` at `26892ab`, Nov 6 2026, 22:00–23:30 IST. Submissions close Sat Nov 7, 09:00 IST.

The reviewer acted as a strict ETHGlobal judge and an AI repo screener. It read the README, `docs/`, the submission form, TESTING.md and the landing copy (`packages/web/src/Landing.tsx`). It checked each claim against code (file:line) or against public chains: `cast receipt` / `cast codesize` on the Arc testnet, Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia and Robinhood testnet RPCs, and the CCIP API. It ran `pnpm test`, `forge test` in `packages/arc-credit`, and `NorenRateOracle`. It did not start the dev stack, which the film agent holds.

## 1. Scorecard (0–10)

| Criterion | Before | After the doc fixes | What still blocks a 9 | Fixable by 09:00? Who |
|---|---|---|---|---|
| Technicality | 8.5 | 8.5 | The credit, Earn/Borrow and Aqua-lending path runs only on a Robinhood mainnet fork. CRE runs only in the simulator (`--broadcast` through `MockKeystoneForwarder`), not on a DON. Contracts are unaudited. | Partly. A DON deploy needs Chainlink access (Nick, unlikely). Robinhood testnet has no feeds, so the fork stays. |
| Originality | 7.5 | 7.5 | Private checkout and Aqua apps are both crowded lanes. What's new is the combination: invoice-bound Privacy Pools proofs, lending pools that are Aqua makers, and fees that repay the loan. The film has to lead with that. | Yes, in the film (Nick / film agent) |
| Practicality | 6.5 | 6.5 | The hosted checkout and Home's private Pay run on an Arc fork. The testnet pool's anonymity set is tiny. The demo merchant, ASP and credit authority are all one deployer key. The product spans 4+ chains. | Partly. Record the private payment against the live Arc testnet deployment (film agent). |
| Usability / UX | 7.5 | 7.5 | Not re-checked visually here, since the stack is locked; the score comes from screenshots and TESTING.md's 375 px checks. The landing's "live" chip means "local fork" (see §4). | Landing copy (landing agent) |
| WOW factor | 7 | 7 | No video yet. The two wow moments, "payer address in the tx: none" and "your collateral's trading fees paid your loan", aren't on film. | Yes (Nick / film agent) |
| Positioning / clarity | 5.5 | 7.5 | GitHub's default branch `main` is 321 commits behind `v3`, so judges and the AI screener see an old product. The repo description is stale. The scope (10 sponsors, 5 chains) reads like a kitchen sink unless the first screen holds the line. | Yes: **Nick** fast-forwards `main` and updates the description. Docs are done. |
| Honesty | 7 | 9 (docs) / 8.5 (with landing) | The landing still has the stale test count and the "live" chip on fork features (§4). There's no real World ID verification yet. | Yes (landing agent; Nick for World ID) |

The doc fixes don't change what was built. They change whether a screener can see it, and whether a human who checks finds a contradiction. Before them, a judge clicking through met three different test totals (599, 590, 136 vs 142), a doc saying "Not used: CCTP" next to a CCTP-centric README, and a CROPS claim of "no third-party requests" that the Bridge tab breaks.

## 2. Claims audit

### Method and counts

| Status | Count | Notes |
|---|---|---|
| **VERIFIED, on-chain** | **152** | 115/115 linked tx hashes returned status 1, 27/27 linked contract addresses have code, 10/10 CCIP message IDs report `SUCCESS` on `api.ccip.chain.link/v2/messages` |
| **VERIFIED, deeper on-chain checks** | 8 | see below |
| **VERIFIED, code or test run** | listed below | file:line or a judge test run |
| **WRONG** | 8 | all fixed in docs |
| **OVERCLAIM** | 7 | 5 fixed in docs; 3 remain on the landing page (one of them is also fixed in docs) |
| **UNVERIFIABLE tonight** | 5 | fork-only measurements, 0G request IDs, World RP behaviour, Studio's own report, unrun fork suites |

### Deeper on-chain checks (VERIFIED)

1. **Private payment `0x1ce6858a…`** was sent by the merchant/relayer `0x4b2a…` to `NorenCheckout`. Its logs name only the pool, `NorenCheckout`, the merchant and the payout `0x32Ee…`. The customer `0x5190…` is absent.
2. **Aqua on Arc testnet `0x550C…895B`** has a 5,619-byte runtime. It differs from 1inch's Aqua at `0x1111113C…a90a` on Arc mainnet (and on Robinhood mainnet: same codehash `0x720b…`) only in bytes 5576–5607, the CBOR metadata hash. So "unmodified" holds.
3. **Canonical Aqua `0x1111113C…` has no code on Arc testnet.** This confirms why Aqua was redeployed there.
4. **The Uniswap v4 PoolManager `0x8366…0951` has code on Arc testnet** (24,009 bytes). Swap `0x599879f5…` goes to Universal Router `0x4fcA…9Fb1` and touches the PoolManager.
5. **Aqua-maker swap `0x12df0a9c…`** goes to the Noren SwapVM router `0x8717…` and touches Aqua `0x550C…`.
6. **CRE writes `0xa7f67bcc…` and `0x5f752147…`** go to forwarder `0x6e9e…` and on to `NorenRateOracle` / `NorenArcHook`. They are signed by Noren's deployer, which is what `simulate --broadcast` does; the README now says so.
7. **The CCIP runs are 7 runs and 10 messages.** Run 1 went to an EOA, with no Noren state change.
8. **The Arc Studio URL** redirects logged-out visitors to Circle's Okta sign-in. It is **not shareable**.

### Code and test checks (VERIFIED)

- **Tests and counts**
  - `pnpm test`: **142 passed, 21 files** (judge run).
  - `NorenCreditLine` 47/47 and `NorenRateOracle` 22/22 (judge runs).
  - Foundry `test*` function counts match every claimed suite: Robinhood 158, SwapVM 28 (27 + 1 skip), arc-credit 47 + 15, CCIP 9 + 23, CCTP 24 (17 + 7), xchain 31 + 8, checkout 9.
  - CRE test counts match: 31 / 8 / 8 / 15 / 14.
  - World ID has 43 tests and the 0G policy has 25, both inside `pnpm test`.
  - The 5 attack checks are in `scripts/e2e-fork.ts` L113–147.
- **Opcodes:** `NorenOraclePeg` = opcode 34 and `NorenDutchDecay` = 35 (`NorenAquaSwapVMRouter.sol` L27–49). `NorenOraclePeg` reads Chainlink `latestRoundData` and `uiMultiplier`.
- **Contract entry points:** `NorenVault.shipAquaStrategy` L85, `NorenDepositVault.shipStrategy` L120, `NorenLiquidity.bestQuoteForUsdg` L220 and `liquidate` L330, `NorenBorrow.harvestToRepay` L317.
- **Checkout binding:** `NorenCheckout.pay` (L64) decodes and binds invoiceId, merchant, amount, expiry, refund precommitment and receipt commitment. It enforces `NotMerchant`, `Expired` and `AlreadyPaid`.
- **Kohaku:** `@kohaku-eth/privacy-pools` 0.1.0-alpha.27 is imported in `packages/core/src/customer.ts` L1–2, with the plugin at L72.
- **CRE:** five workflows on `@chainlink/cre-sdk` 1.23.0, each with `workflow.yaml`. Their triggers and `writeReport` lines match the claims: cron (pricing), log (CCTP relay, credit bridge, xchain, settlement), HTTP (credit bridge), and HTTP client with consensus (Iris, Relay, Across).
- **CCTP:** 10 source testnets are configured in `packages/cctp/sdk/chains.ts`. `NorenArcHook.relay` is at L120 and `onReport` at L113.
- **CCIP:** gateway `send` L153, `_ccipReceive` L180 and `retryFailed` L253; hub `_ccipReceive` L98.
- **World ID:** IDKit 4.6.0; verify posts to `/api/v4/verify/{rp_id}` (`verify.ts` L18).
- **Reputation:** LTV 66% → 80% (`NorenReputation.sol` L60–61).
- **Licensing:** MIT `LICENSE` (Copyright (c) 2026 Nivesh Gajengi), the Degensoft SwapVM `NOTICE` and the 0xbow Apache NOTICE are all present.
- **History:** 331 commits on `v3`, the first at 2026-11-06 03:57 +0530, after hacking opened at Nov 5 21:00 IST.

### Every WRONG claim and what changed

| # | Where | Claim | Truth | Fix |
|---|---|---|---|---|
| 1 | README "Measured" | `pnpm test` "136 passed, 20 files" | 142 passed, 21 files (Privy added 6) | Updated (now in docs/PRODUCT.md and README Tests) |
| 2 | README / form / landing | "599 passed" / "590 passed" / "590 … 22 suites" | The sums counted the 7 `@noren/ccip` SDK tests twice (they also run in `pnpm test`) and predate Privy. Recount: **605 passed, 1 skipped, 21 suites** | TESTING.md "Current totals" table; README and form updated; landing reported (§4) |
| 3 | README "Package suites" | Robinhood "112", SwapVM "18" | 158 and 27 (+1 skip) | Updated in docs/PRODUCT.md |
| 4 | Form tests table | Robinhood "150" | 158 | Updated |
| 5 | docs/ARC.md | "Bridge Kit … needs CCTP. Noren has none" and "Not used: … CCTP" | CCTP V2 is a core rail (`NorenArcHook`, live from 4 chains) | Reworded |
| 6 | docs/CCIP.md | "each one ended in a state change in a Noren contract" | Run 1 was a probe to the deployer EOA | Reworded: runs 2–7 did; run 1 was a probe |
| 7 | README / form | "CCIP: 7 messages" | 7 runs, 10 messages | Reworded everywhere |
| 8 | docs/0G.md | "we pin 0GM-1.0" | The code defaults to 0GM-1.0, but the live runs used `glm-5.3` via `ZG_PC_MODEL` | Reworded |

### Every OVERCLAIM and what changed

| # | Where | Claim | Truth | Fix |
|---|---|---|---|---|
| 1 | README CROPS, form | "The web app makes no third-party requests" / "RPC goes only to the chain" | True for the private-payment path. The Bridge tab calls Circle Iris, IDKit calls World, and Privy sign-in calls Privy. | Reworded to list them |
| 2 | README | "Try it in 30 seconds" | Needs Node, pnpm, Foundry, bun, the CRE CLI and a one-time snapshot build | Now "Try it", with prerequisites and exact commands |
| 3 | README / form / landing | "Bring USDC to Arc from 10 CCTP testnets" | 10 configured; live runs from 4 (Base, Arbitrum, Ethereum Sepolia, Robinhood) | Qualified in README and form; landing reported |
| 4 | Form, Arc section | "fully qualified once Nick makes the Studio app shareable" | Studio was not the starting point, so it stays partly met even when shared | Reworded as "partly met" |
| 5 | Landing L289 and chips | the `live` chip is defined as "runs end to end on local Anvil forks" | A judge reads "live" as a public network | Reported (landing agent) |
| 6 | Landing L80, L93 | World ID "live" | Production RP, but no successful real verification is recorded | Reported (landing agent; Nick) |
| 7 | TESTING / README | `pnpm test` = "offline tests" | `pricing.test.ts` reads Arc mainnet | Reworded as "unit, no fork; one file reads Arc mainnet" |

### UNVERIFIABLE tonight (not changed; kept with their caveats)

- **Fork measurements:** proof 1.12 s, tap-to-paid 6.2 s, `pnpm e2e:credit` 8/8, self-repay 500.000001 → 497.055664, CRE 4.6–5.2 s. Fork transactions vanish when the fork stops. These are consistent with TESTING.md's logs, but the dev stack was locked.
- **0G request IDs** `a30b5e94…` and `e3fa908f…`: there is no public explorer.
- **World ID:** "production RP `rp_84fc…`, fake proofs get 403".
- **Arc Studio's own report** (24 tests, live-deploy verification): the app is behind sign-in. `arc-studio/studio.json` records it.
- **Fork suites the judge didn't run:** their counts match the code, but pass/fail wasn't re-run.

## 3. Prize odds (honest estimates)

| Prize | Odds | Why |
|---|---|---|
| **ETHGlobal Finalist** | **10–15%** if `main` is fast-forwarded and the film is tight; **< 5%** if `main` stays stale | The technical depth is finalist-grade. The risks are a diffuse story (10 sponsors, 5 chains) in a 4-minute demo, being solo, and the core credit path running on a fork. |
| Chainlink CRE ($1,500, one winner) | 35–45% | Five real workflows in the main paths, external APIs with consensus, public testnet writes. Few teams use CRE this deeply. |
| Chainlink CCIP 2.0 ($1,750 × 2) | 35–45% | CCIP is used inside contracts. Live state changes on Arc, a two-hop hub for a lane-less chain, `retryFailed` on an out-of-order arrival, and a manual execution. The "value over CCTP, instructions over CCIP" split is honest, but a judge may want value moving on CCIP itself. |
| 1inch Build an Aqua App | 30–40% to place | Crowded (about 14 Aqua apps per event; recent winners: OddsFlow, ArcBook, watermark). Noren's case: two custom opcodes, lending-pool makers, Dutch-auction liquidations, fee-funded repayment, and live Aqua on Arc. The risk is that the lending side is fork-only. |
| Arc DeFi (Built End to End in Arc Studio) | 10–15% (20% if shareable and shown in the film) | The title's "built end to end in Arc Studio" isn't true, and the URL isn't shareable. The rest (live on Arc, USDC settlement, CCTP) is strong. |
| World IDKit (alternate) | < 10% now; ~20% with one real verification on camera | No real verification has been done yet. |

## 4. Landing-page issues (for the landing agent; `packages/web/src/Landing.tsx`)

1. **L128:** `{ v: "590", l: "tests passing across 22 suites…" }` should be **605 … across 21 suites**.
2. **L289, legend, plus the chips on L66, L75, L80:** `live` is defined as "runs end to end on local Anvil forks". Rename the fork chip to **`fork`** (or "runs locally") and keep "testnet" for public-chain features. Pay privately is live on testnet; Earn and Borrow are fork-only.
3. **L80 and L93 (World ID + 0G, `s: "live"`):** no real World ID verification is recorded. Use "production RP · real check pending" until Nick records one.
4. **L83 and L90:** "Bring USDC to Arc from 10 chains / 10 testnets" should be "10 CCTP testnets supported; live from Base, Arbitrum, Ethereum Sepolia and Robinhood".
5. **L208, hero H1:** "Stablecoin Payments That Never See Who Paid You" holds only for Pay privately and Pay later privately. The subtitle and the L275 copy do qualify it. Minor, but a strict judge will notice that the hero leads on privacy while the positioning sentence leads with "DEX". Consider "Stablecoin payments where the shop never sees who paid", or lead with the positioning sentence.
6. **Optional:** the landing doesn't mention the Arc Studio app or the CCIP message count. The live strip at L113 already links CCIP messages, so that's fine.

## 5. Nick-only blockers, in priority order

1. **Fast-forward GitHub `main` to `v3`** (or set `v3` as the default branch). Today `main` is `93932c0`, 321 commits behind. The AI screener and judges will read an old README describing a different product. This one step is worth more than every doc fix here.
2. **Update the repo description and topics.** It still reads "Private checkout for merchants on Arc: Kohaku privacy pools…".
3. **Make the Arc Studio app shareable.** Logged out, it redirects to Okta sign-in. Steps are in `docs/ARC.md` § Arc Studio. Show it in the film.
4. **Record and paste the demo video.** Lead with "payer address in the tx: none" and "collateral's fees paid the loan down".
5. **Pick the prizes:** 1inch, Chainlink (both CRE and CCIP count as one pick), Arc.
6. *(Only if World replaces Arc)* one real World App Selfie Check on camera.
7. **Merge `judge-docs` into `v3`** (doc-only; no code touched).

## 6. Against the field

What other teams at Mumbai are likely to bring, judging by the sponsor list and recent winners:
- **Aqua apps:** AMM strategies, prediction-market liquidity, treasury market-making.
- **Arc payment apps:** USDC checkouts, agent nanopayments, x402.
- **Privacy:** Kohaku wallets and Privacy Pools front ends, Anon-RPC.
- **Credit:** World-ID-gated under-collateralised loans, on-chain credit scores.

Why Noren should rank above them, in claims checked tonight:
- **Privacy that is enforced by the contract, on a public chain.** The live Arc testnet payment's logs don't contain the payer's address. Five attack classes revert on-chain. A typical Privacy Pools front end stops at deposit and withdraw. Noren binds the proof to a merchant invoice, adds refunds and "pay later, privately", and ships it as a merchant SDK.
- **Aqua used for what Aqua is for.** One balance backs several strategies. Noren's lender pool is a maker, so idle collateral earns fees and those fees repay the loan (`harvestToRepay`). Liquidations sell into partial Dutch auctions through a custom opcode. Aqua itself runs, byte-identical, on Arc testnet with live swaps.
- **Chainlink as the backbone, not a price read.** Five CRE workflows sit in the main paths, CCIP makes state changes on Arc, and every one of the 10 messages shows SUCCESS.
- **Evidence density.** 152 on-chain references, all resolving, and 605 passing tests. Every number in the README traces to a command.

The honest counterweight: the credit and lending story, Noren's most original part, runs on a Robinhood mainnet fork, and the breadth can read as sprawl. The film decides which of those a judge remembers.

## 7. Commits on `judge-docs` (doc-only)

- `bdfe967` TESTING.md: current totals table (605 passed, 21 suites) with the recount and corrections
- `e6f557e` docs: correct stale claims (ARC.md CCTP, CCIP.md runs/messages, 0G.md model)
- `a111364` README: AI-screener order; detail moved to docs/PRODUCT.md
- `d8afa14` Submission form: tightened to ETHGlobal fields, per-prize requirement quotes
- this report, plus the README wording for `pnpm test`


## Addendum (coordinator, after this report)

- **World ID:** a real production verification *was* recorded on Nov 6 2026, 11:01 UTC (Proof of Human, Orb credential, action `noren-credit`, server-verified via `/api/v4/verify`); the auditor didn't see it because the record lives in a gitignored data file in another worktree. Its starter line was written on the local Arc fork. README, the form and docs/WORLD.md now say so, and the film shows it.
- **Landing fixes applied:** the fork chip now reads "Runs on local fork", the test count is 605 across 21 suites, World ID says it was verified for real with an Orb credential, and CCTP says 10 supported chains with live runs from 4.
- **Video:** film v3 is done (180 s); paste its public link in README and the form once uploaded.
