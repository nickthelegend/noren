# Cross-chain swap: 1inch Aqua makers on Arc, orders from every chain

**One Arc maker, orders from every chain.** A maker keeps USDC (or EURC) in its own wallet on Arc and ships 1inch Aqua strategies. Each strategy's SwapVM program is Noren's Chainlink-pegged `NorenOraclePeg` instruction. Takers on other chains lock tokens in a Noren escrow on their own chain: NVDA Stock Tokens on Robinhood Chain, WETH on Base Sepolia. A **Chainlink CRE** workflow carries the order and the Chainlink price round to Arc. The maker's strategy pays the taker USDC on Arc. CRE then carries the fill back, and the escrow releases the locked tokens to the maker on the source chain.

Aqua's virtual balances let one maker wallet back every route at once. In the demo, 20,000 USDC in one wallet backs a 15,000 USDC allocation for Robinhood NVDA and another 15,000 for Base WETH. Orders from both chains fill from that same wallet.

USDC can also arrive on Arc itself, through Circle CCTP V2 or as a Chainlink CCIP instruction. It lands in Noren's shared **Arc action router** as action kind 3 (`AQUA_ORDER`), and the same settler fills it against the same maker.

Everything runs on **local forks**: an Arc Testnet fork, the warmed Robinhood Chain mainnet snapshot, and a Base Sepolia fork. No transaction is sent to a public chain. See [What is fork-only](#what-is-fork-only).

Powered by SwapVM — © Degensoft Ltd 2025.

- Code: [`packages/xchain-aqua`](../packages/xchain-aqua). It holds the contracts, the CRE workflow, the SDK and the scripts. The SwapVM instruction and router it uses are in [`packages/aqua/swapvm-ext`](../packages/aqua/swapvm-ext) and are unchanged; see [AQUA.md](AQUA.md).
- Demo: `bash packages/xchain-aqua/scripts/xchain-demo.sh`. A recorded run is in [`packages/xchain-aqua/demo/xchain-demo-transcript.txt`](../packages/xchain-aqua/demo/xchain-demo-transcript.txt) ([JSON](../packages/xchain-aqua/demo/xchain-demo.json)).

## Flow

```
 Source chain (Robinhood 4663 / Base Sepolia 84532)       Chainlink CRE (DON)                       Arc (5042002): the liquidity hub
 ─────────────────────────────────────────────────       ───────────────────                       ────────────────────────────────
 taker ─open(order)─► NorenCrossChainEscrow
   locks amountIn (all-or-nothing)
   reads Chainlink <TOKEN>/USD + uiMultiplier
   emits XChainMessage(ORDER, order, round) ────────► log trigger (per chain)
                                                       re-read the round at the log's block
                                                       skip: settled / past deadline / stale
                                                       report = payload, byte for byte ─────────► forwarder ─► NorenCrossChainSettler.onReport
                                                                                                    trusted escrow? right maker + route?
                                                                                                    relay round ─► NorenRelayedFeed (only forward)
                                                                                                    mint receipt (exact amountIn) ─► SwapVM swap:
                                                                                                      NorenAquaSwapVMRouter + official Aqua 0x1111113c…
                                                                                                      NorenOraclePeg prices it (staleness, band, funding)
                                                                                                      Aqua.pull: maker USDC ─► taker's Arc address
                                                                                                      Aqua.push: receipt ─► maker, burned in the same tx
                                                                                                    emits XChainMessage(FILLED, maker, payout, in, out)
                                                       log trigger (Arc) ◄──────────────────────────
                                                       skip unless the escrow still holds it Open
 NorenCrossChainEscrow.onReport ◄── forwarder ◄─────── report = payload
   FILLED: release amountIn to the maker's payout
   (EXPIRED: unlock the taker's refund)

 timeout: after fillDeadline anyone calls settler.expire(order) on Arc ─► EXPIRED ─► CRE ─► escrow ─► taker refund(orderId)
 liveness fallback: with no report at all, refund(orderId) works after refundAfter (≥ fillDeadline + minReleaseWindow)

 CCTP V2 / CCIP ─► NorenArcActionRouter (packages/ccip) holds AQUA_ORDER funds under `ref`
                   emits AquaOrderOpened ─► CRE ─► ROUTER_ORDER report ─► settler.fillFromActionRouter(router, ref)
                   settler (the router's aquaOperator): settleAquaOrder(ref, settler) + swap, in one call;
                   on any failure everything rolls back and the beneficiary can cancelAquaOrder(ref)
 cron ─► CRE reads Chainlink EUR/USD on Ethereum Sepolia (finalized) ─► PRICE report ─► NorenRelayedFeed (USDC → EURC route)
```

### Routes in the reference deployment

| Route | Taker sells | Maker pays on Arc | Price | Strategy side |
|---|---|---|---|---|
| Robinhood NVDA (escrowed) | NVDA Stock Token locked on Robinhood | USDC | Chainlink NVDA/USD on Robinhood (`0x379E…9F15`) and NVDA's live `uiMultiplier`, carried by the order | maker buys at oracle − bid (50 bps), +300 bps in the weekend window |
| Base WETH (escrowed) | WETH locked on Base Sepolia | USDC | Chainlink ETH/USD on Base Sepolia (`0x4aDC…7cb1`) | maker buys at oracle − bid |
| USDC → EURC (delivered) | USDC already on Arc (CCTP / router) | EURC | Chainlink EUR/USD on Ethereum Sepolia (`0x1a81…b910`), relayed by the CRE cron | maker sells at oracle + ask (40 bps) |

Adding a source chain takes one escrow deployment there, plus `setEscrow` and `setRoute` (a receipt and a relayed feed) on Arc. Nothing else changes.

## Contracts (MIT, `packages/xchain-aqua/contracts`)

| Contract | Chain | Role |
|---|---|---|
| `NorenCrossChainEscrow` | each source chain | `open(order)` locks the tokens, reads the token's Chainlink feed in the same transaction and emits the order and the round as one message. `onReport`/`receiveXChain` accept FILLED (release to the maker's payout) or EXPIRED (refund unlocked). `refund(orderId)` returns the tokens to the taker. |
| `NorenCrossChainSettler` | Arc | Routes, maker strategy registry (`buildOrder`, `register`), the fill for escrowed orders, `expire`, `fillFromActionRouter` (router kind 3), `fillDelivered` (push-style adapters), and PRICE relays. |
| `NorenEscrowReceipt` | Arc | One per escrowed source token, for example rNVDA. It is the SwapVM `tokenIn` and exists only inside a fill: minted for exactly the escrowed amount, pushed to the maker by Aqua, burned in the same call. Transfers are locked outside the settler's fill, so nobody can hold one or sell it into a strategy. For a Stock Token, `uiMultiplier()` mirrors the source token's live value, so NorenOraclePeg prices it exactly like the Stock Token. |
| `NorenRelayedFeed` | Arc | An AggregatorV3-compatible copy of a source-chain Chainlink feed. Rounds are copied unchanged, including `updatedAt`, so the instruction's staleness check measures the real Chainlink age. Rounds only move forward: older or equal rounds are ignored. |
| `XChainMessages`, `XChainInbox` | both | Transport-independent payloads and the inbox shared by both contracts (below). |

