# Bridge routes: Robinhood Chain and Arc

Date: 2026-11-06 (checks run about 04:00-04:25 UTC).

## Method

- Robinhood Chain mainnet: `https://rpc.mainnet.chain.robinhood.com`. `cast chain-id` returned 4663. Block at check time: 107290625.
- Arc mainnet: `https://arc-rpc.publicnode.com`. `cast chain-id` returned 5042. Block at check time: 29779066.
- Ethereum mainnet (for two-hop routes): `https://ethereum-rpc.publicnode.com`. Chain id 1. Block 26353406.
- Testnets (CCTP and CRE only): `https://rpc.testnet.chain.robinhood.com` (46630) and `https://rpc.testnet.arc.network` (5042002).
- Only read calls were made: `cast code`, `cast call`, `cast storage`, `cast chain-id`. No transaction was sent. No key or wallet was used.
- Bridge APIs were queried read-only. Quotes used the burn address `0x000000000000000000000000000000000000dEaD` as a placeholder user.
- "Code size" means `(len(cast code ADDR) - 2) / 2` bytes. 0 means no contract.
- Tags:
  - **VERIFIED on-chain**: the cast result is given.
  - **VERIFIED in docs**: the URL is given. API responses count as docs here and are labelled "API".
  - **UNVERIFIED**: not checked, or only third-party sources.

## Summary

A direct route exists today, but only through intent bridges. Relay, Across and deBridge all move USDG on Robinhood to USDC on Arc and back. They settle in one to two seconds. None of them is a canonical or issuer bridge.

The issuer and messaging routes are not wired between these two chains yet:

- Circle CCTP V2 is deployed on Robinhood mainnet as domain 35. It is switched off: the burn limit is 0, the minter allowance is 0, Arc does not list domain 35, and Circle's attestation API rejects it.
- Chainlink CCIP has routers on both chains, but there is no lane between them.
- LayerZero v2 has endpoints on both chains. The default config uses the dead DVN, so an app must set its own DVNs. One token (Anon) has done this and delivered one message.

On testnets, CCTP V2 is live in both directions between Robinhood testnet (domain 35) and Arc testnet (domain 26).

## Ranked routes

Fees and times come from docs when the docs state them. Values from API quotes are labelled "API quote" and were taken at check time for 100 units.

| Rank | Route | Assets | Robinhood contract | Arc contract | Live evidence | Fees / time | Risks |
|---|---|---|---|---|---|---|---|
| 1 | Relay (intent bridge) | USDG, ETH on Robinhood to USDC on Arc, and back | Depository `0x4cd00e387622c35bddb9b4c962c136462338bc31` (8628 B) | same address (8628 B) | Chains API lists both. Quotes both ways. | Docs: "seconds". API quote: 100 USDG to 99.939 USDC, 100 USDC to 99.889 USDG, about 1 s. | Relayer and solver trust. Liquidity limits. Off-chain quote service. |
| 2 | Across (intent bridge) | USDG on Robinhood to USDC on Arc, and back | SpokePool `0xD29C85F15DF544bA632C9E25829fd29d767d7978` (225 B proxy) | SpokePool `0x9b4A302A548c7e313c2b74C461db7b84d3074A84` (225 B proxy) | `available-routes` lists both directions. `numberOfDeposits` 556152 (Robinhood) and 27618 (Arc). | Docs: "seconds". API quote: 0.064% fee Robinhood to Arc, 0.069% back, 1-2 s. Instant limit 24,666 USDG Robinhood to Arc. | Relayer trust until settlement through the Ethereum HubPool. Deposit limits. |
| 3 | deBridge DLN (intent bridge) | USDG and other tokens on Robinhood to USDC on Arc, and back | DlnSource `0xeF4fB24aD0916217251F553c0596F8Edc630EB66` (1159 B), DlnDestination `0xE7351Fd770A37282b91D153Ee690B63579D6dd7f` (1159 B) | same addresses (1159 B each) | Supported-chains API lists 4663 and 5042. Quotes both ways. | Not stated in docs. API quote: 100 USDG to 99.870 USDC plus 0.001 ETH fixed fee; 100 USDC to 99.830 USDG plus 1 USDC fixed fee. About 1 s. | Taker (solver) trust. Fixed fee hurts small amounts. |
| 4 | USDG LayerZero OFT to Ethereum, swap USDG to USDC, CCTP V2 Ethereum to Arc | USDG to USDC | USDG OFT wrapper `0x0d54755f5106BfdB43f7a35f5D49a23F940628d1` (708 B) | Arc USDC `0x3600000000000000000000000000000000000000`; CCTP TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | OFT peers set both ways with Ethereum. Ethereum CCTP knows Arc (domain 26). Circle fee API returns a fee for 0 to 26. | OFT: "minutes" (Robinhood docs). CCTP Standard from Ethereum: about 65 blocks, 15-19 min; Fast: about 20 s (Circle docs). | Three steps and three fees. Swap venue on Ethereum not checked. |
| 5 | Arbitrum canonical bridge to Ethereum, then CCTP V2 Ethereum to Arc | ETH, WETH, canonically bridged ERC-20s (including bridged USDC `0x80e0…6cA8`) | L2 Gateway Router `0x1E324B9316138CA9a73F960213621AD1aaf01B89` (2202 B) | via Ethereum CCTP | Rollup on Ethereum reports chainId 4663. `confirmPeriodBlocks` 45818. | Deposit about 10 min; withdrawal 7-day challenge period plus an L1 claim (Robinhood docs). | 7-day exit. USDG does not use this bridge. |
| 6 | LayerZero v2 direct messaging | Messages; tokens only if an OApp sets its own DVNs | EndpointV2 `0x6F475642a6e85809B1c36Fa62763669b1b48DD5B` (24005 B), eid 30416 | same address (24005 B), eid 30417 | Default ULN config is the dead DVN in both directions. Anon OFT has a custom config and one delivered message. | "Minutes" (Robinhood docs). | No stablecoin OFT exists on both chains. Each app must set and secure its own DVNs. |
| 7 | Wormhole core messaging | Messages only | Core `0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB` (680 B), chain 72 | Core `0xC8aD24fC6063c41cB5C12a8e3851AafC3b3CF027` (680 B), chain 71 | Guardian set index 7 on both, same as Ethereum. | Not stated. | No Token Bridge listed. Needs a custom receiver and VAA delivery. |
| 8 | Hyperlane messaging | Messages only | Mailbox `0x3a867fCfFeC2B790970eeBDC9023E75B0a172aa7` (2840 B), domain 4663 | Mailbox `0x7f50C5776722630a0024fAE05fDe8b47571D7B39` (2840 B), domain 5042 | Both mailboxes have sent messages (nonce 3236 and 1215). No warp route names either chain. | Not stated. | Default ISM coverage for this pair not confirmed. No token route. |

