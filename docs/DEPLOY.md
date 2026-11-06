# Deploying Noren publicly

How to put the whole Arc-side Noren stack on the **public Arc testnet** (chain 5042002, no forks), with its CCIP endpoints on Base Sepolia, Ethereum Sepolia and Robinhood testnet. Also covers how the CRE, CCIP and CCTP pieces connect, which contracts are mocks, and the explorer-verified source of every Noren contract that is live today.

The Robinhood-side credit contracts (NorenCredit, NorenBorrow, the deposit vaults) are **not** deployed publicly: Robinhood testnet has no Chainlink feeds, and Robinhood mainnet means real money. They run on a local Anvil fork of Robinhood mainnet (`packages/robinhood/scripts/deploy-fork.sh`), with real tokens and feeds.

## One command

```sh
# 1. Fill a gitignored env file (names in .env.example). The deployer needs Arc testnet USDC for gas
#    (https://faucet.circle.com) and testnet ETH on Base Sepolia, Sepolia and Robinhood testnet for CCIP.
cp .env.example .env.arc-deployer        # then set NOREN_DEPLOYER_KEY in it; never commit it

# 2. Plan and preflight (sends nothing):
NOREN_CRE_MODE=simulate bash scripts/deploy-public.sh

# 3. Deploy (real testnet transactions; every step is resumable):
NOREN_CRE_MODE=simulate bash scripts/deploy-public.sh --execute
NOREN_CRE_MODE=simulate bash scripts/deploy-public.sh --execute 7   # resume from step 7
```

`scripts/deploy-public.sh` runs these checks before anything is sent. It refuses to continue when one fails:
- the RPC is the public Arc testnet (chain 5042002), not a loopback URL or an Anvil node;
- `NOREN_DEPLOYER_KEY` exists in the env file (checked by name, never printed);
- the CRE forwarder policy holds (next section);
- no step deploys a contract marked `DEV_ONLY` (`ForkUSDC`, `NorenCreditHarness`) or uses Anvil-only RPCs outside a fork guard.

Then it runs the existing scripts in this order:

| # | What | Script |
|---|---|---|
| 1 | Kohaku privacy pool (PoseidonT3/T4, Groth16 verifiers, Entrypoint behind ERC1967Proxy, USDC PrivacyPoolComplex, `registerPool`) and **NorenCheckout**. Runs a fork dry run first and refuses unless the live balance covers the measured cost × 1.5 | `pnpm exec tsx scripts/deploy-arc.ts` |
| 2 | **NorenCcipGateway** + **NorenArcActionRouter** on Arc | `packages/ccip/scripts/live.sh script/Deploy.s.sol:Deploy arc_testnet` (`ROLE=arc`) |
| 3 | **NorenCcipHub** on Base Sepolia | same, `ROLE=hub`, `base_sepolia` |
| 4 | **NorenCcipGateway** + **NorenCcipInbox** on Robinhood testnet | same, `ROLE=gateway-inbox`, `robinhood_testnet` |
| 5 | **NorenCcipGateway** on Ethereum Sepolia | same, `ROLE=gateway`, `ethereum_sepolia` |
| 6 | CCIP lanes, hub routes, credit authority | `packages/ccip/script/Configure.s.sol` per `ROLE` ([CCIP.md](CCIP.md)) |
| 7 | **NorenRateOracle** and **NorenCreditLine**, then the first `cre workflow simulate --broadcast` writes | `pnpm exec tsx scripts/live/cre-live.ts` |
| 8 | **NorenArcHook** (CCTP V2): `setRouter(actionRouter)`, `router.setRail(hook, keccak256("CCTP"))` | `bash packages/cctp/scripts/deploy-arc-hook.sh` |
| 9 | **NorenShieldSink** + the SHIELD-aware NorenArcHook ("arrive private") | `pnpm exec tsx scripts/live/private-deploy.ts` |
| 10 | 1inch **Aqua v1.0.0** (unmodified), **NorenAquaSwapVMRouter**, two **NorenRateOracleFeed** legs, **NorenCrossChainSettler**, its route and `setAquaOperator` | `scripts/live/aqua-build-official.sh`, then `pnpm exec tsx scripts/live/aqua-live.ts deploy` |
| 11 | **NorenCreditLine** with `drawToPool` ("pay later, privately") | `pnpm exec tsx scripts/live/private-credit-live.ts` |