The SwapVM side is not modified for cross-chain. The Arc strategy is the same `NorenOraclePeg` instruction in the same `NorenAquaSwapVMRouter` build as on Robinhood (SwapVM v1.0.2 plus one opcode, [AQUA.md](AQUA.md)). It is deployed on Arc with CREATE2 against the official Aqua registry `0x1111113c…`. Its `base` is the receipt and its feed is the relayed feed.

### Messages (one encoding, any transport)

| Kind | Direction | Payload |
|---|---|---|
| 1 `ORDER` | escrow → settler | `abi.encode(1, CrossChainOrder, PriceRound)` |
| 3 `FILLED` / 4 `EXPIRED` | settler → escrow | `abi.encode(kind, orderId, dstChainId, dstSettler, maker, payout, amountIn, amountOut)` |
| 5 `PRICE` | CRE → settler | `abi.encode(5, relayedFeed, PriceRound)` |
| 6 `ROUTER_ORDER` | CRE → settler | `abi.encode(6, actionRouter, ref)` |
| Arc action router kind 3 `params` | CCTP/CCIP → router → settler | `abi.encode(AquaOrderParams{srcChainId, tokenOut, minAmountOut, recipient, maker, strategyHash, fillDeadline, nonce})` |

`orderId = keccak256(abi.encode(order))`. It commits to both chain ids, the escrow and the settler.

