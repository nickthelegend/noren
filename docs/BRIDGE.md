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
                                     read NorenCredit.line(lineId).asOf, skip if stale,
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
                                                                                  borrower repays the rest; handler 2
NorenCredit.onReport ◀────────────── reports repaid ≥ drawn
  line settled, collateral returned
```

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
- **Not built here:** a workflow handler that delivers kind 2. `encodeHumanStarterReport` in `credit-bridge/bridge.ts` produces the exact bytes. The safe delivery path is a CRE HTTP trigger restricted to the World ID service's signing key, and the workflow should check the World ID proof itself before it signs. Until that handler exists, kind 2 is covered by the Foundry tests only.

## Trust assumptions

- **Who can write.** Only the CRE forwarder can change a line's limit. In production that is each chain's `KeystoneForwarder`:
  - Arc Testnet: `0x76c9cf548b4179F8901cda1f8623568b58215E62`
  - Robinhood Testnet: `0x8E6E6A1f2B2D4dF503bfd67951CF28F27BF3AF19`

  Both forwarders verify the DON's signatures over the report before they call `onReport`. A quorum of DON nodes therefore controls credit limits on Arc and utilisation on Robinhood.
- **Workflow pinning.** `NorenCreditLine.setExpectedWorkflowOwner` and `NorenCredit.setWorkflowPolicy` pin the workflow owner and ID from the report metadata, so another workflow on the same DON cannot write. Both are off in the fork run, because the simulation forwarder sends no workflow metadata.
- **Simulation forwarder.** The `MockKeystoneForwarder` used by `cre workflow simulate --broadcast` checks no signatures. A deployment pointed at it is for simulation only.
- **Determinism.** Each handler reads chain state at a fixed point: the log itself, or the line at the log's block number. Every DON node therefore builds the same report. Skips are logged with their reason: line already synced, frozen, stale, or a starter line.
- **Liveness.** If the DON stops, Arc keeps allowing draws up to the limit until expiry, but Robinhood stops seeing them. The exposure is bounded by the limit. The collateral was locked at 120% or more of the limit at the Chainlink price.
- **Settlement is not automated.** The USDC that Arc lends comes from the Arc pool. Repayments land in the same pool. A liquidation on Robinhood pays USDG to Robinhood's vault. Moving that value between the chains is a treasury step on a real route (below), not part of this workflow.

## What is simulated and what is live

| Piece | Status |
|---|---|
| `NorenCreditLine` | 47 Foundry tests (unit and fuzz) with a test ERC-20. Not deployed to Arc Testnet. |
| CRE workflow | 25 bun tests for the decision logic, using real ABI encodings. `cre workflow simulate --broadcast` ran all three handlers on local forks. Never deployed to the DON. |
| Arc side of the fork run | Anvil fork of Arc Testnet (5042002) with the real arc-testnet MockKeystoneForwarder `0x6E9E…eDc1`. Arc's native USDC was replaced by the repo's fork-only `ForkUSDC` shim, because stock Anvil cannot execute it (same as `scripts/dev-stack.ts`). |
| Robinhood side of the fork run | Anvil fork of Robinhood Chain **mainnet** (4663), using the real NVDA Stock Token and Chainlink NVDA/USD feed. The real `NorenCredit` was deployed from its branch with its own `Deploy.s.sol`, with an underwriter EIP-712 attestation. See the CRE note below. |
| Robinhood forwarder on the fork | The robinhood-testnet MockKeystoneForwarder `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885` does not exist on mainnet. Its bytecode and its two storage slots (owner, and `s_forwarders[self]`) were copied from the real Robinhood Testnet with `anvil_setCode` and `anvil_setStorageAt`. The code hash matches the testnet. |
| Public testnets | Not broadcast. That needs a funded key on both testnets in `CRE_ETH_PRIVATE_KEY` and deployed receivers. |
| Mainnet | Nothing. CRE lists forwarders only for `robinhood-testnet` and `arc-testnet`. |

**CRE note.** CRE has no Robinhood mainnet target, so the workflow addresses the Robinhood fork through the `robinhood-testnet` selector. The CRE simulator (CLI v1.39.0) does not compare the RPC's chain ID with the selector. The full run passed with the fork at its real chain ID 4663. It also passed served as 46630 (`NOREN_RH_CHAIN_ID=46630 NOREN_BRIDGE_RECEIVER=harness`). A real DON deployment would point at Robinhood Testnet, which has no Chainlink stock feeds.

**Fork clock.** The forks keep separate clocks. `NorenCredit` settles only on an Arc report dated at or after the close. So before the final repayment, the script moves Arc's next block to just after the Robinhood close if Arc is behind. It prints when it does this; in the recorded run it was not needed.

### Fork run evidence (local forks only; these hashes exist on no public chain)

The run used `NorenCredit` at branch commit `02a58d5`. Arc fork block 70975435, Robinhood fork block 107315826.

- **Collateral and limit:** 10 NVDA at Chainlink NVDA/USD $185.56, with a 120% collateral ratio, gives a line of 1,547.533639 USDC.
- **Cost of a forwarder write on the forks:** about 141k gas to open on Arc, 108k for a utilisation update on Robinhood, 83k to freeze on Arc, and 177k for the settling report on Robinhood.

| Step | Fork tx |
|---|---|
| openCreditLine → CreditLineOpened (Robinhood) | `0x9d0964d3a7e1d577d8fd0c64ec2a7f5562fec35dd34dc780dbab6760ded0d3cb` |
| NorenCreditLine.onReport via forwarder (Arc) | `0xdaabbe13fb6335c4d0e8fcca17c9e3fcc995be0c6297d58d9aedc53fa1b2c575` |
| payInvoice → Drawn 120 USDC (Arc) | `0x6afda5f04c56004b9c53815a82b0d4fc97b5d4476908d1118ef7b9dc420782d2` |
| NorenCredit.onReport via forwarder (Robinhood) | `0x20a01051ef3e335c7675386cfbe31d9b149fdb7de14da0b2b536dd87e2ef3ecd` |
| repay → Repaid 50 USDC (Arc) | `0x8c36310b8ea98377e8484786fb92ab6b5cb2ba817e3538d2f8eb5a2e3b1591d5` |
| NorenCredit.onReport via forwarder (Robinhood) | `0x76f14ccff46cfef0acca2970cad2e63b4a002c8058411cf41cba6a878809cf17` |
| closeCreditLine → CreditLineClosed (Robinhood) | `0xd80f9b29585a4a1e78c8b08df020deef26485c6e857836c057116106fded5bf5` |
| NorenCreditLine.onReport limit 0 via forwarder (Arc) | `0xbd69ffcd45245398c444c10affdf65c3021d6a95081bd28eb994657740ed2ae6` |
| repay → Repaid 70 USDC (Arc) | `0x47baf3651249412f27aa4610db584879466447e007b3bb7ae75154a19daff1d7` |
| NorenCredit.onReport via forwarder: line settled, 10 NVDA returned (Robinhood) | `0x3025f1d93a19a72e81c45d13750e9bac5bdeaeba22d0de1536ca8118cdadf4c5` |

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
cd ../cre-bridge/credit-bridge && bun install && bun test && bunx tsc --noEmit   # 25 tests
cd .. && sh scripts/fork-simulate.sh                  # both forks on 127.0.0.1:8730 (Arc) and :8731 (Robinhood), about 2 minutes
```