Each script records what it deployed:
- `deployments/5042002.json`
- `packages/ccip/deployments.json`
- `packages/cctp/deployments.json`
- `packages/xchain-aqua/live/arc-testnet.json`
- `scripts/live/private-deployments.json`
- `scripts/live/private-credit-runs.json`

Every deployer transaction takes the shared nonce lock `/private/tmp/noren-arc-deployer.lock`.

## Environment

All names are in [`.env.example`](../.env.example). The deploy needs only these:

| Variable | Used by |
|---|---|
| `NOREN_DEPLOYER_KEY` | Every step: owner and deployer on all four testnets. It lives in a gitignored env file and is passed to the CRE CLI only through a temporary 0600 file |
| `NOREN_ENV_FILE` | Path of that env file (default `.env.arc-deployer` in the repo or the main checkout) |
| `NOREN_CRE_MODE` | `simulate` or `production` (below) |
| `CRE_FORWARDER`, `CRE_WORKFLOW_OWNER` | Production CRE only |
| `NOREN_RPC_URL` | Arc testnet RPC (default `https://rpc.testnet.arc.io`) |
| `NOREN_POSTMAN_ADDRESS` | ASP postman for the Kohaku pool (default: the deployer) |
| `ROLE`, `CCIP_ROUTER`, `CCIP_SELECTOR`, `ARC_LIQUIDITY_USDC6` | Set by `deploy-public.sh` for each CCIP step |

## CRE forwarder

Every Noren CRE receiver accepts `onReport` only from its configured forwarder:
- NorenRateOracle
- NorenCreditLine
- NorenArcHook
- NorenCrossChainSettler / Escrow
- NorenSettlementDesk
- NorenCredit

There are two modes.

- **`NOREN_CRE_MODE=simulate`.** This is what is live today. CRE runs as `cre workflow simulate --broadcast` (CRE CLI, org "My Org"). The simulator signs reports locally and delivers them through Chainlink's official **MockKeystoneForwarder**, the CRE simulation forwarder. Noren did not write it.
  - Arc testnet: `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`
  - Base Sepolia: `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5`
  - Robinhood testnet: `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885`

  The mock checks no DON signatures, so on testnet anyone can push a report through it (SECURITY.md ARC-2). This is acceptable for a testnet demo only.
- **`NOREN_CRE_MODE=production`.** This mode needs DON access, which Noren does not have yet. `deploy-public.sh`:
  - refuses every known MockKeystoneForwarder;
  - requires `CRE_FORWARDER` to be a contract with code (the real **KeystoneForwarder**; the addresses are in [CHAINLINK.md](CHAINLINK.md));
  - requires `CRE_WORKFLOW_OWNER`;
  - after the deploy, calls `setForwarder` and `setExpectedWorkflowOwner` on every receiver, and `setForwarder` on the hooks.

  The workflows then run with `cre workflow deploy` instead of `simulate`.

## How the cross-chain pieces connect

- **CRE pricing.** `packages/cre-pricing` reads Chainlink Data Feeds on Arc mainnet (read-only). It writes FX rates to NorenRateOracle on Arc testnet through the forwarder.
- **CRE credit bridge.** `packages/cre-bridge` works in two directions:
  - `CreditLineOpened` (NorenCredit, Robinhood) becomes a `NorenCreditLine.onReport` kind 1 on Arc.
  - `Drawn` / `Repaid` (Arc) become `NorenCredit.onReport` on Robinhood.
  - The World ID starter line is a kind-2 report from an HTTP trigger.