**Transports.** Both contracts inherit `XChainInbox`:
- `onReport(metadata, report)` takes a CRE report from the chain's forwarder, with an optional workflow-owner pin.
- `receiveXChain(srcChainId, srcSender, payload)` takes the same payload from an owner-approved adapter, such as a CCIP receiver. On this path the contract also checks that the sender is the escrow or settler the order names.
- Outbound, the contracts emit `XChainMessage(orderId, toChainId, to, payload)`, which the CRE log trigger reads. An optional `IXChainOutbox` can also push the same bytes over another transport.

CRE is wired now. The CCIP adapter can plug into `receiveXChain`/`IXChainOutbox` when `packages/ccip` lands. The Arc action router path (CCTP V2 hook and CCIP, `packages/ccip` `NorenArcActionRouter`) is already wired through `fillFromActionRouter`.

## Safety

| Risk | Defence | Test |
|---|---|---|
| Double release | Escrow status `Open → Released / Refundable → Refunded`. Any second settlement reverts `NotOpen`. The workflow also skips a non-Open escrow. | `test_settlementCannotReleaseTwice`, demo step 4 |
| Replay of an order | Settler status `None → Filled / Expired`. A replayed report reverts `AlreadySettled`. The workflow skips orders it reads as settled. The id commits to both chains and contracts, and the source escrow must be the trusted one. | `test_replayedOrderReportCannotFillTwice`, `test_orderForAnotherSettlerOrEscrowIsRejected`, demo step 4 |
| Stale price | The NorenOraclePeg checks run inside the swap: max age (25 h, 3 days in the weekend window), round completeness and the maker's band. A stale round makes the fill fail (`FillRejected`, nothing moves). The order can be retried or expired and refunded. The workflow skips rounds older than `maxPriceAgeSec` and fails loudly if the payload's round is newer than the feed's round at the log's block. Relayed rounds never move backwards. | `test_stalePriceIsRejectedThenExpiresAndRefunds`, `test_relayedPriceNeverRollsBack`, bun tests |
| Partial fills | All-or-nothing: the receipt is minted for exactly `amountIn`, the swap is exact-in with the taker's `minAmountOut`, and the router must return `amountIn` (`FillMismatch`). The escrow refuses a settlement whose `amountIn` differs (`PartialFill`). | `test_partialFillSettlementIsRefused`, `test_minAmountOutAboveThePegIsRejectedAndNothingMoves` |
| Wrong maker | The strategy must belong to the maker the order names, and its route must match the order's tokens and source chain (`WrongMaker`, `WrongStrategy`). The escrow checks that the settlement names the order's maker. Payout addresses come only from the maker's own registration on Arc. | `test_wrongMakerIsRejectedOnBothChains`, `test_nvdaOrderCannotUseTheWethStrategy` |
| Refund racing a fill | Fills stop at `fillDeadline` (Arc clock). The no-report refund starts at `refundAfter`, and the escrow requires `refundAfter ≥ fillDeadline + minReleaseWindow` (1 h). A fill can therefore only land in the window that leaves CRE time to report it. Once an order is EXPIRED on Arc it can never fill. | `test_timeoutRefundWithoutAnyReportAndLateFillCannotRelease`, `test_refundAfterMustLeaveAReleaseWindow`, demo step 5 |
| Under-funded or revoked maker | NorenOraclePeg checks the Aqua virtual balance and `min(wallet, allowance)`. The fill is rejected and nothing moves. | `test_underfundedMakerIsRejected` |
| Direct swaps against cross-chain strategies | Receipts can't be minted or transferred outside the settler's fill. | `test_receiptsCannotBeMintedHeldOrSwappedOutsideAFill` |
| Unauthorised writers | `onReport` accepts only the forwarder. `receiveXChain`, `fillDelivered` and `fillFromActionRouter` accept only approved adapters. A failed delivered fill pulls nothing, and a failed router fill leaves the order open for the beneficiary. | `test_onlyForwarderOrTransportCanDeliver`, `test_transportAdapterPathChecksTheSourceSender`, `test_workflowOwnerPin`, `test_failedFillLeavesTheOrderOpenForTheBeneficiary` |

### Trust model

