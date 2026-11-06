# Credit line bridge: Robinhood Chain to Arc

A Noren customer locks Stock Tokens or ETH on Robinhood Chain and gets a USDC credit line. They spend it at Noren merchants on Arc, then repay on Arc. A Chainlink CRE workflow carries the messages between the two chains. No tokens cross chains.

- Arc contract: `NorenCreditLine` in [packages/arc-credit](../packages/arc-credit).
- Workflow: [packages/cre-bridge](../packages/cre-bridge).
- Robinhood contract: `NorenCredit` in packages/robinhood, on the Robinhood credit branch.
- Real routes for moving value between the chains: [BRIDGE-ROUTES.md](BRIDGE-ROUTES.md).

## Flow

```
Robinhood Chain                         CRE workflow (DON)                       Arc
───────────────                         ──────────────────                       ───
NorenCredit.openCreditLine
  locks collateral, emits
  CreditLineOpened ───────────────▶ handler 0: log trigger
                                     read the Arc line, skip if already synced,
                                     sign report(borrower, lineId, limit, expiry)
                                     ───────────────────────────────────────────▶ forwarder → NorenCreditLine.onReport
                                                                                   line open: available = limit
                                                                                  borrower: payInvoice(lineId, merchant, amt, invoiceId)
                                                                                   merchant paid in USDC from the pool, emits Drawn
                                    handler 2: log trigger ◀──────────────────────
                                     read lines(lineId) at the log's block,
                                     read Robinhood asOf (optional: utilisation() or line()), skip if stale,
                                     sign report(lineId, drawn, repaid, asOf)
NorenCredit.onReport ◀──────────────
  utilisation updated; past-due or
  under-collateralised lines become
  liquidatable
                                                                                  borrower: repay(lineId, amt) emits Repaid
                                    handler 2 (same as above) ◀───────────────────
NorenCredit.closeCreditLine
  emits CreditLineClosed ─────────▶ handler 1: log trigger
                                     sign report(borrower, lineId, 0, expiry)
                                     ───────────────────────────────────────────▶ forwarder → NorenCreditLine.onReport
                                                                                   line frozen for good: draws revert
                                    handler 2 on CreditLineFrozen ◀───────────────  (the freeze emits CreditLineFrozen)
NorenCredit.onReport ◀────────────── fresh snapshot dated after the close:
  if nothing is owed, the line                    a fully repaid line settles here
  settles and the collateral returns              otherwise: borrower repays the rest; handler 2
NorenCredit.onReport ◀────────────── reports repaid ≥ drawn, line settles, collateral returned

World ID server ──HTTP──────────▶ handler 3: HTTP trigger
                                     check payload + Arc state, sign kind 2 report
                                     ───────────────────────────────────────────▶ forwarder → NorenCreditLine.onReport
                                                                                   starter line opened (unsecured, Arc only)
```

Handler 2 triggers on `Drawn`, `Repaid` and `CreditLineFrozen`. The freeze relay matters because `NorenCredit` returns collateral only after an Arc report dated at or after the close. Without it, a line that was fully repaid before the close would wait for an Arc event that never comes. Handler 2 skips starter lines: they have no Robinhood line behind them.

Every write is a DON-signed report delivered by that chain's CRE forwarder. Both receivers accept `onReport` only from their configured forwarder.

## The Arc contract: NorenCreditLine

`onReport(bytes metadata, bytes report)` is forwarder-only. It accepts two report kinds.

| Kind | Encoding | Effect |
|---|---|---|
| 1, collateral line | `abi.encode(address borrower, bytes32 lineId, uint256 limitUsdc6, uint64 expiry)`, 128 bytes, the original fixed interface. Also accepted versioned as `abi.encode(uint8 1, borrower, lineId, limitUsdc6, expiry)`. | The first report opens the line, later reports update its limit and expiry, and `limitUsdc6 = 0` freezes it for good. A frozen line cannot be reopened, so replaying an old "opened" report does nothing. The borrower can never change. |
| 2, World ID starter limit | `abi.encode(uint8 2, address borrower, bytes32 nullifierHash, uint256 starterLimitUsdc6, uint64 expiry)`, 160 bytes | Unsecured starter credit for a verified unique human. See below. |