## Per-route evidence

### 1. Relay

- **VERIFIED in docs (API)**: `https://api.relay.link/chains` lists id 4663 "Robinhood Chain" and id 5042 "Arc". Both have `disabled: false` and `depositEnabled: true`. Robinhood's bridgeable ERC-20 is USDG `0x5fc5…d168`. Arc lists USDC `0x3600…0000` and cirBTC.
- **VERIFIED on-chain**: the Relay contracts are at the same addresses on both chains.
  - Depository `0x4cd00e387622c35bddb9b4c962c136462338bc31`: 8628 B on Robinhood, 8628 B on Arc.
  - ERC20Router `0x0729e2a4716d9f7dd17858d5d504426d228697f7`: 7185 B on both.
  - ApprovalProxy `0x5567954cd026cebfe486062cb75848e0f1c12e58`: 13884 B on both.
- **VERIFIED in docs (API)**: `POST https://api.relay.link/quote` returned:
  - 100 USDG (Robinhood) to 99.939298 USDC (Arc). Relayer fee $0.051, time estimate 1 s.
  - 100 USDC (Arc) to 99.889346 USDG (Robinhood). Relayer fee $0.084, 1 s.
  - 0.05 ETH (Robinhood) to 111.211152 USDC (Arc), 1 s.
  - 50,000 USDG to 49,979.87 USDC, 1 s.
  - TSLA Stock Token: `UNSUPPORTED_CURRENCY`.
- **VERIFIED in docs**: Robinhood lists Relay as a partner bridge that settles in "seconds". https://docs.robinhood.com/chain/bridging/

### 2. Across

- **VERIFIED in docs**: https://docs.across.to/chains-and-contracts gives SpokePool `0xD29C85F15DF544bA632C9E25829fd29d767d7978` for Robinhood (4663) and `0x9b4A302A548c7e313c2b74C461db7b84d3074A84` for Arc (5042).
- **VERIFIED on-chain**:
  - Robinhood SpokePool: 225 B proxy. `chainId()` = 4663. `wrappedNativeToken()` = `0x0Bd7…AD73` (WETH). `numberOfDeposits()` = 556152.
  - Arc SpokePool: 225 B proxy. `chainId()` = 5042. `numberOfDeposits()` = 27618. `withdrawalRecipient()` = `0xc186fA914353c44b2E33eBE05f21846F1048bEda`.
  - The Arc SpokePool address also has 4888 B of unrelated code on Robinhood. Do not use it there.
- **VERIFIED in docs (API)**: `https://app.across.to/api/available-routes` lists:
  - 4663 USDG to 5042 USDC.
  - 5042 USDC to 4663 USDG.
  - Robinhood WETH and USDG also route to Ethereum.
