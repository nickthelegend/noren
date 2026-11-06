# Noren (暖簾)

> **Noren is a DEX and stablecoin payment network on Arc. Merchants get private stablecoin settlement; customers get credit against collateral in Noren's lending pools, and that collateral earns trading fees as 1inch Aqua liquidity.**

**What's new**
- **Lending pools that are 1inch Aqua makers.** The lender pool and the Earn vaults ship Chainlink-pegged SwapVM strategies, and their balances never leave the vault. The same capital backs loans, earns the spread on fills (stock payments, cross-chain orders, swaps where it beats Uniswap) and buys liquidated collateral in partial Dutch auctions. `harvestToRepay` lets those fees pay a loan down. We added two SwapVM opcodes: `NorenOraclePeg` (34) and `NorenDutchDecay` (35).
- **Private settlement with invoice-bound proofs.** The customer's Kohaku / 0xbow Privacy Pools proof is bound to one invoice: merchant, amount, expiry and refund address. The merchant relays it and pays the gas, and the payer's address never appears in the transaction. Refunds go back into a shielded inbox. "Pay later, privately" draws a credit line straight into the pool.
- **Arc as the hub, with Chainlink CRE in charge.** Five CRE workflows relay CCTP V2 burns, carry credit lines and Aqua orders between chains, write Chainlink FX rates and approve settlements. A CCTP hook can pay an invoice or open an Aqua order the moment the USDC lands on Arc. CCIP carries credit instructions into the same router: 10 messages, all delivered.