Other functions:
- `payInvoice(lineId, merchant, amount, invoiceId)`:
  - Only the borrower can call it.
  - It pays the merchant from the contract's USDC pool and emits `Drawn(lineId, amount, invoiceId, merchant)`.
  - The line is revolving: drawn minus repaid must stay at or under the limit.
  - It reverts when the line is paused, expired or frozen, or when the pool is short.
  - Each `(lineId, invoiceId)` pays only once.
- `repay(lineId, amount)`:
  - Anyone can repay. It also works while paused, after expiry and after a freeze.
  - The amount can't be more than what is outstanding.
  - It emits `Repaid(lineId, amount)`.
- Views: `lines(lineId)`, `available(lineId)`, `outstanding(lineId)` and `utilisation(lineId)`, which returns drawn, repaid and asOf.
- The `asOf` clock:
  - Every change sets `updatedAt = max(block.timestamp, previous + 1)`.
  - The bridge sends this value to `NorenCredit` as `asOf`, which rejects any report that is not newer.
  - Two events in the same second still get distinct, ordered snapshots.
- Owner functions:
  - `setPaused` stops draws only. Reports and repayments keep working.
  - `withdraw` takes out idle liquidity.
  - Also `setForwarder`, `setExpectedWorkflowOwner`, `setMaxStarterLimit`, `freezeStarterLine`, and two-step ownership.

### World ID starter limit (report kind 2)

A separate World ID service verifies a unique human and gets that person's nullifier hash. A kind 2 report then gives the borrower a small unsecured line:

- **One use per nullifier hash, ever.** `nullifierUsedBy[nullifierHash]` records the borrower. A second report with the same hash reverts `NullifierUsed`, even for a different borrower or after a freeze.
- **The starter credit is capped.** `maxStarterLimitUsdc6` is 25 USDC at deploy and owner-set. It caps the starter line's total limit, so a top-up from another nullifier also stops at the cap (`StarterCapExceeded`). Expiry is at most 90 days out.
- **The starter line is separate from collateral lines.** It lives at `starterLineId(borrower) = keccak256(abi.encode("noren.human-starter.v1", borrower))` and is marked `unsecured`. The first grant opens it and later grants top it up. Kind 1 reports cannot touch it (`NotCollateralLine`).
- **The workflow never reports starter-line draws to Robinhood.** Robinhood holds no collateral for them, and `NorenCredit`'s collateral accounting stays exact.
- **The pool takes the unsecured risk.** The owner can freeze a starter line.
- **Delivery: workflow handler 3 (HTTP trigger).** The World ID server sends the request after it has verified the proof. The handler parses and checks the payload. It then reads `nullifierUsedBy`, `maxStarterLimitUsdc6` and the starter line on Arc, so it never signs a report the contract would revert. A reused nullifier is skipped with a reason, and over-cap or bad-expiry requests fail loudly. For a DON deploy, `config.humanStarter.authorizedKeys` must list the server's signing address. The simulator does not check it.

#### Exact formats (source of truth for packages/world-id)

HTTP trigger payload (JSON), the same shape as `httpTriggerPayload` in packages/world-id:

```json
{
  "kind": "noren.human-starter.v1",
  "borrower": "0x…",
  "nullifierHash": "0x<32 bytes>",
  "limitUsdc6": "25000000",
  "expiry": 1796534006,
  "lineId": "0x…"
}
```

- `kind` is the literal string `"noren.human-starter.v1"`, not its hash.
- `limitUsdc6` is a decimal string, or a number.
- `expiry` is in unix seconds. It must be in the future and at most 90 days out.
- `lineId` is optional. If it is sent, it must equal `starterLineId(borrower)`; any other value is rejected.

On-chain report that the workflow signs, built by `encodeHumanStarterReport` in credit-bridge/bridge.ts (160 bytes):