- **CRE DON.** In production, each chain's `KeystoneForwarder` verifies a quorum of DON signatures before it calls `onReport`. The settler therefore trusts the DON that an order was really escrowed on the source chain at the stated price round. The escrow trusts the DON that the maker really paid on Arc. Every DON node re-reads chain state (the Chainlink round at the log's block, the order status), so honest nodes sign identical reports. `setExpectedWorkflowOwner` pins the workflow.
- **Simulation.** `cre workflow simulate --broadcast` goes through `MockKeystoneForwarder`, which checks no signatures. The fork deployments point at it (Arc `0x6E9E…eDc1`, Base Sepolia `0x8230…F3e5`, and the robinhood-testnet mock copied onto the Robinhood fork). They are for simulation only.
- **Chainlink.** Prices are only as good as the feeds. A wrong but fresh round is bounded only by the maker's price band. The maker's spread pays for oracle latency risk.
- **Liveness.** If CRE stops after a fill and before the release, the maker's tokens stay in the escrow until a report arrives. The `refundAfter` fallback lets a taker refund an order that was never filled. A fill that is still unreported after `refundAfter` is the residual risk, and `minReleaseWindow` sizes it.
- **Arc action router.** Funds that land via CCTP or CCIP are held by `NorenArcActionRouter` (packages/ccip). The settler can only take them as its `aquaOperator`, inside a fill that succeeds.

## What is fork-only

| Item | Status |
|---|---|
| Official Aqua `0x1111113c…` and SwapVM router `0x11111133…` on Arc | **Not deployed on Arc Testnet.** 1inch deployed them on Arc mainnet (5042) and Robinhood (4663) through CREATE3 factories: Aqua through `0x71481c3b…abe7` (Ethereum tx `0xe37e4dd7…fb1a`, from 1inch's deployer `0x0bd61d60…`), the router through `0xaa710bd4…6dd7` (swap-vm `broadcast/__DeployPadCreate3.s.sol/4663`). Neither factory has code on Arc Testnet (checked with `cast code`), so nobody but 1inch can put the official contracts at the official addresses there. The Arc Testnet fork therefore gets the official runtime bytecode copied from Arc mainnet (`anvil_setCode`, plus the router's owner slot). The codehashes are checked against Arc mainnet on every run: Aqua `0x720bc02d…41f8` (the same on Robinhood), router `0x294d0117…3a`. **No public Arc Testnet transaction was sent**, so the deployer's test USDC was not spent. |
| Arc USDC | The fork-only `ForkUSDC` shim replaces Arc's native USDC (as in `scripts/dev-stack.ts`). Stock Anvil can't execute the native one. |
| Maker EURC | Real Arc Testnet EURC contract. The maker's balance is written into its storage on the fork. |
| Robinhood Chain | The warmed mainnet snapshot (real NVDA Stock Token and Chainlink NVDA/USD) with its clock moved to now. The robinhood-testnet `MockKeystoneForwarder` is copied in from Robinhood Testnet, because Robinhood Testnet has no Chainlink stock feeds. |
| Base Sepolia | A fork of the live chain: real WETH, real Chainlink ETH/USD, real MockKeystoneForwarder. |
| Arc action router | The live `NorenArcActionRouter` `0x3D2d…A7A4` from Arc Testnet, used as forked. On the fork, its owner is impersonated to set the settler as `aquaOperator`, and the rail's delivery is played by impersonating the live `NorenCcipGateway` and minting the delivered USDC with the shim. Real CCIP and CCTP deliveries are covered by packages/ccip and the cctp-bridge branch. Setting the operator on the live router is pointless until Aqua exists on Arc Testnet. |
| EUR/USD | Read live from Ethereum Sepolia (read-only) by the CRE cron handler. |
| CCIP | No direct Robinhood↔Arc lane exists, and none is claimed here. The payloads are transport-independent, so a CCIP hub route can carry them later. |

## Tests

| Suite | Command | Result |
|---|---|---|
| Foundry, Arc Testnet fork + Robinhood snapshot | `sh packages/xchain-aqua/scripts/test-forks.sh` (phase 1) | **18 passed** (`XChainRobinhoodArcTest`) |
| Foundry, Arc Testnet fork + Base Sepolia fork, delivered orders, live action router | same script (phase 2) | **12 passed** (`XChainBaseArcTest` 3, `XChainDeliveredTest` 6, `XChainActionRouterTest` 3) |
| CRE courier logic (bun) | `cd packages/xchain-aqua/cre/xchain-aqua && bun test` | **14 passed** |
| End to end: `cre workflow simulate --broadcast` on every hop | `bash packages/xchain-aqua/scripts/xchain-demo.sh` | PASS: 12 steps (below) |

