# 1inch Aqua + SwapVM live on Arc Testnet

**One Arc maker, orders from every chain, on public testnets.** A maker keeps EURC in its own wallet on Arc Testnet and ships a 1inch Aqua strategy. The strategy's SwapVM program is Noren's `NorenOraclePeg` instruction, priced by the **live NorenRateOracle EUR/USD rate**, which a Chainlink CRE workflow writes from Chainlink Data Feeds. USDC buys that EURC three ways: a direct swap on Arc, and Circle CCTP V2 transfers from Arbitrum Sepolia and from Ethereum Sepolia whose hook opens an `AQUA_ORDER` in Noren's live Arc action router, which a CRE report then fills.

Every transaction below is real and on a public chain (recorded Nov 6 2026, 12:14–12:17 UTC). The machine-readable record, with gas and decoded events for each tx, is [`packages/xchain-aqua/live/arc-testnet.json`](../packages/xchain-aqua/live/arc-testnet.json).

Powered by Aqua — © Degensoft Ltd 2025. Powered by SwapVM — © Degensoft Ltd 2025.

## What is official and what is ours (honest statement)

- **1inch's deployers aren't on Arc Testnet.** 1inch deployed Aqua (`0x1111113c…a90a`) and the SwapVM router (`0x11111133…0De`) on Arc mainnet (5042) through CREATE3 factories. Those factories have no code on Arc Testnet, so nobody but 1inch can put the contracts at the official addresses there. `cast code` on Arc Testnet returns `0x` for both addresses.
- **The Aqua registry is 1inch's official code, unmodified, redeployed by us.** It was compiled from [1inch/aqua](https://github.com/1inch/aqua) tag v1.0.0, commit `81c26e4619ce21556ab02b3284ee2685de21fb18` (contract `AquaRouter`), with upstream's own `foundry.toml` and the dependency versions upstream pins. Its runtime is 5,619 bytes and identical, byte for byte, to the code at `0x1111113c…a90a` on Arc mainnet, except the 32-byte IPFS hash inside the CBOR metadata. That hash covers source paths and file contents of the build environment, not the code. Aqua has no immutables. Its single constructor argument is the `Rescuable` owner, which is held in storage. On Arc mainnet that owner is 1inch's deployer `0x0BD61d60…b3A2`; on our copy it is Noren's deployer. The owner can only rescue tokens sent to the registry contract by mistake, and has no power over makers' balances or strategies. The check is in [`packages/aqua/aqua-official/build-check.json`](../packages/aqua/aqua-official/build-check.json) and in a fork test, and `aqua-live.ts verify` repeats it against the deployed code.
- **The SwapVM router is a modified redeploy, labelled as such.** The prize allows "redeployments of a modified SwapVM contract". `NorenAquaSwapVMRouter` is SwapVM v1.0.2's AquaSwapVMRouter (the AquaOpcodes table, opcodes 0–33, unchanged) plus one instruction, `NorenOraclePeg`, at opcode 34. Its EIP-712 domain is "Noren SwapVM" / "1.0.2-noren.1". The changes are listed with dates in [`packages/aqua/swapvm-ext/NOTICE`](../packages/aqua/swapvm-ext/NOTICE).
- **Licences.** The Degensoft licence folders and attribution are kept: [`packages/aqua/aqua-official/`](../packages/aqua/aqua-official) (LicenseRef-Degensoft-Aqua-Source-1.1, with upstream's LICENSE, LICENSES/ and THIRD_PARTY_NOTICES unchanged) and [`packages/aqua/swapvm-ext/`](../packages/aqua/swapvm-ext) (LicenseRef-Degensoft-SwapVM-1.1). This is a hackathon prototype under §4 (non-commercial use) of both licences. No endorsement by 1inch or Degensoft is implied, and these are not 1inch's deployments. Everything else is MIT and calls Aqua and SwapVM through their ABIs only. The contracts are unaudited.

## Contracts on Arc Testnet (5042002)

| Contract | Address | Deploy tx |
|---|---|---|
| 1inch Aqua registry (AquaRouter v1.0.0, **unmodified**, CREATE2) | [`0x550CD499f1E2da71527f14d6469364461966895B`](https://explorer.testnet.arc.io/address/0x550CD499f1E2da71527f14d6469364461966895B) | [0x73db5351…f549](https://explorer.testnet.arc.io/tx/0x73db5351607af37f2d129fd66300bac34c65f6a41f60f4652ae9ba23baddf549) |
| NorenAquaSwapVMRouter (SwapVM v1.0.2 + NorenOraclePeg, **modified redeploy**, CREATE2) | [`0x8717687866f988EEBe3bd1d8999DF820ffD9e295`](https://explorer.testnet.arc.io/address/0x8717687866f988EEBe3bd1d8999DF820ffD9e295) | [0x340bc44c…d43a](https://explorer.testnet.arc.io/tx/0x340bc44c5033657979816d1193897ff8e4a49f1c50da1ebe15810940ae9ed43a) |
| NorenRateOracleFeed, EUR/USD leg (MIT) | [`0x8f3a10ac41d1ac5779c8889b7a88384eda2a85af`](https://explorer.testnet.arc.io/address/0x8f3a10ac41d1ac5779c8889b7a88384eda2a85af) | [0x96dd3f0f…7748](https://explorer.testnet.arc.io/tx/0x96dd3f0f307531971346efa98157fff1729e3c0b99084eeb53fc6ca0e72f7748) |
| NorenRateOracleFeed, USDC/USD leg (MIT) | [`0xe9b8f18072ccc13e7143503f9c95ba8940dd8fa2`](https://explorer.testnet.arc.io/address/0xe9b8f18072ccc13e7143503f9c95ba8940dd8fa2) | [0x07d49046…ba1c](https://explorer.testnet.arc.io/tx/0x07d4904611928760be1e671cf84354c5cb3d43a5b3005b7fb0677f3685ebba1c) |
| NorenCrossChainSettler (MIT) | [`0xd9f90e397770faf66b228344af5fe285b349d016`](https://explorer.testnet.arc.io/address/0xd9f90e397770faf66b228344af5fe285b349d016) | [0x7580063a…3a43](https://explorer.testnet.arc.io/tx/0x7580063a34f2ee34137a1e5dda3bd4c812bb6e07cd0e56124e2ced66a6913a43) |

Already live and reused (not deployed here):

| Contract | Address |
|---|---|
| NorenRateOracle (CRE-written Chainlink FX rates, incl. EUR) | [`0xdb828bdc…831c`](https://explorer.testnet.arc.io/address/0xdb828bdcf33ef0a5a32861e4831ff3dd87be831c) |
| NorenArcActionRouter | [`0x3D2ddF0C…A7A4`](https://explorer.testnet.arc.io/address/0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4) |
| NorenArcHook (CCTP V2) | [`0x8845ae4B…6B20d`](https://explorer.testnet.arc.io/address/0x8845ae4B87D706c31606182D5A9529b67ee6B20d) |
| Circle USDC / EURC | `0x3600000000000000000000000000000000000000` / `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| CRE MockKeystoneForwarder (arc-testnet) | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |

Configuration transactions:

| Step | Tx |
|---|---|
| `settler.setRoute(0, USDC → EURC)`: base feed = EUR/USD leg, quote feed = USDC/USD leg, max age 25 h (72 h in the weekend window), USDC depeg band 200 bps | [0xf2dd01e4…b666](https://explorer.testnet.arc.io/tx/0xf2dd01e46c4907c917a4d30d545cdd9523fda80f4ab378c6b5779ace4de0b666) |
| `settler.setTransport(NorenArcActionRouter, true)` | [0xefb416fa…0165](https://explorer.testnet.arc.io/tx/0xefb416fa42952e1b73dc01ba77af01cd27024a34027d6b14a4760d7d60165140) |
| `NorenArcActionRouter.setAquaOperator(settler)` (owner = deployer) | [0x8f29dbcf…61b6](https://explorer.testnet.arc.io/tx/0x8f29dbcfbd62d904594b7614413b5bfd7b4050ce8bdb9b4f37d01735503161b6) |

### How the rate reaches the strategy

```
Chainlink EUR/USD + USDC/USD (Arc mainnet Data Feeds)
  └─ CRE workflow packages/cre-pricing ─► MockKeystoneForwarder ─► NorenRateOracle.onReport   (live, docs/LIVE.md)
        NorenRateOracleFeed (EUR/USD leg)  ──┐  AggregatorV3 views: Chainlink's own round id, answer,
        NorenRateOracleFeed (USDC/USD leg) ──┤  decimals and updatedAt (not the CRE write time)
                                             ▼
        NorenOraclePeg (SwapVM opcode 34): EURC price = EUR/USD ÷ USDC/USD × (1 + ask)
        checks on every quote: answer > 0, complete round, not in the future, max age per leg,
        USDC depeg band, maker price band 0.80–1.50, maker funding (Aqua balance and wallet/allowance)
```

The price the strategy charges is exactly `NorenRateOracle.rateE18("EUR")` plus the maker's ask. The direct swap below came out at the script's off-chain quote to the unit.

## The maker

The maker is the deployer wallet `0x4B2ACf80…3F80`. It holds EURC from Circle's faucet (CCTP V2 doesn't carry EURC to Arc: on Arc, `TokenMinterV2.burnLimitsPerMessage(EURC)` is 0, and `getLocalToken(26, Arc EURC)` is zero on Ethereum Sepolia and Base Sepolia).

| Step | Tx |
|---|---|
| Approve Aqua for EURC | [0x6809bbf0…e40c](https://explorer.testnet.arc.io/tx/0x6809bbf0db7b09fe02c1238f384bd0983f3b06ca37f254c87d50bae68600e40c) |
| `Aqua.ship(router, order, [USDC, EURC], [0, 5 EURC])`: strategy `0x1c97424c…95d2` | [0xd4497e36…da5b](https://explorer.testnet.arc.io/tx/0xd4497e36efc5199b84f94993da163e8cbb599d71270c0e15ac8926857b12da5b) |
| `settler.register(route, terms)`: ask 30 bps, +100 bps in the weekend window | [0xb1f6654e…9317](https://explorer.testnet.arc.io/tx/0xb1f6654e58714b69453071b305505f42f1db0f0c3459715086f7247f01269317) |

Aqua's virtual balance is an allocation, not an escrow: the 5 EURC stays in the maker's wallet until a fill pulls it. After the three fills below, Aqua's balances for the strategy are 1.889769 EURC and 3.499640 USDC. The maker's wallet received the USDC directly.

## Fills

The customer is `0x519042674306F780C277152A38365547AF180b8a`, a key made for the earlier live checkout run ([LIVE.md](LIVE.md)).

### 1. Direct swap on Arc

| Step | Tx | Result |
|---|---|---|
| Customer approves the SwapVM router | [0xee657fc4…fd7d](https://explorer.testnet.arc.io/tx/0xee657fc496fa451bf4c855d073cf6afbaedd4cba0f03f97d4feb2b8c4f0afd7d) | |
| **`router.swap(strategy, USDC, EURC, 0.5 USDC)`** | [0xc7dfd911…6cd8](https://explorer.testnet.arc.io/tx/0xc7dfd9119afe91a1f77cb253d1ae9f75420ccd65e61fcba55dbe10ac21d96cd8) | customer −0.500000 USDC, **+0.444364 EURC**; maker +0.5 USDC, −0.444364 EURC. Quote at `rateE18("EUR")` = 1.121836 USDC/EUR + 30 bps: 0.444364 |

### 2. Cross-chain: Arbitrum Sepolia → Arc (CCTP V2 + CRE + Aqua)

| Hop | Tx |
|---|---|
| Approve TokenMessengerV2 (Arbitrum Sepolia) | [0x6e9e635a…1912](https://sepolia.arbiscan.io/tx/0x6e9e635a7f8c99fe7a449f51f2d196c6ec99324d593cbd396e3fb3df6db41912) |
| **Source burn**: `depositForBurnWithHook(2 USDC → domain 26, destinationCaller = NorenArcHook, fast)`, hook = `AQUA_ORDER` (tokenOut EURC, recipient = customer, maker, strategy, min out, deadline) | [0xf302af91…6a21](https://sepolia.arbiscan.io/tx/0xf302af9144e518322dfa2112f8a6173e1278826e9ae56a803ebd936303556a21) |
| **Circle attestation** (Iris, fast transfer, fee 260 units): attested ~5 s after the burn | [iris-api-sandbox …/v2/messages/3?transactionHash=0xf302…](https://iris-api-sandbox.circle.com/v2/messages/3?transactionHash=0xf302af9144e518322dfa2112f8a6173e1278826e9ae56a803ebd936303556a21) |
| **Arc mint + hook**: CRE `cctp-relay` (`cre workflow simulate --broadcast`) → forwarder → `NorenArcHook.onReport` → Circle `receiveMessage` mints 1.999740 USDC → `router.execute` → `AquaOrderOpened` | [0x36e93224…95ae](https://explorer.testnet.arc.io/tx/0x36e932240b6b3ad35fcad9e2a3772ea39ed41c2e3177bd6079c5bef7137895ae) |
| **Aqua fill**: CRE `xchain-aqua` reads `AquaOrderOpened` → ROUTER_ORDER report → `settler.onReport` → `router.settleAquaOrder` + SwapVM swap through the maker's strategy | [0xe6dab620…8dd7](https://explorer.testnet.arc.io/tx/0xe6dab62029db1e6924cb6ff6e229248e7bbb29d6863c2157fdb0a9dd01568dd7) |

Result: 1.999740 USDC that left Arbitrum Sepolia bought **1.777227 EURC**, delivered to the customer on Arc (`OrderFilled`, order `0xfab49392…2f0e`). The maker's wallet paid the EURC and received the USDC.

### 3. Second source chain: Ethereum Sepolia → Arc, same maker

| Hop | Tx |
|---|---|
| Approve TokenMessengerV2 (Ethereum Sepolia) | [0x078cfdb5…8c1a](https://sepolia.etherscan.io/tx/0x078cfdb5c60535e6bfc136b07d2207b2a5555429b266d15e4c733b7ecda28c1a) |
| **Source burn** with the AQUA_ORDER hook (1 USDC, fast) | [0xd551e5f5…e0e2](https://sepolia.etherscan.io/tx/0xd551e5f5ba4baf7fc04675d6a911f44c39644ce7b6440bd6690462ca31bfe0e2) |
| **Circle attestation** (~17 s) | [iris-api-sandbox …/v2/messages/0?transactionHash=0xd551…](https://iris-api-sandbox.circle.com/v2/messages/0?transactionHash=0xd551e5f5ba4baf7fc04675d6a911f44c39644ce7b6440bd6690462ca31bfe0e2) |
| **Arc mint + hook** (CRE relay): 0.999900 USDC → `AquaOrderOpened` | [0xc4d1c483…870d](https://explorer.testnet.arc.io/tx/0xc4d1c483154c875e08c76253fe04d2e39450e57a18496f077a8440882c4e870d) |
| **Aqua fill** (CRE ROUTER_ORDER) | [0x243cc90e…dd93](https://explorer.testnet.arc.io/tx/0x243cc90eed57c6273fc790d91e73ec5af25bd29a0c3d38c20c0bbd26f955dd93) |

Result: 0.999900 USDC from Ethereum Sepolia bought **0.888640 EURC** for the customer, from the same strategy and the same maker wallet.

**Totals.** The maker's single 5 EURC allocation filled orders from Arc, Arbitrum Sepolia and Ethereum Sepolia: 3.110231 EURC out, 3.499640 USDC in. The customer now holds 3.110231 EURC on Arc.

**Spend.** On Arc the deployer paid about 0.53 USDC in gas for its 15 transactions (deploys, configuration, maker setup and the four CRE writes) (12.864304 → 15.836176 USDC, which includes the 3.49964 USDC the maker received). The source chains spent 2 USDC on Arbitrum Sepolia (15 left) and 1 USDC on Ethereum Sepolia (19 left), plus a little ETH for gas. Base Sepolia's 0.1 USDC was not touched.

## Swap on Arc: Uniswap v4 first, the Aqua maker when it quotes better

Aqua is Noren's shared-liquidity layer, not its swap venue. The Noren app's Swap tab (USDC → EURC on Arc testnet, `packages/web/src/app/arc-swap.ts`) quotes both and routes to the better one, Uniswap v4 by default:

- **Uniswap v4 on Arc testnet.** Uniswap's deployment docs list Arc mainnet (5042) only. The Arc mainnet v4 addresses also have code on Arc testnet (checked with `cast code` on Nov 6): PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` (24,009 bytes), V4Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`, StateView `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b`, Universal Router 2.1.1 `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` (its `poolManager()` is the PoolManager above) and Permit2. Universal Router 2.1.2 and the v2/v3 contracts have no code there. A USDC/EURC pool exists at fee 500 / tick spacing 10 with no hooks; other fee tiers revert. We use these as found; they are not documented by Uniswap for the testnet.
- **The Aqua maker** is the live strategy above. Its quote is the router's own simulation, or the on-chain oracle formula when the taker has no allowance yet (labelled as such); a stale `NorenRateOracle` round shows "price stale" instead of a number.
- **Live, from the app with the browser's test key:** Uniswap v4, 0.05 USDC → 0.041964 EURC, [`0x599879f5…`](https://explorer.testnet.arc.io/tx/0x599879f5950f8eb59494cdd686e8fda57c9b9c0dd6aa697543206df4d9785b31) (the route chosen by hand; it quoted lower); the Aqua maker, 0.05 USDC → 0.044436 EURC, [`0x12df0a9c…`](https://explorer.testnet.arc.io/tx/0x12df0a9cafae3004c5625d83ce641457b7e9facdd8a065890c82503c15654440) (the default best route at the time).
- **Test:** `pnpm exec vitest run packages/web/src/app/arc-swap.live.test.ts` reads both live quotes (no transactions).

## Run it

```
pnpm install
bash scripts/live/aqua-build-official.sh                 # 1inch Aqua v1.0.0 from the pinned commit, compared with Arc mainnet
(cd packages/aqua/swapvm-ext && forge build)
(cd packages/xchain-aqua/contracts && forge build)
(cd packages/cctp/cre/cctp-relay && bun install) && (cd packages/xchain-aqua/cre/xchain-aqua && bun install)
pnpm exec tsx scripts/live/aqua-live.ts deploy           # Aqua, router, feeds, settler, route, transport, aquaOperator, verify
pnpm exec tsx scripts/live/aqua-live.ts maker            # approve, Aqua.ship, settler.register
pnpm exec tsx scripts/live/aqua-live.ts swap 0.5         # direct on-Arc swap by the customer
pnpm exec tsx scripts/live/aqua-live.ts xchain arbitrum-sepolia 2 <label>
pnpm exec tsx scripts/live/aqua-live.ts xchain ethereum-sepolia 1 <label>
pnpm exec tsx scripts/live/aqua-live.ts status           # addresses, strategy, balances
```

- **Keys.** `NOREN_DEPLOYER_KEY` is read from the main checkout's gitignored `.env.arc-deployer`, and the customer key from `.keys-live-arc.json`. Neither is printed. The CRE CLI gets the key only through a temporary 0600 env file that is deleted after the run. Its output is scrubbed before it is saved to `packages/xchain-aqua/live/*.log`.
- **Shared deployer.** Every batch of deployer transactions, on Arc and on the source chains, runs under `/private/tmp/noren-arc-deployer.lock` (stale after 10 min). viem sends with the pending nonce.
- **Resumable.** `live/arc-testnet.json` records each step: a deployed contract, a shipped strategy, a burn, an attestation, a mint and a fill are never repeated. A new `xchain` run needs a new label, which also gives the router order a new `ref`.
- **The CRE workflows** run as `cre workflow simulate --broadcast` (CRE CLI v1.39): `packages/cctp/cre` target `staging-settings` for the relay, and `packages/xchain-aqua/cre` target `arc-live-settings` ([config](../packages/xchain-aqua/cre/xchain-aqua/config.arc-live.json)) for the ROUTER_ORDER report.

## Tests

| Suite | Command | Result |
|---|---|---|
| Arc Testnet fork, fresh stack from `live/config.json` (port 8840) | `sh packages/xchain-aqua/scripts/test-aqua-live.sh` | **8 passed** |
| The same 8 tests against the **deployed** addresses (fork taken after the deployment) | `NOREN_AQUA_LIVE=true sh packages/xchain-aqua/scripts/test-aqua-live.sh` | **8 passed** |

The fork tests read the live NorenRateOracle, EURC and action router, and use the fork-only ForkUSDC shim, because stock Anvil can't execute Arc's native USDC. They cover:
- **Aqua is the official code.** Its runtime matches Arc mainnet's `0x1111113c…` except the 32-byte metadata hash. The test reads Arc mainnet itself.
- **Router and wiring.** The router is bound to this Aqua with NorenOraclePeg at opcode 34. The settler is the action router's `aquaOperator`.
- **Feeds.** The adapters mirror the live oracle's Chainlink rounds, including `updatedAt`.
- **Direct swap.** It fills at the oracle rate plus the ask.
- **CCTP order.** A CCTP-delivered AQUA_ORDER in the live router is filled through a CRE ROUTER_ORDER report.
- **Stale rate.** When the USDC/USD round is older than 25 h, the strategy refuses to quote (`NorenOraclePegStalePrice`).
- **Under-funded maker.** The fill is rejected, and the router order stays open for the beneficiary to cancel.
- **Min out.** A minimum out above the peg reverts.

The existing suites are unchanged: [AQUA.md](AQUA.md) (swapvm-ext 18, Robinhood 112) and [XCHAIN.md](XCHAIN.md) (fork suites 19 + 12, CRE bun 14).

## Limits, honestly

- **Rate freshness depends on the CRE pricing workflow.** NorenRateOracle only changes when the `packages/cre-pricing` workflow runs (`scripts/live/cre-live.ts`, simulated with `--broadcast`; it isn't deployed to the DON). At these fills the EUR/USD round was about 11 h old and the USDC/USD round about 21 h old. Chainlink's own heartbeat had not produced newer rounds on Arc mainnet yet. Once the USDC/USD round passes 25 h (90,000 s, the same bound as `NorenRateOracle.maxAge`), the strategy **stops quoting until the next CRE pricing write.** That is fail-closed by design. Run the pricing workflow again before a demo.
- **CRE runs in simulation.** `cre workflow simulate --broadcast` signs with the simulator and delivers through Arc's **Mock**KeystoneForwarder, which checks no DON signatures. The settler accepts reports from that forwarder, so it is for simulation only. A DON deployment would point `setForwarder` at the production KeystoneForwarder and pin the workflow with `setExpectedWorkflowOwner`.
- **One maker, and the maker is the deployer.** The 5 EURC came from Circle's faucet. The maker's EURC is real testnet EURC, but the liquidity is tiny. The Rescuable owner of our Aqua copy is also the deployer.
- **The Robinhood leg is still fork-only.** Robinhood Testnet has no Chainlink stock feeds, so the NVDA Stock Token → Arc USDC route stays on forks ([XCHAIN.md](XCHAIN.md)). The live cross-chain flow here is USDC carried by CCTP V2, so no escrow or receipt token is involved.
- **Older open order.** An earlier CCTP AQUA_ORDER test (`ref` "noren-cctp", 0.99987 USDC, opaque test params, [CCTP.md](CCTP.md)) is still open in the router. Its params aren't an `AquaOrderParams`, so the settler can't fill it. Its beneficiary, the deployer, can `cancelAquaOrder`.