```
abi.encode(uint8 kind = 2, address borrower, bytes32 nullifierHash, uint256 starterLimitUsdc6, uint64 expiry)
```

Line ID, one per borrower wallet:

```
lineId = NorenCreditLine.starterLineId(borrower) = keccak256(abi.encode("noren.human-starter.v1", borrower))
```

The nullifier is the one-per-human guard. `nullifierUsedBy[nullifierHash]` is set once and never cleared.

This differs from what packages/world-id assumed:
- `kind` is `uint8 2`, not `bytes32 keccak256("noren.human-starter.v1")`.
- The line ID is keyed by borrower, not `keccak256(abi.encode(kind, nullifierHash))`.
- The event is `HumanStarterGranted(lineId, borrower, nullifierHash, addedUsdc6, limitUsdc6, expiry)`.
- Reuse reverts `NullifierUsed`.

The world-id sink should send the payload above, with `lineId` dropped or computed as shown, and run `cre workflow simulate credit-bridge -R packages/cre-bridge -T local-fork --non-interactive --trigger-index 3 --http-payload '<json>' --broadcast`. The written tx shows up as `NorenCreditLine updated on arc-testnet: tx 0x…`.

## Trust assumptions

- **Who can write.** Only the CRE forwarder can change a line's limit. In production that is each chain's `KeystoneForwarder`:
  - Arc Testnet: `0x76c9cf548b4179F8901cda1f8623568b58215E62`
  - Robinhood Testnet: `0x8E6E6A1f2B2D4dF503bfd67951CF28F27BF3AF19`

  Both forwarders verify the DON's signatures over the report before they call `onReport`. A quorum of DON nodes therefore controls credit limits on Arc and utilisation on Robinhood.
- **Workflow pinning.** `NorenCreditLine.setExpectedWorkflowOwner` and `NorenCredit.setWorkflowPolicy` pin the workflow owner and ID from the report metadata, so another workflow on the same DON cannot write. Both are off in the fork run, because the simulation forwarder sends no workflow metadata.
- **Simulation forwarder.** The `MockKeystoneForwarder` used by `cre workflow simulate --broadcast` checks no signatures. A deployment pointed at it is for simulation only.
- **Optional reads never fail the workflow.** Before writing to Robinhood, the workflow reads the receiver's last accepted asOf. It tries `utilisation(bytes32)` first, then `NorenCredit.line(bytes32)`. A revert or an empty result is caught and logged. If neither read works, the workflow writes without the pre-check and `NorenCredit`'s own stale check decides. Both paths ran on forks:
  - At `02a58d5`, `utilisation` reverted, the revert was caught and the read fell back to `line()`.
  - At `4d16701`, `utilisation()` answered directly.
- **Determinism.** Each handler reads chain state at a fixed point: the log itself, or the line at the log's block number. Every DON node therefore builds the same report. Skips are logged with their reason: line already synced, frozen, stale, or a starter line.
- **Liveness.** If the DON stops, Arc keeps allowing draws up to the limit until expiry, but Robinhood stops seeing them. The exposure is bounded by the limit. The collateral was locked at 120% or more of the limit at the Chainlink price.
- **Settlement is not automated.** The USDC that Arc lends comes from the Arc pool. Repayments land in the same pool. A liquidation on Robinhood pays USDG to Robinhood's vault. Moving that value between the chains is a treasury step on a real route (below), not part of this workflow.

## What is simulated and what is live

