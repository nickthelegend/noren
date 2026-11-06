# Noren on Chainlink CCIP

Noren uses Chainlink CCIP inside its own smart contracts to bring liquidity and instructions into **Arc** from other EVM chains. Every message runs a state change in a Noren contract when it lands:

- **Arc is the hub for liquidity.** Ethereum Sepolia and Base Sepolia have direct CCIP lanes into Arc testnet. Their `NorenCcipGateway` calls `ccipSend` straight to the Arc gateway.
- **Robinhood Chain has no lane to Arc.** It goes through a `NorenCcipHub` on Base Sepolia. The hub's `_ccipReceive` checks the source chain and sender, then calls `ccipSend` again to reach Arc.
- **On Arc**, `_ccipReceive` hands the payload to `NorenArcActionRouter`. This is the same router the CCTP rail (`NorenArcHook`, branch `cctp-bridge`) lands in. The router runs Noren actions: open a credit line, pay a merchant on credit, pay an invoice, deposit to Earn, or hold funds for a cross-chain Aqua order.
- **The reverse path** works the same way. `NorenArcActionRouter.reportLine` sends a line's utilisation from Arc through the Base hub to `NorenCcipInbox` on Robinhood.

Code: `packages/ccip` (Foundry + a viem SDK). CCIP version: **CCIP 2.0**. All four chains run OnRamp 2.0.0 and OffRamp 2.0.0 behind Router 1.2.0. Messages use `GenericExtraArgsV3`.

## Live on public testnets

Owner and deployer: `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80`. Routers come from Chainlink's CCIP directory API, and each one was checked with `eth_getCode` and `typeAndVersion`. Every address is in [`packages/ccip/deployments.json`](../packages/ccip/deployments.json).

