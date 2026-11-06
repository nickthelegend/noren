# Privacy in Noren

Noren is a DEX and stablecoin payment infrastructure on Arc: liquidity, credit lines and cross-chain settlement. Payments are private by default: a merchant never learns which customer paid.

The privacy comes from the Ethereum Foundation's **Kohaku** privacy pools (0xbow Privacy Pools) on Arc testnet. A customer holds USDC as a private balance in the pool. Each payment is a zero-knowledge withdrawal, so the money leaves the pool, and nothing on-chain links it to the deposit it came from.

This page covers four things:
- what is private and what is not;
- the compliance model (ASP);
- the threat model;
- the live testnet runs.

Swaps and bridges are **not** private. They are public on-chain like anywhere else. Noren makes the *payment* private, and lets bridged money *arrive* private.

## What is private

| Flow | How | Who can't see the payer |
|---|---|---|
| **Pay a Noren invoice** | `NorenCheckout.pay`: a Groth16 withdrawal proof bound to the invoice, relayed by the merchant's server. | The merchant, and anyone reading the chain. The tx is sent by the merchant. The USDC comes from the pool. |
| **Refunds** | `NorenCheckout.refund` deposits into the customer's shielded refund inbox, under a precommitment the customer bound to the invoice. | The merchant refunds without ever learning a wallet. |
| **Send privately (P2P)** | `Entrypoint.relay`: a withdrawal whose processooor is the Entrypoint, relayed by Noren's server (`POST /private/send`). | The recipient, merchant or person. The tx is sent by Noren's relayer, and the USDC comes from the Entrypoint. |
| **Arrive private** | Action `SHIELD` on the CCTP rail: the bridged USDC is deposited straight into the pool under the user's precommitment (`NorenShieldSink`). | No public USDC balance on Arc ever holds the money, so later payments can't be traced to the bridged wallet's balance. |
| **Pay later, privately** | `NorenCreditLine.drawToPool`: a credit draw is deposited straight into the pool under the borrower's precommitment, then the invoice is paid with `NorenCheckout.pay` (see [Private credit](#private-credit-pay-later-privately)). | The merchant, and anyone reading the payment tx. The lender still knows its borrower. |

In both live payments below, the traveller's address appears in neither the tx sender, the tx input nor any log. The run checks this with `appearsIn` in `scripts/live/private-live.ts`.

## What is not private