| Piece | Status |
|---|---|
| `NorenCreditLine` | 47 Foundry tests (unit and fuzz) with a test ERC-20. Not deployed to Arc Testnet. |
| CRE workflow | 31 bun tests for the decision logic, using real ABI encodings. `cre workflow simulate --broadcast` ran all four handlers on local forks. Never deployed to the DON. |
| Arc side of the fork run | Anvil fork of Arc Testnet (5042002) with the real arc-testnet MockKeystoneForwarder `0x6E9E…eDc1`. Arc's native USDC was replaced by the repo's fork-only `ForkUSDC` shim, because stock Anvil cannot execute it (same as `scripts/dev-stack.ts`). |
| Robinhood side of the fork run | Anvil fork of Robinhood Chain **mainnet** (4663), using the real NVDA Stock Token and Chainlink NVDA/USD feed. The real `NorenCredit` was deployed from its branch with its own `Deploy.s.sol`, with an underwriter EIP-712 attestation. See the CRE note below. |
| Robinhood forwarder on the fork | The robinhood-testnet MockKeystoneForwarder `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885` does not exist on mainnet. Its bytecode and its two storage slots (owner, and `s_forwarders[self]`) were copied from the real Robinhood Testnet with `anvil_setCode` and `anvil_setStorageAt`. The code hash matches the testnet. |
| Public testnets | Not broadcast. That needs a funded key on both testnets in `CRE_ETH_PRIVATE_KEY` and deployed receivers. |
| Mainnet | Nothing. CRE lists forwarders only for `robinhood-testnet` and `arc-testnet`. |

**CRE note.** CRE has no Robinhood mainnet target, so the workflow addresses the Robinhood fork through the `robinhood-testnet` selector. The CRE simulator (CLI v1.39.0) does not compare the RPC's chain ID with the selector. The full run passed with the fork at its real chain ID 4663. It also passed served as 46630 (`NOREN_RH_CHAIN_ID=46630 NOREN_BRIDGE_RECEIVER=harness`). A real DON deployment would point at Robinhood Testnet, which has no Chainlink stock feeds.

**Fork state window.** A plain Anvil fork of Robinhood mainnet breaks after about 10 minutes, because the public RPC keeps only about 10 minutes of state history. The whole script runs in about 2.5 minutes. For longer demos, use the warmed snapshot from packages/robinhood (`scripts/fork-snapshot.sh` and `serve-snapshot.sh`).

**Fork clock.** The forks keep separate clocks. `NorenCredit` settles only on an Arc report dated at or after the close. So before each freeze and the final repayment, the script moves Arc's next block to just after the Robinhood close if Arc is behind, and it prints when it does. In the recorded run it was needed twice: the Arc fork's clock trailed Robinhood's by 7–8 seconds.

### Fork run evidence (local forks only; these hashes exist on no public chain)

The run used `NorenCredit` at branch commit `4d16701`, which has `utilisation(bytes32)`. Arc fork block 70977741, Robinhood fork block 107326963.

- **Collateral and limit:** 10 NVDA at Chainlink NVDA/USD $185.56, with a 120% collateral ratio, gives a line of 1,547.533639 USDC.
- **Cost of a forwarder write on the forks:** about 141k gas to open on Arc, 108k for a utilisation update on Robinhood, 83k to freeze on Arc, and 177k for the settling report on Robinhood.