| Chain | Contract | Address |
|---|---|---|
| Arc testnet (5042002) | NorenCcipGateway | [`0x55005e60b4d4Bed4156BC635B1342bC55d9B6247`](https://explorer.testnet.arc.io/address/0x55005e60b4d4Bed4156BC635B1342bC55d9B6247) |
| Arc testnet | NorenArcActionRouter | [`0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4`](https://explorer.testnet.arc.io/address/0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4) |
| Base Sepolia (84532) | NorenCcipHub | [`0xe57A438a8dEd2aD7D1A12Ddf497a0Da0bD2d2Ba3`](https://sepolia.basescan.org/address/0xe57A438a8dEd2aD7D1A12Ddf497a0Da0bD2d2Ba3) |
| Base Sepolia | NorenCcipGateway | [`0x8116700710aD49B5C19425f458E9CB5120A495F1`](https://sepolia.basescan.org/address/0x8116700710aD49B5C19425f458E9CB5120A495F1) |
| Robinhood Chain testnet (46630) | NorenCcipGateway | [`0x194155904568E29627A8E451BE61d3B7be918197`](https://explorer.testnet.chain.robinhood.com/address/0x194155904568E29627A8E451BE61d3B7be918197) |
| Robinhood Chain testnet | NorenCcipInbox | [`0x101951a6b269247591673F4EeFccCA63D72450bf`](https://explorer.testnet.chain.robinhood.com/address/0x101951a6b269247591673F4EeFccCA63D72450bf) |
| Ethereum Sepolia (11155111) | NorenCcipGateway | [`0x015306AC6f866bf9b2DD157a79D65159697fb4cf`](https://sepolia.etherscan.io/address/0x015306AC6f866bf9b2DD157a79D65159697fb4cf) |

### Messages

See [Live runs](#live-runs) below. Each one is tracked in the CCIP explorer at `https://ccip.chain.link/msg/<messageId>`, with the send and receipt transactions on each chain's explorer.

## Routes (verified against the CCIP lanes API, Nov 6 2026)

| From → to | Lane | Noren route |
|---|---|---|
| Ethereum Sepolia → Arc | direct | gateway → Arc gateway |
| Base Sepolia → Arc | direct | gateway → Arc gateway |
| Robinhood → Arc | **none** | Robinhood gateway → **Base Sepolia hub** → Arc gateway |
| Arc → Robinhood | **none** | Arc gateway → Base Sepolia hub → Robinhood gateway → NorenCcipInbox |
| Polygon Amoy, 0G Galileo, Tempo testnet, Solana devnet → Arc | direct | Supported by the same gateway code. Not deployed here (no funded wallet). |
| BNB testnet → Arc | none | BNB → Base Sepolia (lane exists) → hub → Arc. Reachable with one more gateway; not deployed. |

**Mainnet (documentation only; Nick runs any mainnet step himself).** Arc mainnet (5042) has CCIP lanes with Ethereum, Base, Polygon, 0G, Solana and Tempo. Robinhood Chain mainnet (4663) has lanes with Ethereum, Base, Polygon, 0G, Arbitrum One, Avalanche, BNB Chain, HyperEVM, Monad, Bittensor EVM and Solana. There is no direct Robinhood ↔ Arc mainnet lane, so the same Base (or Ethereum, Polygon, 0G) hub pattern applies.

### Tokens: what CCIP can move into Arc today

The lanes API lists **no supported tokens** on Robinhood ↔ Base Sepolia or on Base Sepolia ↔ Arc. Into Arc, the only CCIP token is **syrupUSDC** from Ethereum Sepolia. **CCIP-BnM** is listed on Robinhood ↔ Ethereum Sepolia, BNB, Arbitrum Sepolia, Monad and 0G, but on no lane into Arc. No testnet lane carries USDC into Arc.

So on these testnets **CCIP carries the instruction, and the USDC on Arc comes from Noren's Arc liquidity** (a credit line paid from the router's pool) or from the CCTP rail. The contracts still support programmable token transfers end to end:

- `send(..., token, amount, ...)` attaches one token.
- The Arc router books delivered tokens per action.
- A hub keeps tokens in custody (claimable by the origin sender) when the onward lane can't carry them.

On a lane that lists a token (for example syrupUSDC Sepolia → Arc, or BnM Robinhood → Sepolia), value moves with the message. Live run #7 moved 1 CCIP-BnM from Robinhood to Ethereum Sepolia this way.

## Message format (shared with xchain-aqua and the credit line)

Every hop carries one envelope (`src/libraries/NorenCcipEnvelope.sol`, `sdk/action.ts`):

```
Envelope { uint8 version=1; uint64 originChain; address originSender; uint64 nonce;
           uint64 finalChain; address finalReceiver; bytes32 prevMessageId; bytes payload }
```

- `(originChain, nonce)` names one Noren message across all hops.
- A hub sets `prevMessageId` to the inbound CCIP messageId, so the Arc delivery links back to the Robinhood send.

On Arc, the payload is the **shared action ABI** used by both the CCIP and CCTP rails (`src/libraries/NorenArcAction.sol`):

```
action = abi.encode(uint8 kind, address beneficiary, bytes32 ref, bytes params)
```

| kind | name | params | effect on Arc |
|---|---|---|---|
| 1 | PAY_INVOICE | `(address merchant, bytes32 invoiceId)` | Pays the delivered USDC to the merchant; each invoice can be paid once. |
| 2 | EARN_DEPOSIT | `(address vault)` | ERC-4626 deposit of the delivered token for the beneficiary (the vault must be allowlisted). |
| 3 | AQUA_ORDER | opaque order bytes (xchain-aqua format) | Records the order and holds any funds under `ref`. `settleAquaOrder(ref, to)` is for the Aqua operator; `cancelAquaOrder(ref)` is for the beneficiary. |
| 4 | CREDIT_LINE | `(bytes32 lineId, uint256 limitUsdc6, uint64 expiry, uint64 asOf)` | Opens or updates a line. Only a credit authority for (rail, source chain, sender) may send it. A lower `asOf` is ignored. |
| 5 | PAY_ON_CREDIT | `(bytes32 lineId, address merchant, bytes32 invoiceId, uint256 amountUsdc6)` | Pays the merchant in USDC from Arc liquidity, within the line's limit. Only the borrower may send it, and only before expiry. |
| 6 | LINE_REPORT | `(bytes32 lineId, uint256 drawn, uint256 repaid, uint64 asOf)` | Arc → other chains: line utilisation, sent by the router itself. |

The router interface both rails call:

```solidity
interface INorenActionSink {
  // rail = keccak256("CCIP") | keccak256("CCTP"); msgId = CCIP messageId | CCTP nonce;
  // source = CCIP chain selector | CCTP domain. The rail transfers `amount` of `token` to the router first.
  function execute(bytes32 rail, bytes32 msgId, uint64 source, address sourceSender,
                   address token, uint256 amount, bytes calldata action) external returns (bool ok);
}
```

The CCTP hook enables itself with `setRail(hook, keccak256("CCTP"))` (owner only). It mints USDC to the hook, transfers it to the router, and calls `execute` with the action from `hookData`.

## Safety

| Concern | How it's handled |
|---|---|
| Unknown source | `peers[sourceChain][sender]` allowlist. A direct `GATEWAY` peer must equal the envelope's origin. A `HUB` peer may only relay origins listed in `allowedOrigin`. Anything else reverts with `UntrustedSender` / `OriginMismatch` / `OriginNotAllowed`, which leaves the message failed in CCIP with no state change. Fork test: `test_UnknownSourceSenderIsRejected`. |
| Replay | Every CCIP messageId is marked in `seenMessage` (on top of the OffRamp's own execution state). `(originChain, nonce)` is de-duplicated at the hub (`relayedBy`) and at the destination (`deliveredBy`). A duplicate is recorded and never executed; any tokens it carried can be recovered. The router is idempotent per `(rail, msgId)`. Fork test: `test_ReplayOfSameMessageIsRejected`. |
| Out-of-order delivery | CCIP 2.0 lanes don't order messages. Each Noren message is independent. Credit updates carry `asOf`, so a late, older update can't overwrite a newer one (router and inbox). Fork test: `test_OutOfOrderDeliveryKeepsNewestCreditUpdate`. |
| A failing action | The gateway calls the app in a `try`. With value attached, the router books it as a claimable balance. Without value (an instruction only), the message is stored as FAILED, and `retryFailed(messageId)` (anyone can call it) re-runs it later. The owner's `recoverFailed` returns tokens. Fork test: `test_PayOnCreditWithoutLiquidity_FailsSafely_ThenRetrySucceeds`. |
| Hub can't pay the second hop | The inbound CCIP execution still succeeds. The hub stores the envelope hash as PENDING and emits the envelope. Anyone can call `retryForward(inboundId, envelope)` with native gas. Fork test: `test_HubOutOfFees_ForwardPending_ThenAnyoneRetries`. |
| Manual execution | A message that fails *inside* CCIP shows as failed in the CCIP explorer (live example: run #7 below). Causes are an allowlist revert or out-of-gas. Fix the cause (for example `setPeer`), then open `https://ccip.chain.link/msg/<id>` and use **manual execution**, which lets you raise the gas limit. `readyForManualExecution` in the CCIP API (and `trackJourney`) flags it. |
| Gas per hop | Hub `ccipReceive`, including its own `ccipSend`: 400k. Arc gateway plus action router: 500k. Robinhood/Base gateway plus inbox: 400k. Ethereum Sepolia: 1.5M (its storage repricing; 1.31M measured live). Each is set per route (`setRoute` / `setHubRoute`), and each is checked in the fork tests with `assertLt(gasUsed, limit)`. |
| Finality | Senders request finality (`requestedFinalityConfig = 0`). `getCCVsAndFinalityConfig` only allows faster-than-finality block depth for allowlisted senders, and only once the owner sets `minFinalityDepth`. Measured finality lag: Robinhood ~20 min, Base Sepolia ~17 min, Sepolia ~16 min, Arc instant. |
| Fees | Paid in native gas (refunded above the quote) or LINK (exactly the quote, pulled from the sender). The hub pays the second hop from its own balance. Fork test: `test_LinkFeePath_BaseSepoliaToArc`. |

Unaudited hackathon code. The owner can rewire peers and routes, and can sweep tokens via `withdrawToken`.

## SDK

```ts
import { sendViaHub, trackJourney, payOnCredit, creditLine, aquaOrder } from "@noren/ccip";

const r = await sendViaHub({ from: "robinhood", to: "arc", payload: payOnCredit({ borrower, lineId, merchant, invoiceId, amountUsdc6: 250_000n }), wallet });
// r = { messageId, txHash, nonce, fee, route: ["robinhood","baseSepolia","arc"], explorer, txExplorer }
const j = await trackJourney(r.messageId, "robinhood", "arc");
// j.hops[i] = { from, to, messageId, ccipStatus, explorer, sendTx, receiptTx, readyForManualExecution, hubForward }
// j.final = NONE | DELIVERED | FAILED | RECOVERED (read from the Arc gateway)
```

- `sendViaHub({ from, to, payload, token?, feeToken?, wallet })` picks the direct lane or the Base hub. It quotes the fee, handles approvals and returns the first hop's messageId.
- `trackJourney(messageId, from, to)` reads Chainlink's CCIP API (`https://api.ccip.chain.link/v2/messages/<id>`) for each hop, follows the hub's `forwardedAs`, and reads the destination gateway's status.
- Encoders: `payInvoice`, `earnDeposit`, `aquaOrder`, `creditLine`, `payOnCredit`, `encodeEnvelope`/`decodeEnvelope`, `RAIL_CCIP`/`RAIL_CCTP`.
- CLI: `pnpm --filter @noren/ccip exec tsx scripts/journey.ts <messageId> robinhood arc`.

## Tests

| Suite | Command | Count | What it runs against |
|---|---|---|---|
| Fork (CCIP) | `pnpm --filter @noren/ccip test:fork` | 12 | Forks of Robinhood, Base Sepolia, Arc and Ethereum Sepolia testnets (details below). |
| Unit (router) | `pnpm --filter @noren/ccip test:sol` | 9 | Local; the test contract plays the rail. No CCIP mocks; only a local ERC-20/ERC-4626. |
| SDK | `pnpm --filter @noren/ccip test:sdk` | 6 | Action ABI byte-for-byte against `cast abi-encode`, envelope round-trip, routes. |
| SDK live | `pnpm --filter @noren/ccip test:live` | 2 | Chainlink's CCIP API and the testnet RPCs. |

The fork suite runs the real Chainlink Router, OnRamp 2.0 and FeeQuoter: fees, extra args, the `CCIPMessageSent` encoding and `messageId = keccak256(encodedMessage)`. Delivery calls the destination's real Router `routeMessage` as the real OffRamp 2.0, after the same receiver-finality check the OffRamp performs. The off-chain DON is not reproduced, so the fork suite is the Chainlink Local fork pattern, not a live run. On the Arc fork only, Arc's native USDC is replaced by a test ERC-20 (`ForkArcUSDC`), because Foundry can't run Arc's native-balance precompile. The live runs below use the real USDC.

## Deploy / configure

The key is read only inside the scripts, from `NOREN_DEPLOYER_KEY` in a gitignored env file. `scripts/live.sh` takes the shared deployer lock.

```bash
cd packages/ccip
export NOREN_ENV_FILE=<path to gitignored env with NOREN_DEPLOYER_KEY>
ROLE=arc CCIP_ROUTER=0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8 CCIP_SELECTOR=3034092155422581607 scripts/live.sh script/Deploy.s.sol arc_testnet
ROLE=hub ...  /  ROLE=gateway ...  /  ROLE=gateway-inbox ...     # Base Sepolia hub + gateway, Robinhood gateway + inbox
ROLE=arc|hub|base-gateway|sepolia-gateway|robinhood ARC_GATEWAY=.. BASE_HUB=.. ... scripts/live.sh script/Configure.s.sol <rpc>
GATEWAY=<gw> FINAL_CHAIN=<selector> PAYLOAD=<hex> scripts/live.sh script/Send.s.sol <rpc>
```

Ethereum Sepolia currently charges about 22.5M gas to create the 14.5 KB gateway (Base Sepolia: 3.2M), and forge's estimate falls short. Deploy there with `--gas-estimate-multiplier 760`. Gas costs only ~33 wei per unit.

## Live runs

All of these ran on public testnets on Nov 6 2026: 7 runs, 10 CCIP messages (runs 4, 5 and 6 take two hops through the Base Sepolia hub). Every message shows SUCCESS in the CCIP explorer (rechecked against `api.ccip.chain.link/v2/messages` on Nov 6, 22:00 IST). Runs 2 to 7 each ended in a state change in a Noren contract. Run 1 was a probe to the deployer's own address, so no Noren contract was called.

| # | Route | Noren action | Hops (CCIP explorer) | Result |
|---|---|---|---|---|
| 1 | Arc → Base Sepolia | AQUA_ORDER probe (sent before the Base contracts existed, so it went to the deployer EOA and no callback ran) | [`0x8dc21f93…9ceb`](https://ccip.chain.link/msg/0x8dc21f93991c32eb1319f9ce95907708c3fa7a27d577fe5b460e5bcc61639ceb) | SUCCESS in 7 s |
| 2 | Base Sepolia → Arc (direct) | CREDIT_LINE: opens line `keccak256("noren-live-line-1")`, 1 USDC limit, asOf 1 | [`0xc54e5cf9…d504`](https://ccip.chain.link/msg/0xc54e5cf92c21ef23e7784dd1148e48a91b75eb9a0ff2bc52ab6d4de80664d504) | DELIVERED; line opened on Arc (receipt [`0x7033c223…50a2`](https://explorer.testnet.arc.io/tx/0x7033c22339b8a4dc77c72151cd23a273caa46da19fd0d58a85863035d57e50a2)) |
| 3 | Ethereum Sepolia → Arc (direct) | PAY_ON_CREDIT 0.10 USDC | [`0x3414a5d3…f1a4`](https://ccip.chain.link/msg/0x3414a5d397f5c4222aa8a30bc75c085b53127533b62376dc132923b6ec2df1a4) | **Arrived out of order**, before #2 opened the line. The gateway stored it FAILED (`NoLine`) without reverting CCIP (receipt [`0xe7162e1f…419a`](https://explorer.testnet.arc.io/tx/0xe7162e1f268db40f8e20806eeb50dcec6284e980b2928f0c23fc26b00f12419a)). `retryFailed` then made it DELIVERED (tx [`0x78d3a38f…d7ec`](https://explorer.testnet.arc.io/tx/0x78d3a38fd41c1c2b9bee066a94ad2c83837203cd5b00b9e0bd001155edc7d7ec)), and the merchant received 0.10 USDC on Arc. |
| 4 | **Robinhood → Base hub → Arc** | CREDIT_LINE update: 2 USDC limit, asOf 2 | [`0x8bf11c20…477d`](https://ccip.chain.link/msg/0x8bf11c2010e50817e88d2c61a896dbcffde95af5352cda9b0c342f073bac477d) → hub → [`0xb3cca227…bac8`](https://ccip.chain.link/msg/0xb3cca227dd74fa1c70bbae1e408cbe7540a8d51792422b87fc91441002d9bac8) | DELIVERED; line now limit 2 USDC, asOf 2, source Robinhood (Arc receipt [`0xf5534577…b619`](https://explorer.testnet.arc.io/tx/0xf55345779ffe0773f35f63ce45889a490bf90857253d8a4cfa2124b9e442b619)) |
| 5 | **Robinhood → Base hub → Arc** | PAY_ON_CREDIT 0.25 USDC | [`0x5b04344b…f93d`](https://ccip.chain.link/msg/0x5b04344b6baea78121553f912df5dc3e959e320df7712ca4d82a5763559df93d) → hub → [`0x5ed8f606…9984`](https://ccip.chain.link/msg/0x5ed8f6065ca9eabb731bda4214dffe24dbf612d08196732b7c94223784b29984) | DELIVERED; merchant paid 0.25 USDC on Arc from Noren liquidity (receipt [`0x98a71c16…d867`](https://explorer.testnet.arc.io/tx/0x98a71c16434fbfe30dee4afcbcab6f21ac000b40b22a5b7a65c4d36806e3d867)); line drawn 0.35 USDC |
| 6 | **Arc → Base hub → Robinhood** (reverse) | LINE_REPORT from `NorenArcActionRouter.reportLine` | [`0x56603748…1009`](https://ccip.chain.link/msg/0x56603748215991241c874b9dc17bc44e0dce534ed0f0fb7746e79922b4541009) → hub → [`0x375c7953…5c4b`](https://ccip.chain.link/msg/0x375c795306b068bb99b9a67652841871749b73b1d77f7714bc6213680d365c4b) | DELIVERED; `NorenCcipInbox.lineReports` on Robinhood holds drawn 0.10 USDC as of the report (receipt [`0x450eb6fd…7b1d`](https://explorer.testnet.chain.robinhood.com/tx/0x450eb6fde395c508c6cf59dc7f8fdf5aa8eec3b4d3f0f3bc2e157f204d847b1d)) |
| 7 | Robinhood → Ethereum Sepolia (direct) | **Programmable token transfer**: 1 CCIP-BnM (dripped on Robinhood) plus a Noren action, sent with the SDK's `sendViaHub` | [`0xff21b3a6…728e`](https://ccip.chain.link/msg/0xff21b3a60d9d5592c5316a3b288acd0a08a0c8aa73774bf67b72be18026c728e) | The first execution failed in CCIP: Sepolia's repriced storage pushed the receive past its 400k gas limit (receipt [`0x7c67c627…7081`](https://sepolia.etherscan.io/tx/0x7c67c62767efdb0c6fc6a0ab225cf3a2a5f535cd0e4069154e2eeed100267081)). **Manual execution** through the permissionless `OffRamp.execute`, with a 2M gas override and the verifier results from the CCIP API (tx [`0xe7758a82…0322`](https://sepolia.etherscan.io/tx/0xe7758a82738c48f4f62f2d0ffe8e0d5c0ce6854cba2a887880e3c223d5070322), 1.31M gas), made it SUCCESS. The 1 BnM sits in the Sepolia gateway, claimable by the sender. Routes into Sepolia now use 1.5M gas. |

The demo merchant is `0xB593984447dB7AcC5221a6df2827aC0C9cf7d96E`, an address derived from `keccak256("noren-demo-merchant")` that has no known key. It now holds 0.35 USDC on Arc. The router's 0.5 USDC of Arc liquidity came from the deployer: approve [`0xa4b5e02d…4a7b`](https://explorer.testnet.arc.io/tx/0xa4b5e02d371b4f142a4d9df44f41b4f07f343c1d22facd141961d49fc2d94a7b), addLiquidity [`0x6bdc897e…0402`](https://explorer.testnet.arc.io/tx/0x6bdc897e22dd2fd96ee2b1b9d7b5eccab107f3cd68de5db3fbdf7f1a8bb00402). For the demo, the deployer acts as the credit authority (NorenCredit's operator) on each source chain.

Measured latency: Arc → Base 7 s (Arc finality is instant). Base → Arc ~20 min. Sepolia → Arc ~14 min. Robinhood → Base → Arc ~38 min (two finality waits).

Reproduce: `scripts/journey.ts <id> <from> <to>` (status), `scripts/retry.ts`, `scripts/manual-execute.ts`, `scripts/report-line.ts`, `scripts/send-bnm.ts`.