The Foundry tests fork the local Anvil forks. The test contract plays the DON: it reads the `XChainMessage` emitted on one fork and delivers it on the other as that chain's forwarder. The demo runs the same flow through the real CRE CLI (v1.39).

## Demo (on-chain token transfers on local forks)

```
bash packages/xchain-aqua/scripts/xchain-demo.sh      # ports 8810-8812, ~4 min, one fork pair at a time, stops its forks on exit
```

All hashes below are **fork** transactions. They do not exist on any public chain. The values come from the recorded run in [`demo/xchain-demo-transcript.txt`](../packages/xchain-aqua/demo/xchain-demo-transcript.txt).

| Step | What happens | Fork tx | Token transfers |
|---|---|---|---|
| Maker setup (Arc) | approve Aqua, `Aqua.ship` + `settler.register` for NVDA and WETH | `0x10695524…0a50` … `0x06398754…3157` | 15,000 USDC Aqua allocation each, from one 20,000 USDC wallet |
| 0. SDK quote | `quoteCrossChainSwap` for 2 NVDA | — | 367.612302 USDC at NVDA/USD 184.586716 (Chainlink, Robinhood), 50 bps |
| 1. Open (Robinhood) | taker locks 2 NVDA; escrow reads Chainlink NVDA/USD | `0x976b6e9f…9c8b` | taker −2 NVDA, escrow +2 NVDA |
| 2. Fill (Arc, via CRE) | ORDER report → settler → SwapVM/Aqua | `0x1e3310a1…a489` | maker −367.612302 USDC → taker +367.612302 USDC (= the SDK quote); rNVDA minted and burned |
| 3. Release (Robinhood, via CRE) | FILLED report → escrow | `0x6863b4e6…700c` | escrow −2 NVDA → maker payout +2 NVDA |
| 4. Replay | same log again | — | workflow: "already Filled on arc", no write |
| 5. Timeout | order 2 (1 NVDA) is never filled; after its deadline anyone calls `expire` on Arc → EXPIRED → refund | open `0x375b4e65…9b3e`, expire `0xddcd1226…a423`, unlock `0xccfb363f…d789`, refund `0xb7efab10…feb8` | taker +1 NVDA back |
| 6. Open (Base Sepolia) | taker wraps and locks 0.5 WETH; escrow reads Chainlink ETH/USD | `0x61638ce6…fe62` | taker −0.5 WETH, escrow +0.5 WETH |
| 7. Fill (Arc, via CRE) | same maker wallet | `0x72440bc8…8684` | maker −1,115.063719 USDC → taker +1,115.063719 USDC |
| 8. Release (Base, via CRE) | FILLED report → escrow | `0xa6166b64…f2d1` | escrow −0.5 WETH → maker payout +0.5 WETH |
| 9. Price relay (Arc, CRE cron) | Chainlink EUR/USD from Ethereum Sepolia (finalized) | `0x84fc6c72…39de` | — |
| 10–11. Router order | maker ships a USDC → EURC strategy; an AQUA_ORDER lands in the forked live action router (250 USDC) | `router.execute` `0xac86c989…9f8b` | router holds 250 USDC under `ref` |
| 12. Fill via the router (Arc, CRE) | `AquaOrderOpened` → ROUTER_ORDER → `settleAquaOrder` + swap | `0x1585538f…d635` | router −250 USDC → maker +250 USDC; maker −222.020698 EURC → taker +222.020698 EURC |

Result: the maker's one Arc wallet paid 1,482.676021 USDC to takers from two chains and received 2 NVDA on Robinhood and 0.5 WETH on Base Sepolia. It also sold 222.020698 EURC for 250 USDC that arrived through the Arc action router.

## SDK (for the integrator: Swap "Cross-chain" toggle, Bridge "Swap across chains via Aqua")

`import { … } from "@noren/xchain-aqua"`. It uses viem clients and bigint base units.