**Demo video:** _link added at submission_ · **Arc Studio:** [studio.arc.io/app/074b59c4…](https://studio.arc.io/app/074b59c4-98ec-44d4-908e-92f5d97d462b). It isn't public yet: logged out, it redirects to sign-in. · **Surfaces:** Noren Merchant (`#/dashboard`), the Noren app (`#/app`), the Noren SDK (`@noren/core`, `@noren/cctp`, `@noren/ccip`, `@noren/xchain-aqua`).

## Try it

**No install.** Every link under [Live on public testnets](#live-on-public-testnets) is a real transaction on a public testnet.

**Locally.** You need Node 22+, pnpm 10, Foundry (`anvil`, `forge`), bun, and the Chainlink CRE CLI (`cre`). `pnpm dev:all` prints `Setup required: …` for anything missing instead of faking it.

```sh
git clone https://github.com/nickthelegend/noren && cd noren
pnpm install
sh packages/robinhood/scripts/fork-snapshot.sh   # once: warmed snapshot of Robinhood Chain mainnet (real Stock Tokens + Chainlink feeds)
pnpm dev:all                                     # Arc testnet fork + Robinhood snapshot + contracts + CRE simulator + servers
pnpm --filter @noren/web dev                     # http://localhost:5190
```

Then open:
- **The Noren app** (`#/app`). Pick an open link on Home and pay it privately. The proof is made in your browser in about 1 s.
- **Noren Merchant** (`#/dashboard`). Create a link. Its hosted checkout, `#/pay/<id>`, offers four ways to pay.
- **Bridge** (`#/app/bridge`). Robinhood Chain ⇄ Arc over CCTP on the public testnets. This needs testnet USDC and gas on the browser's test key.
- **Swap** (`#/app/swap`). USDC → EURC on Arc testnet: Uniswap v4 first, Noren's Aqua maker when it quotes better.

```sh
pnpm test                 # 142 offline tests
pnpm e2e                  # private payment + 5 on-chain attacks + refund on a fresh Arc testnet fork
pnpm e2e:credit           # pay with stocks + pay later, against a running dev:all (NOREN_MERCHANT_TOKEN=<printed key>)
```

## Architecture

![Noren architecture](docs/img/architecture.png)

Every rail into Arc lands in one `NorenArcActionRouter`: CCTP through `NorenArcHook`, CCIP through `NorenCcipGateway`. The Robinhood Chain side (Stock Tokens, `NorenCredit`, the Aqua makers) talks to Arc only through CRE. Flows and contracts are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and product detail is in [docs/PRODUCT.md](docs/PRODUCT.md).

## Sponsor integrations

Paths are relative to this repo. Line anchors are for branch `v3`.

| Sponsor | What Noren uses | Why it matters | Code | Live proof |
|---|---|---|---|---|
| **1inch Aqua + SwapVM** | Aqua v1.0.0 as the shared-liquidity layer. Two custom SwapVM opcodes: `NorenOraclePeg` (34) quotes from a Chainlink feed and the Stock Token's `uiMultiplier`; `NorenDutchDecay` (35) runs partial liquidation auctions. | One balance backs loans, fills and liquidations without moving. Fees can repay the borrower's loan. | [opcode table](packages/aqua/swapvm-ext/src/routers/NorenAquaSwapVMRouter.sol#L27-L49) · [`NorenOraclePeg`](packages/aqua/swapvm-ext/src/instructions/NorenOraclePeg.sol#L153) · [`NorenDutchDecay`](packages/aqua/swapvm-ext/src/instructions/NorenDutchDecay.sol) · [vault ships its strategy](packages/robinhood/contracts/src/NorenVault.sol#L85) · [Earn vault](packages/robinhood/contracts/src/NorenDepositVault.sol#L120) · [best maker quote](packages/robinhood/contracts/src/NorenLiquidity.sol#L220) · [liquidate](packages/robinhood/contracts/src/NorenLiquidity.sol#L330) · [`harvestToRepay`](packages/robinhood/contracts/src/NorenBorrow.sol#L317) | Aqua on Arc testnet [`0x550C…895B`](https://explorer.testnet.arc.io/address/0x550CD499f1E2da71527f14d6469364461966895B) (runtime identical to 1inch's Arc mainnet Aqua except the metadata hash) · swap [`0xc7dfd911…`](https://explorer.testnet.arc.io/tx/0xc7dfd9119afe91a1f77cb253d1ae9f75420ccd65e61fcba55dbe10ac21d96cd8) · cross-chain fills [`0xe6dab620…`](https://explorer.testnet.arc.io/tx/0xe6dab62029db1e6924cb6ff6e229248e7bbb29d6863c2157fdb0a9dd01568dd7), [`0x243cc90e…`](https://explorer.testnet.arc.io/tx/0x243cc90eed57c6273fc790d91e73ec5af25bd29a0c3d38c20c0bbd26f955dd93) · lending, liquidation and self-repay run on a Robinhood mainnet fork ([docs/AQUA.md](docs/AQUA.md), [docs/EARN.md](docs/EARN.md)) |
| **Chainlink CRE** | Five TypeScript workflows (`@chainlink/cre-sdk` 1.23): **CCTP relay** (log triggers on 10 chains + Circle Iris over HTTP with consensus), **credit bridge** (Robinhood ⇄ Arc log triggers + an HTTP trigger), **pricing** (cron + Arc mainnet feeds over HTTP), **cross-chain Aqua** (log triggers + cron), **settlement desk** (log trigger + live Relay and Across quotes checked against Chainlink feeds) | CRE is the orchestration layer. Every cross-chain credit line, every CCTP arrival and every FX rate on Arc passes through it. | [CCTP relay](packages/cctp/cre/cctp-relay/main.ts#L117-L121) · [credit bridge](packages/cre-bridge/credit-bridge/main.ts#L224-L233) · [pricing](packages/cre-pricing/rate-oracle/main.ts#L159-L161) · [cross-chain Aqua](packages/xchain-aqua/cre/xchain-aqua/main.ts#L169-L183) · [settlement desk](packages/bridge-settlement/cre/settlement-desk/main.ts#L177-L184) · receivers: [`NorenRateOracle.onReport`](packages/contracts/src/NorenRateOracle.sol#L152), [`NorenCreditLine.onReport`](packages/arc-credit/src/NorenCreditLine.sol#L159), [`NorenCredit.onReport`](packages/robinhood/contracts/src/NorenCredit.sol#L612), [`NorenArcHook.onReport`](packages/cctp/src/NorenArcHook.sol#L113) | `cre workflow simulate --broadcast` writes on Arc testnet: FX rates [`0xa7f67bcc…`](https://explorer.testnet.arc.io/tx/0xa7f67bcc1b1a7095c1b9ffb9c20a357abea78ddbaa4b1a255b65854633321b64), credit line [`0x2b066d78…`](https://explorer.testnet.arc.io/tx/0x2b066d786b83c7fbe9d51035fbf543667139c74304e414aa6a91d50fe0f9f42e), CCTP arrival paying an invoice [`0x5f752147…`](https://explorer.testnet.arc.io/tx/0x5f752147fb96908488a120d4fb840093d8411244d2f4140f20af13c99875cc84) |
| **Chainlink CCIP 2.0** | `NorenCcipGateway` on Arc, Base Sepolia, Ethereum Sepolia and Robinhood testnet; `NorenCcipHub` on Base Sepolia (Robinhood has no lane to Arc); replay, out-of-order and failed-message handling (`retryFailed`) | Credit instructions from other chains change state on Arc: a line opens, a merchant gets paid | [`send`](packages/ccip/src/NorenCcipGateway.sol#L153) · [`_ccipReceive`](packages/ccip/src/NorenCcipGateway.sol#L180) · [`retryFailed`](packages/ccip/src/NorenCcipGateway.sol#L253) · [hub](packages/ccip/src/NorenCcipHub.sol#L98) · [router `execute`](packages/ccip/src/NorenArcActionRouter.sol#L178) | 7 runs, 10 messages, all SUCCESS: Base → Arc CREDIT_LINE [`0xc54e5cf9…`](https://ccip.chain.link/msg/0xc54e5cf92c21ef23e7784dd1148e48a91b75eb9a0ff2bc52ab6d4de80664d504) · Ethereum Sepolia → Arc PAY_ON_CREDIT [`0x3414a5d3…`](https://ccip.chain.link/msg/0x3414a5d397f5c4222aa8a30bc75c085b53127533b62376dc132923b6ec2df1a4), merchant paid [`0x78d3a38f…`](https://explorer.testnet.arc.io/tx/0x78d3a38fd41c1c2b9bee066a94ad2c83837203cd5b00b9e0bd001155edc7d7ec) · Robinhood → Base hub → Arc [`0x5b04344b…`](https://ccip.chain.link/msg/0x5b04344b6baea78121553f912df5dc3e959e320df7712ca4d82a5763559df93d) → [`0x5ed8f606…`](https://ccip.chain.link/msg/0x5ed8f6065ca9eabb731bda4214dffe24dbf612d08196732b7c94223784b29984) ([docs/CCIP.md](docs/CCIP.md#live-runs)) |
| **Chainlink Data Feeds** | Arc mainnet fiat feeds (EUR, GBP, JPY, CAD, AUD, MXN, BRL, KRW) price invoices. Robinhood Chain stock, ETH and USDG feeds value collateral and peg the makers. | Invoice quotes are re-verified on-chain at their own round IDs (`verifyQuote`) | [`quoteUsdc`](packages/core/src/pricing.ts#L31) · [`verifyQuote`](packages/contracts/src/NorenRateOracle.sol#L265) · [`NorenAssetOracle`](packages/robinhood/contracts/src/NorenAssetOracle.sol#L79) | `pnpm test` reads live Arc mainnet rounds (`pricing.test.ts`) |
| **Arc (Circle) + CCTP V2** | Arc testnet as the settlement hub (USDC for gas and settlement). `NorenArcHook` is the `destinationCaller` of every Noren burn and hands hook actions (PAY_INVOICE, AQUA_ORDER, SHIELD, CREDIT_LINE) to the router. `@noren/cctp` covers both directions. | Money from 10 configured CCTP testnets lands as USDC on Arc and can act on arrival | [`NorenArcHook.relay`](packages/cctp/src/NorenArcHook.sol#L120) · [`bridgeToArc`](packages/cctp/sdk/bridge.ts#L104) · [`burnFromArc`](packages/cctp/sdk/outbound.ts#L39) · [deployment record](deployments/5042002.json) · [Studio import](arc-studio/) | Base Sepolia burn [`0x69189700…`](https://sepolia.basescan.org/tx/0x691897008418bf06e0fbff5ae7c23be09663f84d2a976cec94a5f183184b6160) → invoice paid on Arc [`0x5f752147…`](https://explorer.testnet.arc.io/tx/0x5f752147fb96908488a120d4fb840093d8411244d2f4140f20af13c99875cc84) · from the app: Arc → Robinhood [`0x03797d2e…`](https://explorer.testnet.arc.io/tx/0x03797d2e9a08af41a78b901d89860dcc30990a9edfc5d91a1e31e02ccbe41307) → [`0xa74ed6e3…`](https://explorer.testnet.chain.robinhood.com/tx/0xa74ed6e3965976538cfd4b37c044f169e80f8549dbec3bfcf149416ad739c954) ([docs/CCTP.md](docs/CCTP.md)) |
| **EF Kohaku + 0xbow Privacy Pools** | `@kohaku-eth/privacy-pools` for shielding and browser proving (snarkjs, self-hosted artifacts). `NorenCheckout` is the pool's processooor and binds the invoice into the withdrawal. | Privacy is structural: the proof, not the UI, keeps the payer off-chain from the merchant | [Kohaku import](packages/core/src/customer.ts#L1-L2) · [plugin](packages/core/src/customer.ts#L72) · [`NorenCheckout.pay`](packages/contracts/src/NorenCheckout.sol#L64-L87) · [5 attack checks](scripts/e2e-fork.ts#L113-L147) | Private payment [`0x1ce6858a…`](https://explorer.testnet.arc.io/tx/0x1ce6858a82a86d309d41f4639d9c958a3d50a82804ed6b2efc7d82435780776a). Its logs name only the pool, `NorenCheckout`, the relaying merchant and the payout; the customer's address is absent. Refund [`0x890ab6a6…`](https://explorer.testnet.arc.io/tx/0x890ab6a618a3caf187eb26a3071660ef2f2f2d8de9298b8c71658f66c2ee016a) |
| **World ID (IDKit 4)** | Server-signed IDKit requests, verified with `developer.world.org` `/api/v4/verify`, plus a nullifier registry: one unsecured starter line per human | Unsecured credit needs Sybil resistance, and Noren stores only the nullifier | [verify](packages/world-id/src/verify.ts#L18) · [registry](packages/world-id/src/registry.ts) | Production RP. No real-human verification is recorded yet ([Honest limits](#honest-limits)) |
| **0G Private Computer** | A sealed (TeeML) credit second opinion. The address is never sent, and the enclave signature and TDX quote are checked independently. | The AI underwriter can't see who it scores | [client](packages/ai-underwriter/src/zg.ts) · [independent verify](packages/ai-underwriter/src/verify.ts) | Requests `a30b5e94-…` and `e3fa908f-…` ([docs/0G.md](docs/0G.md)) |
| Uniswap v4 *(used, not entered)* | Default swap route on Arc testnet (V4Quoter + Universal Router) | Swaps go where the liquidity is | [`arc-swap.ts`](packages/web/src/app/arc-swap.ts#L112) | [`0x599879f5…`](https://explorer.testnet.arc.io/tx/0x599879f5950f8eb59494cdd686e8fda57c9b9c0dd6aa697543206df4d9785b31) |
| Privy *(used, not entered)* | Optional email or wallet sign-in and an embedded wallet for Noren Merchant and the Noren app; the server checks tokens against Privy's JWKS | Customers without a wallet can sign in | [web](packages/web/src/privy.tsx) · [server](packages/server/src/privy.ts#L31) | — |

## Prize requirements

Partner picks: **1inch, Chainlink and Arc**. World IDKit is the alternate.

| Prize | Requirement (prize page) | How Noren meets it |
|---|---|---|
| 1inch: Build an Aqua App | "a sophisticated DeFi position on official Aqua/SwapVM contracts" | Lending pools and Earn vaults are Aqua makers. Collateral earns fill fees, those fees repay loans, and liquidations sell to makers in partial Dutch auctions. On Arc testnet: Aqua v1.0.0, unmodified ([AQUA-LIVE.md](docs/AQUA-LIVE.md)). On the Robinhood fork: 1inch's official registry `0x1111113C…a90a`. |
| | "custom SwapVM opcodes … scored higher" | Opcodes 34 (`NorenOraclePeg`) and 35 (`NorenDutchDecay`) in a recompiled `AquaSwapVMRouter` (27 tests pass, plus 1 that runs only while markets are closed) |
| | "onchain token transfers in the demo (forks ok)" | Public Arc testnet swaps and cross-chain fills (links above); stock payments and liquidations on the fork (`pnpm e2e:credit`) |
| | "real git history" | 331 commits on `v3`, the first at Nov 6 03:57 IST (after hacking opened), in separate branches per feature |
| Chainlink: Best workflow with CRE | "a CRE Workflow that's used as an orchestration layer" · "integrate at least one blockchain with an external API … data source" · "a successful simulation (via the CRE CLI)" · "meaningfully used" | 5 workflows, all in the product's main paths. External sources: Circle Iris, Relay, Across and Arc mainnet feeds. Simulated with `--broadcast`, with public Arc testnet writes linked above. 76 workflow tests. |
| Chainlink: Best use of CCIP 2.0 | "use Chainlink CCIP … to make a state change on a blockchain" · "CCIP must be used inside your smart contracts" | `NorenCcipGateway` / `NorenCcipHub` are CCIP receivers. Live messages opened a credit line and paid a merchant on Arc (links above). |
| Arc: Best DeFi / Onchain Finance App Built End to End in Arc Studio | "Arc Studio must be the starting point" · "shareable Studio URL" shown in the demo | ⚠️ **Partly met.** The Studio app imports, compiles and tests (24/24) the Arc contracts and verifies the live deployment ([docs/ARC.md](docs/ARC.md#arc-studio)), but the code came before it. The URL still redirects to sign-in. **Nick must make it shareable.** |
| | working frontend + backend, architecture diagram, video, repo | Frontend `packages/web`, backend `packages/server` + `packages/postman`, both live on Arc testnet ([docs/LIVE.md](docs/LIVE.md)). Diagram above. Repo public. Video: pending. |
| World: Best Use of IDKit *(alternate)* | "a real trust moment", minimum credential, server or on-chain verification | An unsecured starter line, one per human, with Selfie Check. Server-side `/api/v4/verify` and a nullifier registry (43 tests). ⚠️ A real World App verification still has to be done on camera. |

## Live on public testnets

On Nov 6 22:00 IST, all 115 transaction links in this README and `docs/` returned status 1 (`cast receipt`), all 27 linked contract addresses had code (`cast codesize`), and all 10 CCIP message IDs reported SUCCESS on `api.ccip.chain.link`.

| What | Transactions |
|---|---|
| **Arc testnet contracts** | [`NorenCheckout`](https://explorer.testnet.arc.io/address/0xe18a80506fdb7f5498aad7387a21134118a77547) · [Privacy Pools Entrypoint](https://explorer.testnet.arc.io/address/0xa22f3200ecb4319b48dca49677c2f73cd7260ad5) · [USDC pool](https://explorer.testnet.arc.io/address/0x393d8d46e1dff8a719820e36d70ba509896ea57d) · [`NorenRateOracle`](https://explorer.testnet.arc.io/address/0xdb828bdcf33ef0a5a32861e4831ff3dd87be831c) · [`NorenCreditLine`](https://explorer.testnet.arc.io/address/0x4e26d0bfc5ac22b3fe8579afe50cb9584b2a1f86) · [`NorenArcHook`](https://explorer.testnet.arc.io/address/0x8845ae4B87D706c31606182D5A9529b67ee6B20d) · [`NorenArcActionRouter`](https://explorer.testnet.arc.io/address/0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4) · [`NorenCcipGateway`](https://explorer.testnet.arc.io/address/0x55005e60b4d4Bed4156BC635B1342bC55d9B6247) · [Aqua](https://explorer.testnet.arc.io/address/0x550CD499f1E2da71527f14d6469364461966895B) · [Noren SwapVM router](https://explorer.testnet.arc.io/address/0x8717687866f988EEBe3bd1d8999DF820ffD9e295) · [`NorenCrossChainSettler`](https://explorer.testnet.arc.io/address/0xd9f90e397770faf66b228344af5fe285b349d016). All of them: [docs/LIVE.md](docs/LIVE.md) |
| **Private payment**, 2.50 USDC, no payer address in the tx | [`0x1ce6858a…`](https://explorer.testnet.arc.io/tx/0x1ce6858a82a86d309d41f4639d9c958a3d50a82804ed6b2efc7d82435780776a) |
| **Private refund**, 1.00 USDC into the customer's shielded inbox | [`0x890ab6a6…`](https://explorer.testnet.arc.io/tx/0x890ab6a618a3caf187eb26a3071660ef2f2f2d8de9298b8c71658f66c2ee016a) |
| **Pay later, privately**: credit drawn into the pool, then a private payment | [`0x25fc8a15…`](https://explorer.testnet.arc.io/tx/0x25fc8a159d88225c5313cd92a3eca3cfaec7c6a3d79b00e19dffc486a81d7bae) → [`0xf3b78257…`](https://explorer.testnet.arc.io/tx/0xf3b782579b4f8076d220085df9d192eaccd0336eb20b974a689993e1fc02723a) |
| **Send privately** (P2P, relayed by `Entrypoint.relay`) | [`0x69dc6a2d…`](https://explorer.testnet.arc.io/tx/0x69dc6a2ddc6c6e6cdb0a53813a46cca3d74c9d0d6ead85c8050709519c94ce09) |
| **CRE writes**: FX rates → `NorenRateOracle`; a credit line → `NorenCreditLine` | [`0xa7f67bcc…`](https://explorer.testnet.arc.io/tx/0xa7f67bcc1b1a7095c1b9ffb9c20a357abea78ddbaa4b1a255b65854633321b64) · [`0x2b066d78…`](https://explorer.testnet.arc.io/tx/0x2b066d786b83c7fbe9d51035fbf543667139c74304e414aa6a91d50fe0f9f42e) |
| **CCTP Base Sepolia → Arc, invoice paid on arrival** (PAY_INVOICE hook, relayed by CRE) | burn [`0x69189700…`](https://sepolia.basescan.org/tx/0x691897008418bf06e0fbff5ae7c23be09663f84d2a976cec94a5f183184b6160) → Arc [`0x5f752147…`](https://explorer.testnet.arc.io/tx/0x5f752147fb96908488a120d4fb840093d8411244d2f4140f20af13c99875cc84) |
| **CCTP Arbitrum Sepolia → Arc**: plain; an Aqua order on arrival; private arrival (SHIELD hook into the pool) | [`0xf4cf3e42…`](https://sepolia.arbiscan.io/tx/0xf4cf3e42f57a4097b406c587fe6f19a7e85e1d73f02937bb76f5d15d0847b53c) → [`0xb72b97ea…`](https://explorer.testnet.arc.io/tx/0xb72b97ea2d1a6d6aabbf532a947e7bfa1acf4b4d18c4bd6127929742e4bdbee6) · [`0xb7ff5e88…`](https://sepolia.arbiscan.io/tx/0xb7ff5e888260730ac16c2583cb2b16c56403de5234b5b761c3cc3069f2fd2949) → [`0xd46f2427…`](https://explorer.testnet.arc.io/tx/0xd46f2427adbd3970e8119ba2090f1cb2e293768949ec32526ad8c90f2c6feb60) · [`0xe55d5240…`](https://sepolia.arbiscan.io/tx/0xe55d52400e1fb3c7d3d5e73184c7eff64bf8947c0d8e07716ca9c447f63fe593) → [`0xdf7b3d45…`](https://explorer.testnet.arc.io/tx/0xdf7b3d45b4363e9e66ed866e1c7356d294a894ef074554e36d6cb1f15548815c) |
| **Robinhood ⇄ Arc from the Noren app** (Bridge tab, the browser's test key) | Arc → Robinhood 0.60 USDC [`0x03797d2e…`](https://explorer.testnet.arc.io/tx/0x03797d2e9a08af41a78b901d89860dcc30990a9edfc5d91a1e31e02ccbe41307) → [`0xa74ed6e3…`](https://explorer.testnet.chain.robinhood.com/tx/0xa74ed6e3965976538cfd4b37c044f169e80f8549dbec3bfcf149416ad739c954) (14 s) · Robinhood → Arc 0.50 USDC [`0x47a2e51a…`](https://explorer.testnet.chain.robinhood.com/tx/0x47a2e51abf964354da8feed31007ae2d3a7218f9a3a962d66e1e88d01b1927c9) → [`0x67711657…`](https://explorer.testnet.arc.io/tx/0x677116575e3ed4d77a8fa026bc51e9290a027b0072b283757414ededb8a2228d) |
| **Swap on Arc testnet from the Noren app** | Uniswap v4 USDC/EURC 0.05% via the Universal Router, 0.05 USDC → 0.041964 EURC [`0x599879f5…`](https://explorer.testnet.arc.io/tx/0x599879f5950f8eb59494cdd686e8fda57c9b9c0dd6aa697543206df4d9785b31) · Aqua maker (better quote), 0.05 USDC → 0.044436 EURC [`0x12df0a9c…`](https://explorer.testnet.arc.io/tx/0x12df0a9cafae3004c5625d83ce641457b7e9facdd8a065890c82503c15654440) |
| **1inch Aqua on Arc**: direct swap; CCTP burns from Arbitrum and Ethereum Sepolia with AQUA_ORDER, filled by CRE | [`0xc7dfd911…`](https://explorer.testnet.arc.io/tx/0xc7dfd9119afe91a1f77cb253d1ae9f75420ccd65e61fcba55dbe10ac21d96cd8) · [`0xe6dab620…`](https://explorer.testnet.arc.io/tx/0xe6dab62029db1e6924cb6ff6e229248e7bbb29d6863c2157fdb0a9dd01568dd7) · [`0x243cc90e…`](https://explorer.testnet.arc.io/tx/0x243cc90eed57c6273fc790d91e73ec5af25bd29a0c3d38c20c0bbd26f955dd93) ([docs/AQUA-LIVE.md](docs/AQUA-LIVE.md)) |
| **CCIP into and out of Arc**: 7 runs, 10 messages, all SUCCESS | [docs/CCIP.md § Live runs](docs/CCIP.md#live-runs) |

## What's private, what isn't

| | Private? | How |
|---|---|---|
| **Pay a Noren invoice** (default) | **Yes**: the merchant never learns the payer | A Groth16 proof made in the browser, bound to the invoice; the merchant relays it from the Kohaku pool |
| **Send privately** | **Yes**: the recipient never learns the sender | A pool withdrawal relayed by Noren (`Entrypoint.relay`) |
| **Pay later, privately** | **From the merchant, yes**. The lender still knows its borrower. | `NorenCreditLine.drawToPool` deposits under the borrower's precommitment, then the invoice is paid from the pool |
| **Arrive private** | Yes on Arc; the source-chain burn is public | A CCTP burn with a SHIELD hook lands in the pool (`NorenShieldSink`) |
| Pay with USDC, pay with stocks, Pay in 3 | **No**, and the checkout says so | Public wallets |
| Swaps, bridges, deposits, amounts, credit draws and repayments | **No** | Public transactions |

Limits: the testnet pool has few depositors, so timing can link a deposit to a payment (the checkout shows the anonymity set). The ASP screens only the on-chain depositor. Detail: [docs/PRIVACY.md](docs/PRIVACY.md).

**CROPS.** *Censorship resistant:* funds sit in the Privacy Pools contract, not with Noren, and any merchant server can relay. *Open source:* MIT, one-command local build. *Private:* the merchant learns that an invoice was paid in full, never who paid. The Noren server relays a finished proof and never sees note secrets. World ID gives Noren a nullifier, and 0G gets numeric features without an address. *Secure:* keys and proofs stay in the browser. Tampering, replay, outsider relay, expiry and stale roots revert on-chain (5/5 in `pnpm e2e`). CRE reports are accepted only from the configured forwarder. Third parties the web app can call: the chain RPCs and the self-hosted prover artifacts on the private-payment path. Optional features also call Circle Iris (Bridge), World ID (IDKit) and Privy (sign-in, when enabled).

## Tests

**605 passed, 1 skipped, 0 failed, across 21 suites.** The per-suite table and the commands are in [TESTING.md](TESTING.md#current-totals-branch-v3-at-26892ab-nov-6-2026).

| Suite | Command | Passed |
|---|---|---|
| Offline (core, server, World ID, 0G policy, CCTP/CCIP SDKs, Privy) | `pnpm test` | 142 |
| Private payment e2e on an Arc testnet fork | `pnpm e2e` | 9 Foundry + 5/5 attacks reverted |
| Robinhood contracts (credit, gateway, Aqua liquidity, Dutch, Earn, self-repay) on a mainnet fork | `sh packages/robinhood/scripts/test-fork.sh` | 158 |
| SwapVM opcodes + router | `sh packages/aqua/scripts/test-swapvm.sh` | 27 + 1 weekend-only skip |
| Arc: `NorenCreditLine` (unit + pool fork), `NorenRateOracle` | `forge test` in packages/arc-credit, packages/contracts | 47 + 15, 22 |
| CCTP / CCIP contracts (incl. forks of Circle and CCIP 2.0) | `forge test` in packages/cctp, packages/ccip | 24 / 9 + 23 |
| Cross-chain Aqua, Aqua on Arc (forks) | `sh packages/xchain-aqua/scripts/test-forks.sh`, `test-aqua-live.sh` | 31, 8 |
| CRE workflows (bun) | `bun test` in each workflow | 76 |
| Stocks + pay later, end to end | `pnpm e2e:credit` | 8/8 steps, 26–31 s |

## Honest limits

- **Public testnet vs local fork.** These run on public testnets: the Arc contracts, the private payment, refund and send, pay later privately, the CRE writes, CCTP (Base, Arbitrum, Ethereum Sepolia and Robinhood testnet to Arc, and Arc to Robinhood), CCIP, and the app's Bridge and Swap. These run on local Anvil nodes: the hosted checkout and Home's private Pay (Arc testnet fork), and the whole Robinhood side (a mainnet snapshot, because Robinhood testnet has no Chainlink feeds or real Stock Tokens). That covers stock payments, `NorenCredit`, Earn and Borrow, Aqua lending makers and liquidations. No real money moves.
- **CRE runs in the simulator.** Every CRE run is `cre workflow simulate --broadcast` through Chainlink's `MockKeystoneForwarder`, which doesn't check DON signatures, and the transactions are signed by Noren's deployer key. Nothing is deployed to a DON. CRE knows only Robinhood *testnet*, so the snapshot node is served as chain 46630.
- **Aqua addresses.** On Arc testnet, Aqua v1.0.0 runs at our own CREATE2 address, because 1inch's CREATE3 factory has no code there. Its runtime matches Arc mainnet's Aqua except the metadata hash. The SwapVM router is the official one, recompiled with our two opcodes, so it is redeployed rather than called at 1inch's address.
- **CCTP: 10 testnets configured, live from 4.** **CCIP carries instructions, CCTP carries value.** No CCIP testnet lane carries USDC into Arc. CCIP is slow on testnets: about 20 min Base → Arc, and about 38 min Robinhood → Arc through the hub.
- **Uniswap v4 on Arc testnet is undocumented.** We use the Arc mainnet v4 addresses, which also have code on the testnet.
- **Testnet roles.** On the public runs, Noren's deployer key acted as the merchant relayer, the ASP postman and the credit authority, and it funded the test customers.
- **World ID:** a production RP (fake proofs get 403). No successful real-human verification is recorded yet: it needs World App (Selfie Check), and the Orb is paused in India.
- **0G:** the live decisions ran on `glm-5.3` (TeeML, set with `ZG_PC_MODEL`), because 0GM-1.0's only TeeML provider failed its TLS handshake. Calls are paid, so the app shows the stored decision.
- **Kohaku** is used with a small local patch (`patches/apply-kohaku.mjs`) so its prover can make a custom-processooor withdrawal.
- **Arc Studio** imported and tested the Arc contracts after they were written. It was not where they started.
- Prices go stale between CRE runs (`NorenRateOracle` refuses rounds older than 25 h). Stock makers add a 3% spread while US markets are closed. Settle to Arc gets its CRE approval, but no relayer fills a fork. Pay-in-3 plans open from the SDK, not yet from the app. Browser proving was measured on a laptop, not a phone. **All contracts are unaudited hackathon code.**

## License and attributions

| Part | License |
|---|---|
| Noren (everything not listed below) | MIT, Copyright (c) 2026 Nivesh Gajengi ([LICENSE](LICENSE)) |
| `packages/aqua/swapvm-ext` (`NorenOraclePeg`, `NorenDutchDecay`, `NorenAquaSwapVMRouter`) | Degensoft SwapVM-1.1 (`LicenseRef-Degensoft-SwapVM-1.1`). **Powered by SwapVM — © Degensoft Ltd 2025.** A Modified Work: the modifications are published under the same license, with dated changes and build steps in its [`NOTICE`](packages/aqua/swapvm-ext/NOTICE). Non-commercial hackathon use (§4). See [docs/AQUA.md](docs/AQUA.md#license). |
| Vendored Privacy Pools contracts (`packages/contracts/lib/privacy-pools-core`) | Apache-2.0; files keep their headers ([NOTICE](NOTICE)) |

No endorsement by 1inch, Degensoft, 0xbow, Circle, Chainlink, World, 0G or the Ethereum Foundation is implied. The app icon and illustrations were generated with ChatGPT. The landing film was generated with Google Gemini (Veo) and keeps Gemini's visible mark. Screenshots are real captures of this app. Fonts: Geist, Geist Mono, Instrument Serif, Urbanist and Space Mono (all OFL). Claude and Codex wrote and reviewed most of the code, tests and docs.

More: [product detail](docs/PRODUCT.md) · [API](docs/API.md) · [credit](docs/CREDIT.md) · [Earn](docs/EARN.md) · [CRE pricing](docs/CRE-PRICING.md) · [bridge](docs/BRIDGE.md) · [World ID](docs/WORLD.md) · [0G](docs/0G.md) · [Arc](docs/ARC.md) · [judge report](docs/JUDGE-REPORT.md)