- **Swaps.** Aqua / Uniswap v4 swaps and pay with stocks are public transactions from the customer's wallet.
- **Bridges.** A CCTP burn is public on the source chain. It shows the sender, the amount and the hookData, and the hookData holds the SHIELD precommitment and the beneficiary. CCIP messages are public too.
- **Deposits.** Every pool deposit is public: depositor, amount and label. For an "arrive private" deposit, the sink's `Shielded` event names the source sender and the beneficiary. Privacy starts *after* the deposit. It is the link from a deposit to a later payment that is hidden.
- **Amounts.** A withdrawal's value is a public signal, so the merchant and the chain see how much was paid. Unusual amounts and timing can narrow down which deposit paid.
- **The anonymity set on testnet is small.** The live pool holds a handful of deposits made by Noren's own test runs. An observer could guess the payer from timing alone. Privacy grows with the pool's crowd. The checkout shows the current anonymity set and warns when it is thin.
- **Pay with USDC, pay with stocks, Pay in 3 (pay later from the line), and paying from another chain** are public payments. The checkout says so on each of them (see below). "Pay later, privately" hides the payer from the merchant, but the draw into the pool is public; see [Private credit](#private-credit-pay-later-privately).
- **What the relayers see.**
  - The merchant server sees the invoice and the payment.
  - Noren's P2P relayer sees the recipient and the amount.
  - Neither sees the sender. Both see the requester's IP address unless the customer uses a network-level privacy tool.

## Private by default (UI)

- **Checkout** (`packages/web/src/Checkout.tsx`).
  - "Pay privately" is the default and first method. Its label is "Default · {shop} never learns who paid".
  - **Pay later, privately** is the second method, labelled "Private · your credit line tops up your private balance".
  - The other methods are each labelled **Public**: Pay with USDC, Pay with stocks and Pay in 3. Each one shows a note: "This is a public payment… {shop} and anyone reading the chain can link it to you."
  - Each note has a **Make it private** button. On Pay in 3 it switches to Pay later, privately; on the others it switches to the private method, which has the get-USDC → shield flow.
- **Noren app → Pay** (`packages/web/src/app/PayTab.tsx`). A **Send privately** card takes a recipient and an amount. It makes the proof in the browser, posts it to the Noren server's relayer, and shows the tx link and what the recipient got after the relayer fee.
- **Noren Merchant.**
  - Payment rows show **Customer: Private** for pool payments. Public methods show "Arc wallet", "Robinhood wallet" or "Credit line …".
  - The CSV exports used to mark every row "private". They now name public-wallet payers: "public Arc wallet", "public Robinhood wallet" or "credit line …".

## Arrive private: the SHIELD action

```
Source chain (Arbitrum Sepolia)              Arc testnet
┌──────────────────────────────┐            ┌─────────────────────────────────────────────────────────┐
│ wallet: Kohaku nextPrecommitment()         │ CRE relay workflow (log trigger, Iris attestation)       │
│ depositForBurnWithHook(                    │   → MockKeystoneForwarder → NorenArcHook.onReport        │
│   destinationCaller = mintRecipient        │   → Circle MessageTransmitterV2 mints USDC to the hook   │
│     = SHIELD-aware NorenArcHook,           │   → hook.validateAction: SHIELD params = one field elem. │
│   hookData = SHIELD(precommitment))        │   → NorenShieldSink.execute                              │
└──────────────────────────────┘            │       · screen source sender + beneficiary (USDC list)   │
                                            │       · Entrypoint.deposit(USDC, minted, precommitment)  │
                                            │   → private balance; ASP approves the label             │
                                            └─────────────────────────────────────────────────────────┘
```

- **Action ABI** (shared by both rails): `abi.encode(uint8 kind, address beneficiary, bytes32 ref, bytes params)`. `SHIELD = 7`, and `params = abi.encode(uint256 precommitment)`.
  - Solidity: `packages/ccip/src/libraries/NorenArcAction.sol` and `NorenArcHook.SHIELD`.
  - TypeScript: `shield()` in `@noren/ccip` and `{ kind: "shield", precommitment }` in `@noren/cctp`.
- **Where the precommitment comes from.** The precommitment is computed client-side by `customer.nextPrecommitment()` (`@noren/core/customer`): it is the next deposit's `Poseidon(nullifier, secret)` from the Kohaku account. Kohaku's sync finds the deposit by precommitment, whoever the depositor is. (The refund inbox already relies on this.)
- **Why a sink.** `NorenArcActionRouter` is not upgradeable. `NorenShieldSink` sits in front of it as an additive upgrade:
  - It handles `SHIELD` itself.
  - It forwards every other kind unchanged to the router (the router allowlists the sink as a CCTP rail).
  - It never reverts for a well-formed call from its rail. A failed shield becomes a claimable balance for the beneficiary. Failures include a reused precommitment, a deposit below the pool's 1 USDC minimum, and a precommitment outside the field.
- **What stays as it was.** The live NorenArcHook v2 `0x8845ae4B…` and its CRE config are untouched. The SHIELD-aware hook `0x30c84a5a…` is a separate deployment. The CRE relay reaches it through the `privacy-settings` target (`packages/cctp/cre`, config `config.privacy.json`, gas limit 1.2M; the live write used 655,029).
- **The CCIP rail.** It uses the same action and sink code. On these testnets no CCIP lane carries USDC into Arc (see [CCIP.md](CCIP.md#tokens-what-ccip-can-move-into-arc-today)), so a CCIP SHIELD has nothing to deposit. Turning it on would take three owner txs: deploy a sink with `railId = keccak256("CCIP")`, `gateway.setApp(sink)` and `router.setRail(sink, CCIP)`. That would rewire the live CCIP gateway, so it was not done.

## Private credit: pay later, privately

Pay in 3 pays the merchant straight from the borrower's credit line (`payInvoice`), so the merchant and the chain see which line, and so which borrower, paid. **Pay later, privately** routes the same credit through the Kohaku pool instead:

```
Noren app / checkout (browser)                       Arc
  Kohaku account: nextPrecommitment() ──► NorenCreditLine.drawToPool(lineId, amount, precommitment)
                                            · same checks as payInvoice: borrower only, not paused, open, not expired,
                                              within the limit, pool can cover it
                                            · same debt: drawn += amount, totalOutstanding, updatedAt, Drawn log
                                              (merchant = Entrypoint, invoiceId = 0) for the CRE bridge, plus DrawnToPool
                                            · borrower screened against USDC's blocklist (the pool sees the line as depositor)
                                            · Entrypoint.deposit(USDC, amount, precommitment)  (same entry as NorenShieldSink)
                                         ASP approves the label (updateRoot)
  proof made on the device ─────────────► NorenCheckout.pay (relayed by the merchant): pool → merchant payout
```

- **Contract.** `drawToPool` is an additive function on `NorenCreditLine` (`packages/arc-credit`). `payInvoice` and `drawToPool` share one `_checkDraw` and one `_book`, so the limit, expiry and pause rules and the debt are the same by construction. Existing events and the ABI are unchanged; `DrawnToPool`, `PoolDrawRagequit`, `PrivacyPoolSet`, `setPrivacyPool`, `ragequitPoolDraw` and `lineOfCommitment` are new. The owner turns it on with `setPrivacyPool(entrypoint, pool)`, which checks that the pool is the Entrypoint's USDC pool.
- **Why on the line, not an adapter.** An adapter would still need an operator role on the line, so the line would change either way. Adding the function keeps the draw atomic: the debt is booked and the deposit made in one transaction, or neither.
- **Minimum deposit.** The pool takes deposits of at least **1 USDC** (`assetConfig(USDC).minimumDepositAmount` on the live Entrypoint). A smaller invoice draws 1 USDC and the rest stays in the borrower's private balance; the checkout says so. A draw below the minimum reverts and books no debt (fork test).
- **Exit.** The pool only lets the original depositor ragequit, and the depositor is the credit line. `ragequitPoolDraw(proof)` lets the borrower take a deposit the ASP never approves back out; the proceeds repay the line first and any rest goes to the borrower. Its guards are fork-tested; a full ragequit with a real proof was not run.
- **Repay is unchanged.** `repay(lineId, amount)` from any wallet, public. The Noren app labels it **Public**.

**What is private**

- **The merchant doesn't learn the payer.** The payment is a pool withdrawal sent by the merchant's own server. On the live run below, the borrower's address appears in neither the sender, the input nor the logs of the payment tx, and neither does the credit line's. Noren Merchant shows **Customer: Private** for it, like any private payment.
- **Underwriting is sealed.** The credit check runs on 0G Private Computer inside a TEE, and only numeric features go in, never an address ([0G.md](0G.md); first live sealed decision `a30b5e94…`). The starter-line path uses **World ID**, which proves a unique human with a nullifier and no identity ([WORLD.md](WORLD.md); its live run is blocked on a Developer Portal app).

**What is NOT private**

- **The lender knows the borrower.** A line is opened for a wallet: collateral lines come from a `CreditLineOpened` on Robinhood Chain naming the borrower, starter lines from a report naming the borrower. That is the point of a credit line.
- **Draws to the pool are public.** `Drawn` and `DrawnToPool` name the line (and so the borrower) and the amount, and the pool's `Deposited` log shows the credit line as depositor. Anyone can see that a borrower moved credit into the pool. What is hidden is which later payment it funded.
- **Repayments and collateral are public.** `Repaid` names the line; the collateral sits in `NorenCredit` on Robinhood Chain.
- **A small pool links by timing and amount.** The testnet pool holds a handful of deposits, almost all from Noren's own runs, and deposits from the credit line stand out. On the live run the 0.40 USDC payment came about 25 seconds after a 1.00 USDC draw, so an observer could link them. Privacy needs a crowd and some waiting; the checkout shows the anonymity set and warns when it is thin.
- **Gas.** The live borrower was sent 0.05 USDC of gas by the operator, publicly. A borrower who never holds public USDC needs a relayer for the draw too; that isn't built.

### Live on Arc testnet (Nov 6 2026)

Record: [`scripts/live/private-credit-runs.json`](../scripts/live/private-credit-runs.json). All transactions are real. A fresh borrower `0x2Ef3ab4fb55A71dB7961598286B56fA26541e223`; the operator `0x4B2ACf80…3F80` deploys, funds, runs the ASP and the merchant server. The live `NorenCreditLine` `0x7140aad0…` (no `drawToPool`), the pool, Entrypoint, NorenCheckout, NorenShieldSink, hooks, routers and CCIP gateways were not changed.

| # | Step | Tx | Gas |
|---|---|---|---|
| 1 | Deploy `NorenCreditLine` with `drawToPool` → [`0x4e26d0bfc5ac22b3fe8579afe50cb9584b2a1f86`](https://explorer.testnet.arc.io/address/0x4e26d0bfc5ac22b3fe8579afe50cb9584b2a1f86) | [0x48eb492d…2131](https://explorer.testnet.arc.io/tx/0x48eb492db8202dcf94c1f13e5fa22ce60278180ee85614c36a389cb9ea302131) | 2,914,143 |
| 2 | `setPrivacyPool(Entrypoint, USDC pool)` | [0x0a174978…564a](https://explorer.testnet.arc.io/tx/0x0a1749783e9bfcbc4b24d387e064f9ea455446de5f7fe84187a6ed858b77564a) | 87,315 |
| 3 | **Chainlink CRE** (`cre workflow simulate --broadcast`, credit-bridge handler 3) → MockKeystoneForwarder → `onReport`: a 1.50 USDC line for the borrower. Test nullifier, not a World ID proof | [0xa92d7dee…8427](https://explorer.testnet.arc.io/tx/0xa92d7dee109c04639a56cd130b978106ad05c5b5c7a8e6d84c53d5821b068427) | 189,236 |
| 4 | Operator approves and funds the credit pool with 1.00 USDC (`fund`) | [0x2c4037a2…54af](https://explorer.testnet.arc.io/tx/0x2c4037a23d30d71de49d71c1f23cf21605bd0e01e50894362ef907cbb1da54af), [0x2310e38f…d2a](https://explorer.testnet.arc.io/tx/0x2310e38f2585266bf87d8d2045e8b23e87de77966ac45f54be6a4ba803d2bd2a) | 55,438 / 54,665 |
| 5 | Operator sends the borrower 0.05 USDC for gas | [0x7ced66d9…5ae1](https://explorer.testnet.arc.io/tx/0x7ced66d9821e32fd1af6becfd9287de8c53e30dacbfaa14423e0b6869d155ae1) | 73,938 |
| 6 | **Borrower `drawToPool` 1.00 USDC** under the precommitment its Kohaku account computed: pool `Deposited` with depositor = the credit line, debt 1.00 USDC | [0x25fc8a15…7bae](https://explorer.testnet.arc.io/tx/0x25fc8a159d88225c5313cd92a3eca3cfaec7c6a3d79b00e19dffc486a81d7bae) | 443,028 |
| 7 | ASP approves the label (`updateRoot`; one more root was posted at start-up) | [0xd474cde5…99c7](https://explorer.testnet.arc.io/tx/0xd474cde5f5ff7c3a3d7638910ae0ae39c9f6b36e758e92fb2a3ff11a3fb099c7) ([0x65dc363a…51cc](https://explorer.testnet.arc.io/tx/0x65dc363a40cb379ce5ed551d5ceb212d4d987193539af00e28a2b67613d551cc)) | 149,661 |
| 8 | **Pay a 0.40 USDC Noren invoice privately** (`NorenCheckout.pay`, relayed by the merchant server; proof 2.46 s in Node). The payout `0x32EeabA9…F821` gained exactly 0.40 USDC | [0xf3b78257…723a](https://explorer.testnet.arc.io/tx/0xf3b782579b4f8076d220085df9d192eaccd0336eb20b974a689993e1fc02723a) | 596,759 |

Checked by the run: the deposit used the borrower's precommitment; the line's debt rose by exactly 1.00 USDC; the borrower is not on USDC's blocklist; in tx 8 the borrower's address and the credit line's address appear in neither sender, input nor logs; 0.60 USDC stays private afterwards; the line still owes 1.00 USDC. The operator spent **1.149471 USDC** (1.00 into the credit pool, 0.05 borrower gas, about 0.10 gas; the 0.40 went to the operator's own payout key).

Why 1.00 and not 0.50 USDC: the live pool's minimum deposit is 1 USDC, so a 0.50 draw reverts.

### Run it

```bash
pnpm exec tsx scripts/live/private-credit-live.ts --fork   # Anvil fork of Arc testnet, ports 8870-8872, ForkUSDC shim, nothing broadcast
pnpm exec tsx scripts/live/private-credit-live.ts          # public Arc testnet (operator key from .env.arc-deployer; stops above 2 USDC spent)
```

Both modes run the same steps and checks, including the CRE simulator (fork mode broadcasts with Anvil's published dev account 9). The fork run on Nov 6 passed end to end: draw, ASP approval, a 0.40 USDC private payment with the borrower absent from the payment tx. In the browser, `pnpm dev:all` → `#/pay/<id>` → **Pay later, privately** draws, waits for the ASP and pays (screenshots: `docs/img/private-credit-*.jpg`).

## Compliance: the ASP model

A Privacy Pools withdrawal must prove membership in the **ASP** (Association Set Provider) set as well as the pool. Noren's ASP is `packages/postman`. It approves a deposit's label only after it checks `USDC.isBlacklisted(depositor)` on Arc's native USDC. It then posts the root on-chain (`Entrypoint.updateRoot`). A deposit that is never approved can't be spent privately. It can only leave by **ragequit**, a public exit back to the original depositor.

For an "arrive private" deposit, **the on-chain depositor is `NorenShieldSink`**, not the person. Screening the depositor alone would screen nothing, so Noren screens the people behind the transfer:

1. **On the source chain**, USDC (FiatToken) blocks a blocklisted sender from burning: `transferFrom` checks `notBlacklisted`. The live run also read `isBlacklisted(traveller)` on Arbitrum Sepolia USDC (`false`) before letting the ASP approve.
2. **On Arc, inside the deposit**, the sink calls `isBlacklisted(sourceSender)` and `isBlacklisted(beneficiary)` on Arc's USDC. A hit puts the funds in a **compliance hold** (`ComplianceHold`). The hold is not claimable and not deposited. Only the owner can release it after review (`releaseHold`). Fork test: `test_BlocklistedSourceSenderIsHeldNotShielded`.
3. **The ASP** screens the depositor (the sink) as before. The sink's `Shielded(msgId, source, beneficiary, sourceSender, amount, precommitment, commitment)` event gives an ASP everything it needs to screen the source sender as well.
   - **Production gap:** `packages/postman` does not yet resolve sink deposits to that event. The live run did this check in the script (step 1).
4. **Exit.** Pools only let the original depositor ragequit. So `NorenShieldSink.ragequit(proof)` records who each commitment is for and sends a ragequit's funds to that beneficiary. Only the holder of the deposit's secrets can make the proof. The guard is fork-tested (`test_RagequitOnlyForCommitmentsTheSinkMade`). A full ragequit with a real proof was not run.

## Threat model

| Adversary | Learns | Doesn't learn |
|---|---|---|
| **Merchant** (and its server) | Invoice, amount, time, the refund precommitment and receipt commitment the customer bound | The customer's wallet, balance or history |
| **P2P recipient** | Amount and time; that it came from the Noren pool | The sender |
| **Noren's relayer** | Recipient, amount, the proof, the requester's IP | Which deposit or wallet the money came from |
| **Chain observer** | Every deposit (depositor, amount), every withdrawal (amount, recipient), timing, CCTP burns with their SHIELD hookData | Which deposit paid which withdrawal, within the anonymity set |
| **ASP operator** | Deposits it approves or refuses | Spends (withdrawals don't reveal the deposit) |
| **Noren contract owner** | Can rewire the hook, sink and router, and release compliance holds | Can't move pool funds or spend notes. The pool is 0xbow's Privacy Pools contracts (`packages/contracts/lib/privacy-pools-core`), which Noren does not own or modify. |

**Not defended:**
- timing and amount correlation in a small pool;
- network-level metadata (IP);
- a malicious ASP that refuses to approve (funds then exit by ragequit, publicly);
- the CRE simulator's MockKeystoneForwarder, which does not verify DON signatures. The hook's `relay()` path still verifies Circle's attestation through the real MessageTransmitterV2.

Noren's contracts are unaudited hackathon code.

## Live on public testnets (Nov 6 2026)

Record: [`scripts/live/private-runs.json`](../scripts/live/private-runs.json) and [`scripts/live/private-deployments.json`](../scripts/live/private-deployments.json). All transactions are real.

The keys were:
- the Noren operator `0x4B2ACf80…3F80`;
- a fresh traveller `0x4b840dF96493f23A7b8fFBB1F952c18E6bb56520`;
- a fresh friend `0x9fdcE313a96516414fA2ea9CF7434fadBa20F47B`.

**Contracts (Arc testnet)**

| Contract | Address | Deploy tx |
|---|---|---|
| NorenShieldSink (CCTP rail) | [`0x7799bcdae59500556b96b176c69e50fd5053ca2d`](https://explorer.testnet.arc.io/address/0x7799bcdae59500556b96b176c69e50fd5053ca2d) | [0x635d800f…7c47](https://explorer.testnet.arc.io/tx/0x635d800f761517da02dac098e0098b01e2eff3984819b91ece77515245a57c47) |
| NorenArcHook (SHIELD-aware) | [`0x30c84a5aad4f4bdd25a27e33f563efbc2cfaa3f4`](https://explorer.testnet.arc.io/address/0x30c84a5aad4f4bdd25a27e33f563efbc2cfaa3f4) | [0x5d6d2680…a542](https://explorer.testnet.arc.io/tx/0x5d6d268046424781df6b7691740b7939903ca58d5150b5b3dc1721c882dda542) |
| `hook.setRouter(sink)` | — | [0xc90e5814…58e2](https://explorer.testnet.arc.io/tx/0xc90e581476b4536118cfe8cec81046ff6e80e3556a440be4c833789a92e658e2) |
| `sink.setRail(hook, true)` | — | [0xc5df2da5…1b82](https://explorer.testnet.arc.io/tx/0xc5df2da572f58c24f3c46add55741bd5f15b26b307345d8fb847bb2d3d501b82) |
| `router.setRail(sink, CCTP)` on NorenArcActionRouter `0x3D2ddF0C…7A4` | — | [0x841fae50…fb6a](https://explorer.testnet.arc.io/tx/0x841fae507a3eef0bb235dd8349067917cf695f641c6119481f4d44937c51fb6a) |

The pool, Entrypoint and NorenCheckout are the existing ones in [LIVE.md](LIVE.md).

**Run: Arbitrum Sepolia → Arc, arrive private, pay an invoice, send to a friend** (`pnpm exec tsx scripts/live/private-live.ts`)

| # | Step | Chain | Tx | Gas |
|---|---|---|---|---|
| 1 | Operator funds the traveller with 0.002 ETH | Arbitrum Sepolia | [0x020f838b…2d69](https://sepolia.arbiscan.io/tx/0x020f838bedaee14fa0684b3136f12bbfa6243f8cc265964b6b696ef9399c2d69) | 21,000 |
| 2 | Operator sends the traveller 2.00 USDC | Arbitrum Sepolia | [0x094f0222…0773](https://sepolia.arbiscan.io/tx/0x094f022221593123e83d191ce4ef2edf224bad506c103676f096c89f4b7f0773) | 62,159 |
| 3 | Traveller approves TokenMessengerV2 | Arbitrum Sepolia | [0xc0889110…78c6](https://sepolia.arbiscan.io/tx/0xc0889110f21e5581b42b8c7d66d860d41e6896c2a45e13a264717e53b69b78c6) | — |
| 4 | **Burn 2.00 USDC with `SHIELD(precommitment)` hookData** (`depositForBurnWithHook`, fast, maxFee 390) | Arbitrum Sepolia | [0xe55d5240…e593](https://sepolia.arbiscan.io/tx/0xe55d52400e1fb3c7d3d5e73184c7eff64bf8947c0d8e07716ca9c447f63fe593) | 110,597 |
| 5 | **CRE relay → NorenArcHook.onReport → Circle mint → NorenShieldSink → `Entrypoint.deposit`**: 1.99974 USDC lands in the pool (fee 260 units), depositor = sink, `viaCre = true` | Arc | [0xdf7b3d45…815c](https://explorer.testnet.arc.io/tx/0xdf7b3d45b4363e9e66ed866e1c7356d294a894ef074554e36d6cb1f15548815c) | 655,029 |
| 6 | ASP approves the label (`updateRoot`) | Arc | [0xd29de02a…e1b6](https://explorer.testnet.arc.io/tx/0xd29de02a6c58c4a8fda129ca6c47c9a3669b9e7ff02567484d319eb8426be1b6) | 149,649 |
| 7 | **Pay a 0.75 USDC Noren invoice privately** from the arrival (`NorenCheckout.pay`; proof 3.62 s in Node). The merchant payout `0x32EeabA9…F821` gained exactly 0.75 USDC. | Arc | [0xc833c436…89ff](https://explorer.testnet.arc.io/tx/0xc833c436734b1b0425d5cab6fa6aefc0b7ecbc83a2deeb2c46d2cc14ad6589ff) | 584,773 |
| 8 | **Send 0.50 USDC privately to the friend** (`Entrypoint.relay`, relayed by the Noren server, fee 0.5%). The friend received 0.4975 USDC and the relayer 0.0025. Proof 2.37 s. | Arc | [0x69dc6a2d…ce09](https://explorer.testnet.arc.io/tx/0x69dc6a2ddc6c6e6cdb0a53813a46cca3d74c9d0d6ead85c8050709519c94ce09) | 537,512 |

Extra ASP roots: [0x7d271d55…4113](https://explorer.testnet.arc.io/tx/0x7d271d5537febfe3b5d4f3432082ca55cf1bcf3dbef165a004dd4d307a0e4113), [0x021c8b22…e645](https://explorer.testnet.arc.io/tx/0x021c8b22c924c3307c321a08e043792557f67932838679363e11e60cac65e645) and [0x011c1d51…8fdd](https://explorer.testnet.arc.io/tx/0x011c1d51342a97d0a22b21058058c434ba4d5f3c30755183318d0143c19e8fdd). Each restart of the script posted a fresh root. Kohaku's sync fetches the tree named by the latest on-chain root, and an earlier run's loopback URL had gone away.

**What the run checked:**
- The deposit was made under the precommitment that the traveller's wallet computed.
- The traveller's public Arc USDC balance was **0** after the arrival and at the end. The traveller was never funded on Arc.
- The traveller is not on USDC's blocklist on Arbitrum Sepolia or on Arc.
- The traveller's address appears in neither the sender, the input nor the logs of tx 7 or tx 8.
- After both payments, 0.74974 USDC stays private (change notes).

Arc spend for the run: about **0.06 USDC** of operator gas, out of a ≤3 USDC budget; the USDC itself came from Arbitrum Sepolia. Source-chain spend was 2.00 USDC and 0.002 ETH from the operator.

## Tests

| Suite | Command | Tests |
|---|---|---|
| NorenShieldSink against the live Arc pool, Entrypoint and router (Arc testnet fork, USDC shim) | `cd packages/ccip && FOUNDRY_PROFILE=fork forge test --match-contract NorenShieldSinkFork` | 11 |
| `NorenCreditLine.drawToPool` against the live Arc Entrypoint and USDC pool (Arc testnet fork, USDC shim) | `cd packages/arc-credit && FOUNDRY_PROFILE=fork forge test` | 15 |
| Pay later, privately end to end (draw → ASP → private invoice payment, borrower absent from the payment tx) | `pnpm exec tsx scripts/live/private-credit-live.ts --fork` | 1 run |
| NorenArcHook incl. SHIELD validation | `cd packages/cctp && forge test` | 24 |
| Action encoders (Solidity byte vector for `shield`) | `cd packages/ccip && pnpm test:sdk` | 7 |
| CCTP action encoders | `cd packages/cctp && pnpm exec vitest run test-sdk/actions.test.ts` | 4 |
| Private send relayer (RelayData, fee, refusals) | `pnpm exec vitest run packages/server/src/private.test.ts` | 3 |

What the sink fork tests cover:
- SHIELD lands in the real pool under the precommitment, and the pool records the sink as depositor;
- a PAY_INVOICE (any non-SHIELD kind) is forwarded to the real router, which pays the merchant;
- a blocklisted sender or beneficiary goes into a compliance hold;
- a reused precommitment, a deposit under the minimum and an out-of-field precommitment each become a claimable balance;
- a duplicate message is never shielded twice;
- only allowlisted rails can call, and the sink's internal shield entry is self-only;
- ragequit only works for commitments the sink made.

On the fork, Arc's precompile-backed USDC is replaced by a shim (Foundry has no Arc precompiles), the same approach as `NorenArcHookFork`.

## Run it

```bash
pnpm exec tsx scripts/live/private-deploy.ts   # NorenShieldSink + SHIELD-aware NorenArcHook, wired (resumable)
pnpm exec tsx scripts/live/private-live.ts     # the run above (resumable; --relay self uses hook.relay instead of CRE)
```

- **Keys.** The scripts read `NOREN_DEPLOYER_KEY` from the main checkout's `.env.arc-deployer`. They make the traveller, Kohaku seed and friend keys once in `.keys-live-private.json` (gitignored, 0600). No key is printed.
- **Locking.** Every operator tx, on every chain, runs under `/private/tmp/noren-arc-deployer.lock`.
- **Ports.** 8850 is the merchant server with the private relayer; 8851 is the ASP tree.

Server API:
- `GET /private/relayer` returns `{ relayer, feeRecipient, feeBps, maxRelayFeeBps, entrypoint, pool, scope }`.
- `POST /private/send` takes `{ withdrawal, proof, scope }` and returns `{ tx, recipient, amount, fee, received }`.
- Enable both with `createMerchantServer({ privateRelay: { relayerKey, feeBps } })`. On the dev stack (`dev` options, loopback fork) they are on by default, with Anvil's published dev account #9 as the relayer.