The script needs Foundry, the CRE CLI (logged in), bun, jq and git. It fetches the Robinhood credit branch, deploys everything on the forks, runs every handler, checks every result, and stops both forks on exit.

Options:
- `NOREN_CRE_CAPTURE=1` rewrites `fixtures/fork-run.json`.
- `NOREN_BRIDGE_RECEIVER=harness` uses the labelled `NorenCreditHarness` test stand-in instead of the real contract.
- `NOREN_RH_CHAIN_ID=46630` serves the Robinhood fork under the testnet chain ID (harness mode only, because `Deploy.s.sol` requires 4663).

It uses Anvil's published dev keys, on the forks only.

To run one handler yourself against running forks, call `cre workflow simulate credit-bridge --target local-fork --non-interactive --trigger-index <0|1|2> --evm-tx-hash <tx> --evm-event-index <i> [--broadcast] -e <env file>` from `packages/cre-bridge`. `--listen` keeps the simulator watching for new logs.

## Mapping to a real route

- **CRE.** The workflow runs as-is on `robinhood-testnet` and `arc-testnet` once both receivers are deployed with the production KeystoneForwarders and the workflow owner is pinned. Neither mainnet has a CRE forwarder yet, so the mainnet version waits on Chainlink.
- **CCIP.** CCIP has no lane between the two chains on either network. See BRIDGE-ROUTES.md §9.
- **Value: Robinhood to Arc.** The credit line moves no tokens. When the treasury needs to rebalance (for example, after a liquidation on Robinhood pays USDG into the vault, which then refills the Arc USDC pool), the best real route today is an intent bridge from USDG on Robinhood to USDC on Arc:
  - Relay: about 0.06–0.11%, about 1 s.
  - Across: 0.064–0.069%, 1–2 s, about 24.7k USDG instant limit.

  The slower path with fewer intermediaries is USDG OFT to Ethereum, then a swap, then CCTP V2 from Ethereum to Arc.
- **Value: Arc to Robinhood.** The same bridges work in reverse, from Arc USDC to Robinhood USDG.
- **Later.** Circle CCTP V2 is deployed on Robinhood (domain 35) but switched off. If Circle enables it, it would give issuer-backed USDC settlement directly between the chains. On testnet it already works both ways.
- **Stock Tokens.** They never leave Robinhood Chain. They are sold there for USDG if a line is liquidated.