| Step | Fork tx |
|---|---|
| openCreditLine → CreditLineOpened (Robinhood) | `0xdb4beb089f09c61e8dbecbf336d250fb447dc3543dcc4bf90ac205dbb2d3cfa1` |
| NorenCreditLine.onReport via forwarder (Arc) | `0x79fc2d970b7746cd469d019774d07c2a56044b7d235a02718f2f664e814722be` |
| payInvoice → Drawn 120 USDC (Arc) | `0x8d55261bcaff66309838e33287e529aa15aa678a044bb62c1ee81b850bf5b42a` |
| NorenCredit.onReport via forwarder (Robinhood) | `0x095357e3a6038422bcde7dd35b29380128f0664b4e2862d995db16c7c6d14772` |
| repay → Repaid 50 USDC (Arc) | `0x23079857ae0be6b7fb167626d05db4f3557aef74805f86d4abd14bb5e31a8364` |
| NorenCredit.onReport via forwarder (Robinhood) | `0xd1250dd824d0788c1662c055b61295340890c481f4fb3dcf8de58974b16932af` |
| closeCreditLine → CreditLineClosed (Robinhood) | `0x40f9ed42f315f96226b48af93b72599f87ce4dd1b166b63042e87bc013f40a9b` |
| NorenCreditLine.onReport limit 0 via forwarder (Arc) | `0x2d0fde1e0331d628e81a195ef247f6f72a5787fd2e1eaefd1ace831605fd85ce` |
| repay → Repaid 70 USDC (Arc) | `0x3b2ed2a8c38732fe73697913da6777b49af8384e6a4e17da00bbdd66a72e5625` |
| NorenCredit.onReport via forwarder: line settled, 10 NVDA returned (Robinhood) | `0xaad75626e9d56bdcf5d5dd9b95956c46eec574fbe374f18a07aac3dabf837009` |
| CreditLineFrozen → NorenCredit.onReport, fresh utilisation after the close (Robinhood) | `0x4f369435c008422359c53c31efae04cfb0e46098b11ed940d3cb15f20283457a` |
| Line 2, fully repaid before close: the freeze report alone settles it and 10 NVDA return (Robinhood) | `0x3c0dcf3652a637c65ad77e13e424e1bdcd3eb0b5e3fffce2ec222b41fa3caa77` |
| World ID starter via HTTP trigger → NorenCreditLine.onReport kind 2 (Arc) | `0x453fa3bab671ecd0cf75227a6c7cbc6e92765b0f98c5707c508a7c11eab5c7d6` |
| payInvoice 10 USDC on the starter line (Arc); handler 2 skipped it for Robinhood | `0x9342b0d20aee774de9473182e90da3e5f8d7112b8b23da772ab8759bb0630c94` |

The run also checked the following:
- A dry run without `--broadcast` changed nothing.
- Replaying the opened event skipped ("already synced"), and replaying it after the close skipped ("frozen").
- Replaying the first Drawn skipped as stale.
- `payInvoice` after the freeze reverted `LineClosed`.
- Direct `onReport` calls from a non-forwarder account reverted on both chains.

The full output is in `packages/cre-bridge/fixtures/fork-run.log`, and the hashes are in `fixtures/fork-run.json`.

## Run it

```sh
pnpm install --store-dir "<repo>/.pnpm-store"          # packages/arc-credit deps (OpenZeppelin 5.1.0, forge-std)
cd packages/arc-credit && forge test                  # 47 tests
cd ../cre-bridge/credit-bridge && bun install && bun test && bunx tsc --noEmit   # 31 tests
cd .. && sh scripts/fork-simulate.sh                  # both forks on 127.0.0.1:8730 (Arc) and :8731 (Robinhood), about 2 minutes
```

The script needs Foundry, the CRE CLI (logged in), bun, jq and git. It fetches the Robinhood credit branch, deploys everything on the forks, runs every handler, checks every result, and stops both forks on exit.

Options:
- `NOREN_CRE_CAPTURE=1` rewrites `fixtures/fork-run.json`.
- `NOREN_BRIDGE_RECEIVER=harness` uses the labelled `NorenCreditHarness` test stand-in instead of the real contract.
- `NOREN_RH_CHAIN_ID=46630` serves the Robinhood fork under the testnet chain ID (harness mode only, because `Deploy.s.sol` requires 4663).

It uses Anvil's published dev keys, on the forks only.

To run one handler yourself against running forks, call `cre workflow simulate credit-bridge --target local-fork --non-interactive --trigger-index <0|1|2> --evm-tx-hash <tx> --evm-event-index <i> [--broadcast] -e <env file>` from `packages/cre-bridge`. `--listen` keeps the simulator watching for new logs.

## Value bridge: Robinhood Chain to Arc (packages/bridge-settlement)

The credit line moves only messages. This second piece moves a merchant's value: Stock Tokens or USDG on Robinhood become USDC on Arc.

### Flow