- **VERIFIED in docs (API)**: `suggested-fees` for 100 units:
  - Robinhood to Arc: fee 0.0642 USDG (0.064%), fill time 1 s, `maxDepositInstant` 24,666.81 USDG, `maxDeposit` 670,294 USDG, `minDeposit` 0.50 USDG.
  - Arc to Robinhood: fee 0.0692 USDC (0.069%), fill time 2 s.
- **UNVERIFIED**: that the Uniswap app's cross-chain swaps for this pair route through Across. The Uniswap Trading API needs a key; the anonymous call to `swappable_tokens` returned `Unauthorized`.

### 3. deBridge DLN

- **VERIFIED in docs (API)**: `https://dln.debridge.finance/v1.0/supported-chains-info` lists `(4663, "Robinhood")` and `(5042, "Arc")`.
- **VERIFIED on-chain**: DlnSource `0xeF4f…EB66` is 1159 B and DlnDestination `0xE735…dd7f` is 1159 B, on both chains.
- **VERIFIED in docs (API)**: `/v1.0/dln/order/quote` returned:
  - 100 USDG to 99.870038 USDC. `fixFee` 1e15 wei (0.001 ETH). Fulfilment delay 1 s.
  - 100 USDC (Arc) to 99.830054 USDG. `fixFee` 1e18 (1 USDC in Arc's 18-decimal native unit).
  - 1 TSLA (Robinhood) to 345.40 USDC on Arc. The quote is a pre-swap from TSLA to USDG on Robinhood, then a bridge. The Stock Token stays on Robinhood Chain.

### 4. USDG OFT to Ethereum, then CCTP to Arc

- **VERIFIED in docs**: Paxos lists Robinhood USDG token `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, OFT `0x0d54755f5106BfdB43f7a35f5D49a23F940628d1` and supply control `0xdf5FfF9cb88B3cAb50572FAE73E2EB08599D25D4`. Arc is not listed. https://docs.paxos.com/guides/stablecoin/usdg/mainnet
- **VERIFIED on-chain** (Robinhood):
  - The USDG token is a 170 B proxy. Its implementation `0x6818…6f8f` (18644 B) has no OFT functions: `endpoint()` and `peers()` revert.
  - OFT wrapper `0x0d54…28d1` is 708 B. `endpoint()` = `0x6F47…DD5B`. `token()` = USDG. `oftVersion()` = `0x02e49c2c`, 1. `approvalRequired()` = false.
  - `peers(30101)` (Ethereum) = `0x147BdE4F997f0d4C7544ED0C55eAcf1E5E6bf9c4`.
  - `peers(30417)` (Arc) = 0. `peers(30110)` (Arbitrum) = 0.
- **VERIFIED on-chain** (Ethereum):
  - `0x147B…f9c4.peers(30416)` = the Robinhood OFT `0x0d54…28d1`.
  - `token()` = Ethereum USDG `0xe343167631d89B6Ffc58B88d6b7fB0228795491D`.
- **VERIFIED on-chain** (Ethereum CCTP V2):
  - `TokenMessengerV2.remoteTokenMessengers(26)` = `0x28b5…cf5d`, so Ethereum accepts Arc.
  - `burnLimitsPerMessage(USDC)` = 1e13 (10M USDC).
- **VERIFIED in docs (API)**: `https://iris-api.circle.com/v2/burn/USDC/fees/0/26` returned a 0.25 bps minimum fee for Fast (threshold 1000) and 0 for Standard (threshold 2000). `fees/26/0` returned 0 and 0.
- **VERIFIED in docs**: Circle gives Standard Transfer from Ethereum as about 65 blocks and 15-19 minutes, Fast as about 20 seconds, and Arc as source as 1 block and about 0.5 seconds. https://developers.circle.com/cctp/required-block-confirmations
- **UNVERIFIED**: the USDG to USDC swap step on Ethereum (venue, depth, price). Across already offers Robinhood USDG to Ethereum USDC in one step (API, see section 2).

### 5. Arbitrum canonical bridge

- **VERIFIED in docs**: Robinhood Chain uses the Arbitrum canonical bridge. Deposits typically land in about 10 minutes. Withdrawals need a 7-day challenge period and an L1 claim. No bridge fee is stated beyond L1 gas. https://docs.robinhood.com/chain/bridging/
- **VERIFIED in docs**: the addresses below come from https://docs.robinhood.com/chain/protocol-contracts. Ethereum is the parent chain (https://docs.robinhood.com/chain/cross-chain-messaging gives parent chain id 1).
- **VERIFIED on-chain** (Ethereum):

| Contract | Address | Code size |
|---|---|---|
| Rollup | `0x23A19d23e89166adedbDcB432518AB01e4272D94` | 5172 B |
| Sequencer Inbox | `0xBd0D173EEb87D57A09521c24388a12789F33ba96` | 2201 B |
| Delayed Inbox | `0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D` | 2201 B |
| Bridge | `0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3` | 2201 B |
| Outbox | `0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9` | 2201 B |
| L1 Gateway Router | `0x6a2E3a1e16FC29f27Ce61429746D558d656975bB` | 2202 B |
| L1 ERC20 Gateway | `0x85001CC4867C5e1C22dA4B79BB8852B9e2a06da0` | 2202 B |

- **VERIFIED on-chain** (Ethereum reads):
  - `Rollup.chainId()` = 4663.
  - `Bridge.rollup()` = the Rollup above.
  - `Rollup.confirmPeriodBlocks()` = 45818. At 12-second L1 blocks that is about 6.4 days; the docs round this to 7 days.
- **VERIFIED on-chain** (Robinhood): L2 Gateway Router `0x1E32…1B89` is 2202 B, L2 ERC20 Gateway `0xfd9b…b31e` is 2202 B, and L2 WETH Gateway `0x1D18…F055` is 2202 B.
- **VERIFIED on-chain**: `calculateL2TokenAddress(Ethereum USDC)` = `0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8`. That token is 835 B, symbol "USDC", total supply 384.49. This is bridged USDC from Ethereum, not Circle-issued.
- Canonical path from Robinhood to Arc: withdraw to Ethereum (about 7 days), then CCTP V2 from Ethereum to Arc (15-19 min Standard). Arc is not an Ethereum rollup, so there is no canonical bridge to Arc.

### 6. LayerZero v2

- **VERIFIED in docs (API)**: `https://metadata.layerzero-api.com/v1/metadata/deployments` lists:
  - `robinhood-mainnet`: chain 4663, eid 30416, EndpointV2 `0x6f47…dd5b`, ACTIVE.
  - `arc-mainnet`: chain 5042, eid 30417, same endpoint address, ACTIVE.
- **VERIFIED on-chain**:
  - EndpointV2 `0x6F475642a6e85809B1c36Fa62763669b1b48DD5B` is 24005 B on both chains.
  - `eid()` = 30416 on Robinhood and 30417 on Arc.
  - `0x1a44076050125825900e736c501f859c50fE728c` has 0 B on both chains.
- **VERIFIED on-chain**:
  - `isSupportedEid` is true in both directions.
  - Default send library `0xC391…2de7` and receive library `0xe184…1043` on both chains.
  - `getUlnConfig(0x0, eid)` returns `(5, 1, 0, 0, [0x6788f52439ACA6BFF597d3eeC2DC9a44B8FEE842], [])` in both directions. The LayerZero metadata names `0x6788…E842` `lz-dead-dvn`, so default messages between the two chains cannot be verified.
- **VERIFIED on-chain**: Anon OFT `0x79bbF4508B1391af3A0F4B30bb5FC4aa9ab0E07C` (14545 B on both chains) is peered both ways.
  - Robinhood send config: 15 confirmations, 3 required DVNs (`0x0Ffe…FdF8` nethermind, `0x8D77…82Dd` canary, `0xd01a…5b12` layerzero-labs).
  - Arc receive config: 3 required DVNs (`0x9E0E…da80` nethermind, `0xa244…e525` layerzero-labs, `0xaCDe…16e7` canary).
  - Endpoint `outboundNonce` on Robinhood = 1. Arc `inboundNonce` = 1. One message was sent and delivered.
  - This proves the lane works once an app configures DVNs. It is not a stablecoin route.
- **VERIFIED on-chain**: weETH `0xA3D6…914b` exists on both chains but `peers` is 0 in both directions, with the default dead-DVN config.
- **VERIFIED in docs (API)**: `https://transfer.layerzero-api.com/v1/tokens` lists USDG on Robinhood. On Arc it lists only USDC, tGBP, weETH, Anon, WPAY and GBPA. No USDG on Arc.
- **UNVERIFIED**: Stargate pools on either chain. The old Stargate API now returns a deprecation notice, and the newer LayerZero quote endpoint returned "not found" for USDG to USDC.

### 7. Circle CCTP V2 (direct): deployed but not enabled

- **VERIFIED in docs**: Circle's supported-chains page lists Arc as domain 26. Robinhood Chain is not listed. https://developers.circle.com/cctp/cctp-supported-blockchains
- **VERIFIED in docs**: the USDC contract-addresses page lists Arc USDC `0x3600000000000000000000000000000000000000`. Robinhood Chain is not listed. https://developers.circle.com/stablecoins/usdc-contract-addresses
- **VERIFIED on-chain**: the CCTP V2 contracts exist on both chains with identical code hashes.
  - TokenMessengerV2 `0x28b5…cf5d`: 2175 B on both chains.
  - MessageTransmitterV2 `0x81D4…4B64`: 2175 B on both. Code hash `0xd2c8…ae99` on both.
  - TokenMinterV2 `0xfd78…D002`: 9295 B on both.
- **VERIFIED on-chain**: `localDomain()` = 35 on Robinhood and 26 on Arc. `version()` = 1 on both.
- **VERIFIED on-chain**: both chains use 2 enabled attesters with threshold 2. Attester 0 is `0x725b06F73ff761eF5390e39315e2BfbF60d33F96` on both.
- **VERIFIED on-chain** (Robinhood side):
  - `remoteTokenMessengers(26)` is set, so Robinhood knows Arc.
  - Robinhood knows domains 0 1 2 3 5 6 7 9 10 11 12 13 14 15 16 18 19 21 22 25 26 27 28 29 30 31 32.
  - `getLocalToken(26, Arc USDC)` = `0x3884564BA51B349e7661c7e28Ad947DEE327FeDF`. That is a 1798 B "USDC" proxy, 6 decimals, total supply 2.62 USDC.
  - `TokenMinterV2.burnLimitsPerMessage(0x3884…FeDF)` = 0, so burns on Robinhood revert.
  - `USDC.minterAllowance(TokenMinterV2)` = 0, so mints on Robinhood revert.
- **VERIFIED on-chain** (Arc side):
  - `remoteTokenMessengers(35)` = 0. Arc knows domains 0 1 2 3 5 6 7 8 9 10 11 12 13 14 15 16 18 19 21 22 25 27 28 29 30 31 32 33 37. 35 is not among them.
  - `getLocalToken(35, 0x3884…FeDF)` = 0.
  - Arc USDC burn limit = 1e13. Arc USDC minter allowance for TokenMinterV2 = 9.77e13.
- **VERIFIED on-chain**: Ethereum `remoteTokenMessengers(35)` = 0 and Arbitrum One `remoteTokenMessengers(35)` = 0.
- **VERIFIED in docs (API)**: `iris-api.circle.com/v2/burn/USDC/fees/35/26` and `/26/35` both return "Invalid source/destination domain id".
- Conclusion: there is no native USDC on Robinhood mainnet today, and CCTP between the two chains is not usable. Circle may enable it later. Nothing found states a date (**UNVERIFIED**).
- **Testnet, VERIFIED on-chain**:
  - Robinhood testnet (46630) and Arc testnet (5042002) both have TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` (2175 B) and MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` (2175 B).
  - `localDomain()` = 35 and 26.
  - `remoteTokenMessengers` is set in both directions.
  - Robinhood testnet USDC `0x2FD79307e37Ff0d60AE26A108FBA5B22bfC34b12` has burn limit 1e13. Arc testnet maps it to `0x3600…0000`.
  - **VERIFIED in docs (API)**: `iris-api-sandbox.circle.com/v2/burn/USDC/fees/35/26` returns 1.4 bps (Fast) and 0 (Standard).

### 8. Uniswap

- **VERIFIED in docs**: Uniswap v4 deployments list both chains. https://developers.uniswap.org/docs/protocols/v4/deployments (served as `llms.mdx`)
- **VERIFIED on-chain** (Robinhood):
  - PoolManager `0x8366…0951`: 24009 B.
  - PositionManager `0x58da…4fa7`: 23877 B.
  - Quoter `0x8dc1…8f94`: 6118 B.
  - StateView `0xf333…673b`: 3531 B.
  - Universal Router `0x8876…0904`: 24546 B.
  - Universal Router 2.1.2 `0x204F…0498`: 24380 B.
- **VERIFIED on-chain** (Arc):
  - PoolManager `0x8366…0951`: 24009 B, same code hash `0xbd38…5626`. `owner()` differs: `0x2BAD…46CD` on Robinhood, `0xbCA3…5a75` on Arc.
  - PositionManager `0x6049…f82B`: 23877 B.
  - Quoter and StateView at the same addresses as Robinhood.
  - Universal Router `0x4fcA…9Fb1`: 24546 B.
  - Universal Router 2.1.2 `0x8702…2650`: 24380 B.
- **VERIFIED on-chain**: Permit2 `0x0000…8BA3` is 9152 B on both chains.
- **VERIFIED in docs**: UniswapX lists a DutchV3OrderReactor on both chains: Robinhood `0x000000007A1C8e570011EeDF86A2A35593013cBA` and Arc `0x0000000015134054eA82AE0bb9fda66b36402C36`. https://developers.uniswap.org/docs/liquidity/uniswapx/deployments.md
- **VERIFIED on-chain**: both reactors are 17206 B. OrderQuoter `0x0000…7F58` is 3709 B on both.
- These reactors settle swaps on a single chain. No cross-chain (ERC-7683) settler for either chain is listed (**VERIFIED in docs**, same page). Uniswap is a swap venue on each side, not a bridge.

### 8b. Uniswap v4 Stock Token pools on Robinhood (checked for the value bridge)

- **VERIFIED on-chain**: PoolManager `Initialize` logs, blocks 0–9,999,999 (the scan of later blocks was stopped once pools were found): 54,451 pools. 65 pair a Stock Token with USDG or ETH, and 31 have in-range liquidity (`StateView.getLiquidity`).
- **VERIFIED on-chain** (V4Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`, eth_call on mainnet): NVDA/USDG 0.3% sells 1 / 10 / 100 NVDA for 184.63 / 1,843.42 / 18,201.37 USDG. That is 0.5% / 0.66% / 1.9% under Chainlink NVDA/USD $185.56 × amount, without NVDA's uiMultiplier (1.000775). TSLA/USDG 0.3% sells 1 TSLA for 345.88 USDG (Chainlink $347.56). AAPL/USDG 0.3% sells 1 AAPL for 341.77 USDG (Chainlink $343.56).
- **VERIFIED on a fork**: the Universal Routers at `0x8876…0904` and `0x204F…0498` take a six-field `ExactInputSingleParams`. A swap of 1 NVDA through `NorenSettlementDesk` filled exactly at the V4Quoter quote.
- So Stock Tokens convert to USDG on-chain at about 0.5% for a single share. Larger sizes cost more.

### 9. Chainlink CCIP (checked again for the "Best use of CCIP" track)

There is no CCIP lane between Robinhood Chain and Arc, on mainnet or testnet. Checked 2026-11-06 about 05:00 UTC.

- **VERIFIED in docs (API)**: `https://docs.chain.link/api/ccip/v1/chains?environment=testnet` lists Robinhood Chain Testnet (chain 46630, selector 2032988798112970440, Router `0x30D197C6F5bE050D5525dD94d01760FaCdB67e7C`) and Arc Network Testnet (chain 5042002, selector 3034092155422581607, Router `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8`).
- **VERIFIED in docs (API)**: `https://docs.chain.link/api/ccip/v1/lanes?environment=testnet` has 436 lanes and no `46630_to_5042002` or `5042002_to_46630`. Robinhood Testnet has 22 lanes and Arc Testnet has 12.
- **VERIFIED in docs (API)**: the mainnet lane list has no `4663_to_5042` or `5042_to_4663` either.
- **VERIFIED on-chain** (testnet routers, both 10761 B, `typeAndVersion()` = "Router 1.2.0"):
  - Robinhood Testnet `isChainSupported(arc-testnet)` = false and `getOnRamp` = 0.
  - Arc Testnet `isChainSupported(robinhood-testnet)` = false and `getOnRamp` = 0.
  - Neither router's `getOffRamps()` has the other chain as a source.
- **VERIFIED in docs (API)**: these chains share lanes with both testnets, so a two-hop route exists:
  - Ethereum Sepolia (11155111)
  - Base Sepolia (84532)
  - Polygon Amoy (80002)
  - 0G Galileo (16602)
  - Solana Devnet

  The mainnet equivalents are Ethereum, Base, Polygon, 0G and Solana. CCIP does not route through a hop chain for you, so this would need an app-owned relay contract on the hop chain. That contract would receive with `ccipReceive` and re-send with `ccipSend`, which is a third chain, two fees and two finality waits. Not checked: whether any token pool is enabled on those hops.
- **Can the credit-line message go over CCIP inside the contracts?** Not directly today, because no lane exists. The message is small and the contracts could carry it in-contract:
  - On Robinhood, `NorenCredit` would `ccipSend` the `(borrower, lineId, limit, expiry)` payload.
  - On Arc, `NorenCreditLine` would apply it in `ccipReceive`.
  - Repayments would flow back the same way.

  That needs either a direct lane, which Chainlink has not listed, or the two-hop relay above. The build therefore keeps CRE for delivery: CRE has forwarders on both testnets. If a direct lane is published, the contracts can add a CCIP receiver next to `onReport`, with CRE kept for the off-chain steps (underwriting reads, World ID checks, monitoring). This is a recommendation, not built.

## Not available

| Route | Status | Evidence |
|---|---|---|
| Chainlink CCIP, direct lane | No lane | **VERIFIED in docs**: CCIP directory lists both chains. Router Robinhood `0x06fC836cf9839B1cd891C440A0a45242DA6Ae1c9`, Arc `0xB79791184973589c38e114D43Eb8E4588C283A18`. https://docs.chain.link/ccip/directory/mainnet/chain/robinhood-mainnet and `.../arc-mainnet`. Selectors: Robinhood 6180753054346818345, Arc 6370580034781731079 (github.com/smartcontractkit/chain-selectors `selectors.yml`). **VERIFIED on-chain**: both routers are 10761 B, `typeAndVersion()` = "Router 1.2.0". `isChainSupported(Arc)` on Robinhood = false. `isChainSupported(Robinhood)` on Arc = false. `getOnRamp` = 0 both ways. Both routers support Ethereum (true). |
| CCIP two hops via a shared chain | Possible for messages, not checked for tokens | **VERIFIED on-chain**: from `getOffRamps()`, both routers accept messages from Ethereum, Base, Polygon, Solana and 0G. **VERIFIED in docs** (directory page data): LINK, VIRTUAL and syrupUSDC are listed on both chains. Whether those tokens are enabled on the specific lanes is **UNVERIFIED**. |
| Circle CCTP V2, direct | Deployed, disabled | See section 7. Robinhood burn limit 0 and minter allowance 0. Arc lacks domain 35. Iris rejects 35. |
| Native USDC on Robinhood | Not issued | **VERIFIED in docs**: Circle's USDC address list does not include Robinhood. **VERIFIED on-chain**: the CCTP-mapped USDC `0x3884…FeDF` has supply 2.62 and cannot be minted. |
| USDG on Arc | Not deployed | **VERIFIED in docs**: Paxos list has no Arc entry. Relay and LayerZero token lists for Arc have no USDG. **VERIFIED on-chain**: Robinhood USDG address and Ethereum USDG address both have 0 B on Arc. |
| USDG OFT, direct to Arc | No peer | **VERIFIED on-chain**: `0x0d54…28d1.peers(30417)` = 0. |
| UniswapX / ERC-7683 cross-chain settler | Not listed | Section 8. |
| Hyperlane warp route | None | **VERIFIED in docs**: the registry has `chains/robinhood` and `chains/arc` but no file under `deployments/warp_routes` mentions either (1013 warp files checked via the GitHub tree API). https://github.com/hyperlane-xyz/hyperlane-registry. **VERIFIED on-chain**: both mailboxes are 2840 B with `localDomain` 4663 and 5042. The IGP on Robinhood quotes 3.88e13 wei for 100k gas to 5042; the IGP on Arc quotes 9.55e16 for 100k gas to 4663. The default ISM is an aggregation ISM (`moduleType` 2) on both chains; whether it covers this origin is **UNVERIFIED**. |
| Wormhole Token Bridge | Not listed | **VERIFIED in docs**: wormhole-sdk-ts `core.ts` lists mainnet core contracts for Arc and Robinhood. `tokenBridge.ts` and `circle.ts` have no entry for either. https://github.com/wormhole-foundation/wormhole-sdk-ts. **VERIFIED on-chain**: cores are 680 B, `chainId()` 72 and 71, `getCurrentGuardianSetIndex()` 7 (Ethereum also 7), `messageFee()` 0. |
| Stargate | Not confirmed | **UNVERIFIED**. Robinhood docs mention "LayerZero OFT / Stargate" for OFT tokens such as USDG. No Stargate pool was found that connects the two chains. |
| Chainlink CRE on mainnet | Not listed | **VERIFIED in docs**: the CRE forwarder directory lists `robinhood-testnet` and `arc-testnet` only. https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts |

## Stock Tokens

- **VERIFIED in docs**: Stock Tokens are "standard ERC-20 tokens" with 18 decimals and an ERC-8056 `uiMultiplier()`. https://docs.robinhood.com/chain/stock-tokens
- **VERIFIED in docs**: they "can be transferred and held in any wallet". Direct mint and burn is limited to Authorized Participants with KYB. https://docs.robinhood.com/chain/building-with-stock-tokens
- **VERIFIED in docs**: they may not be offered, sold or delivered to US persons (Regulation S). They are also restricted in Canada, the United Kingdom and Switzerland, among others. Redemption is directly with the issuer, subject to KYC/AML. https://docs.robinhood.com/rhj/ and https://docs.robinhood.com/rhj/faq
- **VERIFIED in docs**: no Robinhood page found mentions bridging Stock Tokens to another chain, and none lists another issuing chain.
- **VERIFIED on-chain** (TSLA `0x322F0929c4625eD5bAd873c95208D54E1c003b2d`):
  - It is a 283 B beacon proxy. Beacon `0xe10b6f6B275de231345c20D14Ab812db62151b00` points to implementation `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` (11614 B).
  - `name()` = "Tesla • Robinhood Token". `decimals()` = 18. `totalSupply()` = 14907.51.
  - `terms()` = "https://robinhood.com/stocktoken/rhj".
  - `paused()` = false, `tokenPaused()` = false, `oraclePaused()` = false, `uiMultiplier()` = 1e18.
  - The implementation includes `adminBurn(address,uint256)`, `mint`, `burn`, `pause`, `pauseOracle` and `updateMultiplier`.
- **VERIFIED on-chain**: `ACCESS_CONTROLLED_REGISTRY()` = the beacon `0xe10b…1b00`. NVDA uses the same registry.
  - Its selectors include `blockAccounts(address[])`, `unblockAccounts(address[])`, `isBlocked(address)`, `pause()` and `upgradeTo(address)`.
  - The model is a blocklist plus a global pause, not an allowlist. The issuer can also burn from any address.
  - `isBlocked` is false for the Relay Depository, the Across SpokePool, the v4 PoolManager and `0x…dEaD`. The registry's `paused()` = false.
- **VERIFIED on-chain**: no Stock Token contract exists on Arc (TSLA address has 0 B on Arc).
- **VERIFIED in docs (API)**: Relay rejects TSLA (`UNSUPPORTED_CURRENCY`). deBridge accepts TSLA only by selling it for USDG on Robinhood first.
- Conclusion: Stock Tokens cannot move to Arc. They can be sold on Robinhood and the proceeds bridged. Any contract holding them can be blocked, paused or burned by the issuer.

## Recommendation

**Moving value Robinhood to Arc and back today.** Use an intent bridge on the stablecoin pair: USDG on Robinhood to USDC on Arc.

- Relay first. It quoted both directions at about 0.06-0.11% and 1 s, and quoted 50,000 USDG without error.
- Across second. It quoted 0.064-0.069% and 1-2 s, with a 24,666 USDG instant limit from Robinhood.
- Keep deBridge as a fallback. Its fixed fee (0.001 ETH or 1 USDC) makes small transfers costly.
- All three rely on relayer or solver liquidity and their own settlement systems. None is issuer-backed.
- The slow, fewer-intermediaries path:
  - Robinhood to Arc: USDG OFT from Robinhood to Ethereum, swap to USDC, then CCTP V2 from Ethereum to Arc.
  - Arc to Robinhood: CCTP V2 from Arc to Ethereum, swap to USDG, then OFT to Robinhood.
- The canonical Arbitrum exit adds about 7 days and suits only ETH or canonically bridged tokens.

**Cross-chain credit line (CRE carries messages, not tokens).**

- Keep collateral on Robinhood Chain. Stock Tokens cannot leave it.
- Keep the lending pool's USDC on Arc. Draws pay out locally in Arc USDC, so the credit line itself needs no bridge.
- The CRE workflow (packages/cre-bridge) watches `NorenCredit` on Robinhood and writes a DON-signed report through the CRE forwarder on Arc. It also carries Arc draws and repayments back the same way (docs/BRIDGE.md).
- Chainlink lists CRE forwarders only for `robinhood-testnet` and `arc-testnet` today (testnet forwarders: 8591 B each). The CRE leg must run on testnets until mainnet forwarders are published.
- For settlement of repayments and liquidations:
  - **Testnet (build and demo now):** use CCTP V2 between Robinhood testnet (domain 35) and Arc testnet (domain 26). It is live both ways, with Circle attesters and a sandbox fee quote. This is real issuer settlement of USDC, not a third-party bridge.
  - **Mainnet (today):** there is no issuer or messaging token route between the two chains. Settle by selling collateral for USDG on Robinhood (a Uniswap v4 pool or the deBridge pre-swap), then Relay or Across to Arc USDC. Have the Arc contract accept funds only after the bridged USDC reaches its own address, and match the fill to the CRE report by an ID.
  - **Mainnet (later):** switch to direct CCTP V2 when Circle enables domain 35. The on-chain switches to watch are Arc `remoteTokenMessengers(35)` and Robinhood `burnLimitsPerMessage(USDC)`. Both are 0 today. This is the only route found that could give issuer-backed USDC settlement between the two chains.
- Do not use LayerZero, Hyperlane or Wormhole for value here. None has a stablecoin route between these chains. Their messaging overlaps with what CRE already does.

## Open items (UNVERIFIED)

- When, or whether, Circle enables CCTP domain 35 on mainnet.
- Stargate pools on Robinhood or Arc.
- Whether the Hyperlane default ISM on each chain accepts messages from the other.
- Whether Chainlink will publish a direct CCIP lane between Robinhood Chain and Arc, on testnet or mainnet.
- Whether LINK, VIRTUAL or syrupUSDC CCIP pools are enabled on the Robinhood to Ethereum to Arc lanes.
- The Uniswap app's own cross-chain routing for this pair (the API needs a key).
- Settlement and security details of Relay, Across and deBridge, beyond the contracts and quotes above.
- The swap venue and depth for USDG to USDC on Ethereum.