| Function | Does |
|---|---|
| `quoteCrossChainSwap({source, arc, escrow, settler, tokenIn, strategyHash, amountIn})` | Uses the round the escrow would attach now (`escrow.currentPrice`) and the strategy's terms on Arc, and applies NorenOraclePeg's arithmetic. Returns `amountOut`, `priceUsd8`, `roundId`, `priceAgeSec`, `maxAgeSec`, `fresh`, `marketClosed`, `spreadBps`, `maker`, `payout`, `makerCanPay` and `problems[]`. The demo checks that it equals the on-chain fill to the unit. |
| `listCrossChainMakers({arc, settler, srcChainId, srcToken})` | Active strategies for a route: maker, payout, spread, fills, volume. |
| `buildCrossChainOrder({...})` | Builds an order whose deadlines are valid on both clocks, with `refundAfter = fillDeadline + minReleaseWindow + 30 min`. |
| `openCrossChainSwap({source, wallet, escrow, order})` | Approves if needed, calls `open`, and returns `{orderId, txHash}`. |
| `crossChainSwapStatus({source, arc, escrow, settler, order})` | Returns the escrow and Arc status, the fill, and `next`: `waiting-for-fill`, `waiting-for-release`, `done`, `expire-on-arc`, `refund` or `refunded`. |
| `expireCrossChainSwap`, `refundCrossChainSwap` | The timeout path. |
| `encodeAquaOrderAction({...})` | The `params` bytes of Arc action-router kind 3 (AQUA_ORDER), for the CCTP hook and CCIP senders. |
| `crossChainOrderId`, `decodePegProgram`, `marketClosed`, `withSlippage`, ABIs | Helpers. |

Deployed addresses come from `packages/xchain-aqua/.fork/arc-deployment.json`, `maker.json`, `rh-escrow.json` and `base-escrow.json`, which the demo writes.

## How this differs from Aqua0

[Aqua0](https://www.aqua0.xyz) is a cross-chain shared-liquidity layer built on 1inch Aqua. It was an ETHGlobal Buenos Aires finalist, and its team describes the plan on the [1inch forum](https://gov.1inch.network/t/aqua0-cross-chain-shared-liquidity-built-on-1inch-aqua/895). LPs commit capital once to back pools on many chains. A filler on the destination chain pays out, and the swap output is bridged back to repay it, over LayerZero V2 according to that post. It targets stablecoin issuers and lists Robinhood and Arc among its chains. Noren's cross-chain swap solves a different problem:

| | Aqua0 (public description) | Noren cross-chain swap |
|---|---|---|
| What crosses chains | LP capital, bridged to repay fillers | **Orders and verified Chainlink rounds.** The maker's USDC stays in its Arc wallet, and the taker's tokens stay in an escrow on their own chain until the fill is reported. |
| Messaging | LayerZero V2 | Chainlink CRE (DON-signed reports, log and cron triggers). The payloads are transport-independent, with an inbox for CCIP adapters and the Arc action router for CCTP V2 and CCIP. |
| Pricing | not described | Chainlink-pegged SwapVM instruction (NorenOraclePeg) with staleness, a weekend window, Stock Token `uiMultiplier`, maker price bands and funding checks |
| Assets | stablecoins | tokenized stocks (Robinhood Stock Tokens), WETH, USDC/EURC |
| Product | liquidity infrastructure | part of Noren payments and credit: pay with stocks, the credit line and liquidation on Robinhood ([CREDIT.md](CREDIT.md), [AQUA.md](AQUA.md)) |

Both build on Aqua's idea that one maker's capital backs many strategies. They are complementary rather than competing designs.

## License

- Everything in `packages/xchain-aqua` is MIT, `Copyright (c) 2026 Nivesh Gajengi`. It calls SwapVM and Aqua only through their ABIs (SwapVM-1.1 §2.2, Pure Caller Use). The router is deployed from the `packages/aqua/swapvm-ext` build artifact with CREATE2, so this package never compiles SwapVM source.
- The SwapVM instruction and router are unchanged. They stay in `packages/aqua/swapvm-ext` under LicenseRef-Degensoft-SwapVM-1.1 with its notices; see [AQUA.md § License](AQUA.md#license).
- Powered by SwapVM — © Degensoft Ltd 2025. Hackathon prototype under SwapVM-1.1 §4 (non-commercial). No endorsement by 1inch or Degensoft is implied. The contracts are unaudited.