```
Merchant (Robinhood)                 NorenSettlementDesk (Robinhood)          CRE workflow (DON)                  Keeper
────────────────────                 ───────────────────────────────          ──────────────────                  ──────
sellStockAndRequest(NVDA pool, ...)  pull 1 NVDA, Uniswap v4 swap via
  or requestSettlement(USDG, ...)      Universal Router, fill >= Chainlink
                                       NVDA/USD x uiMultiplier - 2%
                                     emits SettlementRequested ─────────▶ log trigger
                                                                           HTTP + consensus: Relay POST /quote,
                                                                             Across GET /api/suggested-fees
                                                                           HTTP JSON-RPC: Chainlink USDG/USD
                                                                             (Robinhood), USDC/USD (Arc), median block
                                                                           fair = amount x USDG/USD / USDC/USD
                                                                           approve the better quote within max
                                                                             slippage, or reject
                                     onReport (forwarder only) ◀──────────  signed report
                                     Approved: route, minOut, validUntil
                                                                                                               fresh Relay or Across
                                                                                                               calldata from the API;
                                                                                                               refuse if < minOut
                                     executeSettlement ◀──────────────────────────────────────────────────────
                                     checks calldata, approves exactly the
                                     amount, calls the real Relay Depository
                                     or Across SpokePool
                                                                         ── Arc: Relay solver / Across relayer
                                                                            pays USDC to the merchant's Arc address
                                                                            (NOT reachable from a fork)
```

### Pieces

**Uniswap v4: live pools with real liquidity.**
- The PoolManager has 54,451 `Initialize` events in Robinhood's first 10M blocks. 65 of them pair a Stock Token with USDG or ETH, and 31 of those had in-range liquidity.
- Quotes from V4Quoter `0x8Dc1…8F94` on mainnet (read-only), compared with Chainlink:

  | Pool (fee) | Sell | Chainlink value | v4 out | Under Chainlink |
  |---|---|---|---|---|
  | NVDA/USDG (0.3%) | 1 | $185.56 | 184.63 USDG | 0.5% |
  | NVDA/USDG (0.3%) | 10 | $1,855.60 | 1,843.42 USDG | 0.66% |
  | NVDA/USDG (0.3%) | 100 | $18,556.02 | 18,201.37 USDG | 1.9% |
  | TSLA/USDG (0.3%) | 1 | $347.56 | 345.88 USDG | 0.48% |
  | AAPL/USDG (0.3%) | 1 | $343.56 | 341.77 USDG | 0.52% |

  The Chainlink value column is price × amount without NVDA's `uiMultiplier` (1.000775); the desk's floor applies it. The NVDA rows were read before the fork run, which later quoted 184.37 USDG for 1 NVDA.
- The desk swaps through Universal Router `0x8876…0904` with V4_SWAP (SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL) and Permit2.
- The swap must clear the larger of the caller's minimum and the Chainlink floor. The floor is the price × `uiMultiplier` (NVDA's is 1.000775) ÷ USDG/USD, minus a bound of at most 5%.
- A stale feed, a pool with hooks, or a stock without a configured feed is refused.
- The deployed routers decode a six-field `ExactInputSingleParams`: a `uint256` sits before `hookData`. The five-field layout reverts, which was checked on the fork. Pass 0 for that field.
- NorenGateway's Chainlink-priced vault buy is the alternative when a pool is thin or a stock market is closed. It was not needed here.

**Relay first, Across as the fallback.**
- **The workflow approves a route on two checks:**
  - It checks the shape of the Relay deposit step: the Depository `0x4cD0…BC31`, `depositErc20(desk, USDG, amount, id)`, on chain 4663, with output in Arc USDC on chain 5042.
  - It checks that Across's SpokePool matches the configured one.
- **The keeper fetches fresh calldata:**
  - It calls Relay `POST /quote` with `user` set to the desk, or Across `GET /api/swap/approval` with the desk as depositor.
  - It refuses anything below the approved minimum, then calls `executeSettlement`.
- **The desk checks the calldata again on-chain:**
  - Relay is allowed only if the workflow approved Relay. The desk checks the depositor, token and exact amount. Relay's output amount is not in its calldata: the solver commits to it off-chain in the quote, and that quote is what the workflow and keeper checked.
  - Across is always allowed, because its output amount is in the calldata. The desk checks it against the approved minimum, along with the recipient, Arc USDC, destination chain 5042, the depositor, the input amount and an empty message.