- **CCTP V2.**
  - A burn on a source chain (Arbitrum Sepolia, Base Sepolia, Ethereum Sepolia, Robinhood testnet) names NorenArcHook as `destinationCaller` and `mintRecipient`.
  - The `cctp-relay` workflow fetches Circle's attestation (Iris) and calls `NorenArcHook.onReport`. The hook calls `MessageTransmitterV2.receiveMessage` and hands the hook data to NorenArcActionRouter as an action: pay invoice, pay on credit, credit line, Aqua order, or shield.
  - Since ARC-1, the hook also requires the message to be addressed to TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`.
- **CCIP.** NorenCcipGateway sends Noren actions with optional tokens. Robinhood testnet and Sepolia reach Arc through the Base Sepolia hub. NorenCcipInbox receives the reverse direction on Robinhood. Lanes are allowlisted per source chain selector and sender ([CCIP.md](CCIP.md)).

## Mocks and dev-only code

Every mock, fake, stub, shim and harness in non-test code, and what was done with it:

| Item | Where it is used | Status |
|---|---|---|
| Chainlink **MockKeystoneForwarder** | Forwarder of every CRE receiver on public testnets; CRE runs as `simulate --broadcast` | Chainlink's official simulation forwarder, not a Noren mock. Documented above. `deploy-public.sh` takes it only with `NOREN_CRE_MODE=simulate` and refuses it in production mode |
| `ForkUSDC` (`packages/contracts/src`) | Installed at Arc's USDC address with `anvil_setCode`, only on Anvil forks (`scripts/stack.ts`, `scripts/dev-stack.ts`, `xchain-aqua/scripts/forks.sh`, `cre-bridge/scripts/fork-simulate.sh`, `private-credit-live.ts --fork`). Anvil cannot run Arc's precompile-backed USDC | Never deployed. Now marked `DEV_ONLY`; `deploy-public.sh` refuses any step that would deploy it |
| `NorenCreditHarness` (`packages/arc-credit/src/harness`) | Only `cre-bridge/scripts/fork-simulate.sh` with `NOREN_BRIDGE_RECEIVER=harness`, on a local fork | Never deployed publicly. Marked `DEV_ONLY` and refused the same way |
| Robinhood fork faucet (`packages/server/src/credit.ts`) and Arc `/dev/faucet` (`packages/server`) | Moves real tokens from real holders by impersonation on the local fork | Guarded: refuses unless the RPC is loopback **and** `anvil_nodeInfo` shows a fork of the expected chain |
| `anvil_setCode` copies of the official Aqua and SwapVM router bytecode, and of Uniswap v4 helper code (`xchain-aqua/scripts/forks.sh`, `server/src/credit.ts`) | Forks only. 1inch's CREATE3 factories are not on Arc testnet, so their contracts can't exist at the official addresses there | Fork-only, labelled. On public Arc testnet, Aqua v1.0.0 is a real unmodified redeploy at its own address (step 10) |
| Anvil's published dev keys | `deploy-fork.sh`, the server's `ANVIL_DEV_KEY_9` | Local forks only; never used against a public RPC |
| World ID "fake proof" in `packages/world-id/scripts/live-check.ts` | A negative check that the real World ID verifier *rejects* a forged proof | Not a mock; kept |

No contract in a deploy or production path is a mock. Test-only mocks live under `test/` and `fork-test/`.

## Verified source

Every Noren contract on a public testnet, verified on Blockscout. The source is the commit each address was deployed from, with the exact compiler settings of that build:
- solc 0.8.28, `bytecode_hash = none`, no CBOR metadata;
- optimizer runs 10,000 for contracts, arc-credit and cctp;
- runs 2,000 plus via-IR for ccip;
- runs 200 plus via-IR for xchain-aqua;
- the SwapVM router: solc 0.8.30, via-IR, runs 200 (the Arc build, commit a044e6a).

Fixes made on `audit` to live contracts (SECURITY.md) are not in these bytecodes. They need a redeploy.

| Chain | Contract | Address | Source | Status |
|---|---|---|---|---|
| Arc testnet | NorenCheckout | [`0xe18a…7547`](https://explorer.testnet.arc.io/address/0xe18a80506fdb7f5498aad7387a21134118a77547) | `c885938` (unchanged through 1965bbf) | Verified |
| Arc testnet | NorenRateOracle | [`0xdb82…831c`](https://explorer.testnet.arc.io/address/0xdb828bdcf33ef0a5a32861e4831ff3dd87be831c) | 1965bbf | Verified |
| Arc testnet | NorenCreditLine (starter line) | [`0x7140…8876`](https://explorer.testnet.arc.io/address/0x7140aad0bb38dc6908a857b446897c78b0d88876) | `113e45e` | Verified |
| Arc testnet | NorenCreditLine (with drawToPool) | [`0x4e26…1f86`](https://explorer.testnet.arc.io/address/0x4e26d0bfc5ac22b3fe8579afe50cb9584b2a1f86) | `a959cd6` | Verified |
| Arc testnet | NorenArcHook v1 (superseded) | [`0xc034…cb45`](https://explorer.testnet.arc.io/address/0xc0347F3f66C0867F385679a8E0ceF3DB4A3bcb45) | `9a367c3` | Verified |
| Arc testnet | NorenArcHook v2 | [`0x8845…B20d`](https://explorer.testnet.arc.io/address/0x8845ae4B87D706c31606182D5A9529b67ee6B20d) | `b5c419b` | Verified |
| Arc testnet | NorenArcHook (SHIELD-aware) | [`0x30C8…a3F4`](https://explorer.testnet.arc.io/address/0x30C84a5aAD4f4bDd25a27e33F563EfBC2CFaa3F4) | `d731da8` | Verified |
| Arc testnet | NorenCcipGateway | [`0x5500…6247`](https://explorer.testnet.arc.io/address/0x55005e60b4d4Bed4156BC635B1342bC55d9B6247) | `174aa8a` | Verified |
| Arc testnet | NorenArcActionRouter | [`0x3D2d…A7A4`](https://explorer.testnet.arc.io/address/0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4) | `174aa8a` | Verified |
| Arc testnet | NorenShieldSink | [`0x7799…Ca2D`](https://explorer.testnet.arc.io/address/0x7799bCDaE59500556B96B176c69E50FD5053Ca2D) | 1965bbf | Verified |
| Arc testnet | NorenRateOracleFeed (EUR/USD leg) | [`0x8f3a…85af`](https://explorer.testnet.arc.io/address/0x8f3a10ac41d1ac5779c8889b7a88384eda2a85af) | 1965bbf | Verified |
| Arc testnet | NorenRateOracleFeed (USDC/USD leg) | [`0xe9b8…8fa2`](https://explorer.testnet.arc.io/address/0xe9b8f18072ccc13e7143503f9c95ba8940dd8fa2) | 1965bbf | Verified |
| Arc testnet | NorenCrossChainSettler | [`0xd9f9…d016`](https://explorer.testnet.arc.io/address/0xd9f90e397770faf66b228344af5fe285b349d016) | `95fa130` | Verified |
| Arc testnet | NorenAquaSwapVMRouter (SwapVM v1.0.2 + NorenOraclePeg) | [`0x8717…e295`](https://explorer.testnet.arc.io/address/0x8717687866f988EEBe3bd1d8999DF820ffD9e295) | `a044e6a`, solc 0.8.30, via-IR, runs 200, custom Yul steps | **Not verified (explorer)**: the source is proven to match. The `a044e6a` build equals the on-chain code byte for byte once its 4 immutables and 53-byte CBOR metadata are masked (23,843 B). Arc's Blockscout accepted the submission twice but never returned a match for this via-IR build with custom Yul optimizer steps, and its Etherscan-style API rate-limited forge. Reproduce: build `packages/aqua/swapvm-ext` at `a044e6a`, then compare `deployedBytecode` with `cast code` |
| Robinhood testnet | NorenCcipGateway | [`0x1941…8197`](https://explorer.testnet.chain.robinhood.com/address/0x194155904568E29627A8E451BE61d3B7be918197) | `174aa8a` | Verified |
| Robinhood testnet | NorenCcipInbox | [`0x1019…50bf`](https://explorer.testnet.chain.robinhood.com/address/0x101951a6b269247591673F4EeFccCA63D72450bf) | `174aa8a` | Verified |
| Base Sepolia | NorenCcipHub | [`0xe57A…2Ba3`](https://base-sepolia.blockscout.com/address/0xe57A438a8dEd2aD7D1A12Ddf497a0Da0bD2d2Ba3) | `174aa8a` | Verified |
| Base Sepolia | NorenCcipGateway | [`0x8116…95F1`](https://base-sepolia.blockscout.com/address/0x8116700710aD49B5C19425f458E9CB5120A495F1) | `174aa8a` | Verified |
| Ethereum Sepolia | NorenCcipGateway | [`0x0153…b4cf`](https://eth-sepolia.blockscout.com/address/0x015306AC6f866bf9b2DD157a79D65159697fb4cf) | `174aa8a` | Verified |

Vendored contracts on Arc testnet, also verified on Blockscout:
- Kohaku: [PoseidonT3](https://explorer.testnet.arc.io/address/0x194155904568e29627a8e451be61d3b7be918197), [PoseidonT4](https://explorer.testnet.arc.io/address/0x101951a6b269247591673f4eefccca63d72450bf), [WithdrawalVerifier](https://explorer.testnet.arc.io/address/0x015306ac6f866bf9b2dd157a79d65159697fb4cf), [CommitmentVerifier](https://explorer.testnet.arc.io/address/0xe57a438a8ded2ad7d1a12ddf497a0da0bd2d2ba3), [Entrypoint implementation](https://explorer.testnet.arc.io/address/0x8116700710ad49b5c19425f458e9cb5120a495f1), the [Entrypoint ERC1967Proxy](https://explorer.testnet.arc.io/address/0xa22f3200ecb4319b48dca49677c2f73cd7260ad5), and the [USDC PrivacyPoolComplex](https://explorer.testnet.arc.io/address/0x393d8d46e1dff8a719820e36d70ba509896ea57d) (linked against the two Poseidon libraries).
- 1inch: [AquaRouter v1.0.0](https://explorer.testnet.arc.io/address/0x550CD499f1E2da71527f14d6469364461966895B).

Blockscout labels these "partially verified": the builds carry no CBOR metadata hash (`bytecode_hash = none`), so only the code itself can match. The SwapVM router build does carry one.

How to reproduce:
- Check out the source commit and run `pnpm install`.
- Run `forge verify-contract <address> <path:Name> --show-standard-json-input` in the package.
- Upload the result with `scripts/deploy-verify-blockscout.py` (Blockscout v2 API; constructor arguments are autodetected).
- `forge verify-contract --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ --guess-constructor-args` also works, but Arc's Blockscout rate-limits it.


## Hosting the web app (not deployed)

The Noren app and Noren Merchant are one Vite build (`packages/web`). The merchant server (`packages/server`) is a long-running Node process. It needs the merchant key and a persistent data file, so it is hosted separately (Railway, Fly or a VM), not as Vercel functions.

The Vercel CLI on this Mac is logged in as Nick. **Do not run these until Nick says so** (publishing needs his OK):

```sh
cd packages/web
vercel link                          # pick or create the "noren" project under Nick's account
vercel env add VITE_NOREN_SERVER     # public URL of the hosted merchant server
vercel env add VITE_PRIVY_APP_ID     # optional: Privy sign-in
# Build settings: root packages/web, install `pnpm install --frozen-lockfile` at the repo root,
# build `pnpm --filter @noren/web build`, output `packages/web/dist`.
vercel build && vercel deploy --prebuilt            # preview URL
vercel deploy --prebuilt --prod                     # production, only after Nick approves
```

`VITE_*` values are compiled into the public bundle, so only public values (URLs, the Privy app ID) go there, never a key.

## Hosted (public demo, Nov 7 2026)

| Surface | URL | Notes |
|---|---|---|
| Noren Merchant + hosted checkout | https://noren-merchant.vercel.app | `#/dashboard`, `#/pay/<invoiceId>` |
| Noren app + landing | https://noren-app-beta.vercel.app | `#/app` (`noren-app.vercel.app` belongs to someone else) |
| Aubelle demo shop | https://noren-shop.vercel.app | `/api/*` is proxied by Vercel to the shop backend |
| Merchant API (server, relayer, `/private/*`, Reclaim) | https://noren-api.201-18-198-162.sslip.io | `GET /config` |
| ASP postman tree | https://noren-asp.201-18-198-162.sslip.io/asp/tree | posts roots with a hot key granted `ASP_POSTMAN` |
| Arc testnet RPC proxy | https://noren-arc-rpc.201-18-198-162.sslip.io | spreads calls over Arc's public providers, chunks `eth_getLogs` |
| Robinhood Chain · mainnet snapshot RPC | https://noren-rh-rpc.201-18-198-162.sslip.io | Anvil with no upstream, read + `eth_sendRawTransaction` only |
| Aubelle backend | https://noren-shop-api.201-18-198-162.sslip.io | |