- **The desk guards its own funds:**
  - It approves exactly the amount and resets the approval afterwards.
  - It checks that exactly the amount left the desk.
  - Each settlement executes once and only before `validUntil`.
  - A hard floor stops any report, including one from a compromised DON, from approving a minimum below 95% of the amount.

**CRE orchestration (blockchain + external APIs).** One log-trigger handler does all of the following:
1. Reads the desk state on-chain.
2. Calls two bridge APIs over HTTP. `ok` and `reason` must match across nodes; amounts are taken by median.
3. Reads two Chainlink feeds on two mainnets over JSON-RPC, at a median-agreed block, with byte-identical rounds. Each feed must be fresh (within 25 h) and within 1% of $1.
4. Computes the fair output and the slippage of each quote.
5. Writes an approve or reject report through the forwarder.

### What is live and what needs a real relayer

| Step | Status |
|---|---|
| Uniswap v4 pool state and quotes | Live mainnet reads |
| Stock sale through the Universal Router | Real pool on the fork. The fill equalled the V4Quoter quote, 184.373851 USDG for 1 NVDA. |
| Relay and Across quotes | Live public APIs, read-only, in both the workflow and the keeper |
| Chainlink USDG/USD and USDC/USD | Live mainnet reads over JSON-RPC |
| Approve and reject reports | `cre workflow simulate --broadcast` through the real robinhood-testnet MockKeystoneForwarder bytecode, on the fork |
| Deposit calldata | Real, from the live APIs, for the desk address on the fork |
| Deposit into Relay and Across | Executed on the fork against the real Depository and SpokePool. Balances rose by exactly the amount, and Across emitted `FundsDeposited`. |
| **Arc-side fill (USDC to the merchant on Arc)** | **Not done and not claimed.** It needs Relay's solver or an Across relayer to see a deposit on real Robinhood mainnet. Fork deposits are invisible to them. A real fill needs a mainnet deposit with real USDG. This build makes no mainnet transactions. |

### Fees and times observed (live quotes, 2026-11-06 about 05:40 UTC)

| Amount | Relay out (Arc USDC) | Across out | Fair (Chainlink) | Relay time | Across time |
|---|---|---|---|---|---|
| 100 USDG | 99.942464 (fee about 5.8 bps, relayer fee $0.05) | 99.935835 (6.4 bps) | 100.016337 | about 1 s | about 1 s |
| 184.373851 USDG | 184.285896 (4.8 bps) | 184.259067 (6.2 bps) | 184.403972 | about 1 s | about 1 s |

- **What "fair" means.** Fair is the amount × USDG/USD (0.99997934) ÷ USDC/USD (0.999816). It is slightly above 1:1 because Chainlink had USDC a little under $1.
- **Measured against fair.** Relay was 7–8 bps under fair and Across about 9 bps under.
- **Gas on the fork.** The deposits cost 93,914 gas (Relay) and 112,835 gas (Across) for `executeSettlement`.

### Fork run evidence (local fork only; these hashes exist on no public chain)

The run is `packages/bridge-settlement/scripts/fork-settle.sh` on a Robinhood mainnet fork at block 107342155, with the desk at `0xD83C…ED48` on the fork.

| Step | Fork tx |
|---|---|
| A. sellStockAndRequest: 1 NVDA → 184.373851 USDG on the v4 pool | `0xeafa43e0a1d03b01b1e17c7843fc9bcde4dd3fd7d643df5a3f2312e6b94cd86a` |
| A. CRE approve (Relay, minimum 183.481952) via forwarder | `0x23a030574f6ca56d1b95da3d71565454e7f4603b9388feb8690e0ac6df48b76c` |
| A. keeper executeSettlement → Relay Depository (requestId `0x1793…7582`) | `0xe63bb52363e0fbca91e42336685c65314c3335f63a2500a7446e463a14974dc6` |
| B. requestSettlement 100 USDG | `0xf258accfb18fd980bc15bcb06a52ec5ae27bd84db7a235f48bbbcc7550b3a6cc` |
| B. CRE approve (Relay best; minimum 99.516255) | `0x10f2aa6fdb55235d8c267b7be80aca2c50e388b197dc2b9eb903a62033a0725e` |
| B. keeper executeSettlement → Across SpokePool (fallback route), FundsDeposited | `0x9630a6adb170d252d142d58e2b5dcc0dd65d7f88d76b5831c67d774571b3fd38` |
| C. requestSettlement 100 USDG with max slippage 1 bp | `0x1580d87e16dda889dc07a7d451b317ff0b2096a69aebe826fcbde17f9b41f137` |
| C. CRE reject (best quote 8 bps under fair) | `0x4b5dfb7100178225f4f274a6a5088fb084e16c30e43cb23ba545978ff1502708` |
| C. merchant cancel, 100 USDG refunded | `0x5608e96e43dcb03b880e3320ce06957271a669eb75cad5ebf2d779dc949aa429` |

The full output is in `packages/bridge-settlement/fixtures/settle-run.log` and the hashes are in `settle-run.json`.

### Tests

- **19 Foundry tests on a live Robinhood mainnet fork, with no mocks.** They cover:
  - the v4 sale, matching the V4Quoter, and the Chainlink floor refusal
  - real deposits into the Relay Depository and the Across SpokePool
  - every calldata check
  - the report states, retry and cancel
  - access control and a stale feed
- **15 bun tests for the workflow.** Five of them read the live Relay and Across APIs and both Chainlink feeds.
- **3 vitest tests for the keeper** against the live APIs.

### Run it

```sh
cd packages/bridge-settlement
forge test                                             # 19, forks Robinhood mainnet at latest (needs network)
npx vitest run keeper                                  # 3, live APIs
cd cre/settlement-desk && bun install && bun test      # 15, 5 of them live
cd ../.. && sh scripts/fork-settle.sh                  # fork on 127.0.0.1:8732, about 1 minute; NOREN_SETTLE_CAPTURE=1 rewrites fixtures
```

- **Fork state window.** A plain fork reads lazily from the public RPC, which keeps only about 10 minutes of state history. The script finishes well within that.
- **Keeper key.** The keeper reads its key from `NOREN_KEEPER_PRIVATE_KEY`.
- **Remote RPCs.** The keeper refuses a non-loopback RPC unless `NOREN_KEEPER_ALLOW_REMOTE=1` is set.

## Mapping to a real route

- **CRE.** The workflow runs as-is on `robinhood-testnet` and `arc-testnet` once both receivers are deployed with the production KeystoneForwarders and the workflow owner is pinned. Neither mainnet has a CRE forwarder yet, so the mainnet version waits on Chainlink.
- **CCIP.** CCIP has no lane between the two chains on either network. See BRIDGE-ROUTES.md §9.
- **Value: Robinhood to Arc.** This is built as packages/bridge-settlement (above). The credit line itself moves no tokens. When the treasury needs to rebalance (for example, after a liquidation on Robinhood pays USDG into the vault, which then refills the Arc USDC pool), the best real route today is an intent bridge from USDG on Robinhood to USDC on Arc:
  - Relay: about 0.06–0.11%, about 1 s.
  - Across: 0.064–0.069%, 1–2 s, about 24.7k USDG instant limit.

  The slower path with fewer intermediaries is USDG OFT to Ethereum, then a swap, then CCTP V2 from Ethereum to Arc.
- **Value: Arc to Robinhood.** The same bridges work in reverse, from Arc USDC to Robinhood USDG.
- **Later.** Circle CCTP V2 is deployed on Robinhood (domain 35) but switched off. If Circle enables it, it would give issuer-backed USDC settlement directly between the chains. On testnet it already works both ways.
- **Stock Tokens.** They never leave Robinhood Chain. They are sold there for USDG if a line is liquidated.