Arc is the **public Arc testnet** (5042002), never a fork. The Robinhood side is the warmed mainnet snapshot
(`packages/robinhood/scripts/fork-snapshot.sh`, then `deploy/vps/noren-rh/prepare-snapshot.ts`).

- Frontends: built on the Mac with `VITE_NOREN_HOSTED=1 VITE_NOREN_API=https://noren-api.201-18-198-162.sslip.io VITE_NOREN_RH_RPC=https://noren-rh-rpc.201-18-198-162.sslip.io pnpm --filter @noren/web build` (plus `packages/web/public/zk` prover artifacts), and only `dist/` is uploaded (`vercel deploy --prod --project <name>`).
- Backends: `deploy/vps/` (compose files, Dockerfiles, `noren-api/sync.sh`). `/opt/hk/noren-api` runs `api`, `postman`, `shop`, `arc-rpc`; `/opt/hk/noren-rh` runs `anvil` + the read-only `rpc` proxy.
- Keys: fresh hot testnet keys generated **on the VPS** (`.env`, `.env.postman`, `.env.shop`, mode 600), never on the Mac or in git. Env names: `NOREN_MERCHANT_KEY`, `NOREN_STORE_FUNDER_KEY`, `NOREN_RELAYER_KEY`, `NOREN_MERCHANT_TOKEN`, `NOREN_POSTMAN_KEY`, `NOREN_MERCHANT` / `NOREN_SECRET_KEY` (shop), `PRIVY_APP_ID`, `RECLAIM_APP_ID`, `RECLAIM_APP_SECRET`, `RECLAIM_PROVIDER_IDS`. Funded from the deployer: merchant/store funder 1.5 USDC, relayer 0.5, postman 0.5. Each new store gets 0.05 USDC of Arc gas (max 2 per wallet, 25 total).
- Customers fund the hosted checkout from https://faucet.circle.com (Arc Testnet); the pool's minimum deposit is 1 USDC. There is no hosted Arc faucet.
- First end-to-end on the hosted stack: store "Noren Live Check" created in the dashboard, 0.25 USDC link, 1.00 USDC shielded from the checkout, approved by the hosted postman, paid privately: [`0x38b8ce96…b0f5`](https://explorer.testnet.arc.io/tx/0x38b8ce96c9ad3a2957467def0194eeba8e2cf0d2d26f5aae9df7b7b8fa12b0f5).
