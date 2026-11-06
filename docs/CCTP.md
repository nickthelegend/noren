# Noren USDC rail into Arc (Circle CCTP V2 + Chainlink CRE)

Arc is Noren's hub. This rail brings native USDC into Arc Testnet from 10 other CCTP V2 testnets. It uses Circle's
burn-and-mint protocol, so no wrapped tokens or liquidity pools are involved. A Chainlink CRE workflow is the
automation layer: it watches each source chain, fetches Circle's attestation with DON consensus, and completes the mint on Arc.

With a **CCTP V2 hook**, the same transfer can also do something on Arc: pay a Noren invoice, make an Earn deposit, open
an Aqua order, update a credit line, or pay on credit. The hook hands the minted USDC to Noren's shared
`NorenArcActionRouter`, the same router the CCIP rail uses (packages/ccip).

Everything below runs on **public testnets**. The only forks are in the fork tests, and they are labelled as forks.

## How a transfer works

```
source testnet (Base / Arbitrum / Ethereum Sepolia, Robinhood, ...)        Arc Testnet (domain 26)
  user/SDK ── depositForBurn[WithHook](amount, 26, mintRecipient,
              USDC, destinationCaller = NorenArcHook, maxFee, 1000|2000[, action])
                 │ TokenMessengerV2 burns USDC
                 └─ MessageTransmitterV2 emits MessageSent(message)
                                 │
  Chainlink CRE workflow  packages/cctp/cre/cctp-relay
   1. EVM log trigger: MessageSent on that chain (one handler per chain, 10 chains)
   2. filter: CCTP V2 burn, destination 26, destinationCaller == NorenArcHook
   3. HTTP: GET iris-api-sandbox.circle.com/v2/messages/{domain}?transactionHash=…
            identical consensus on state, message and attestation
   4. check: the attested message is the logged burn (every field Circle doesn't fill in)
   5. EVM read: NorenArcHook.processed(nonce) on Arc (skip if already done)
   6. report abi.encode(message, attestation) ─► CRE forwarder ─► NorenArcHook.onReport
                                                                        │
                                   Circle MessageTransmitterV2.receiveMessage (verifies attesters)
                                   ├─ plain:  USDC minted to mintRecipient            → Bridged
                                   └─ hook:   USDC minted to NorenArcHook → router.execute(
                                              keccak256("CCTP"), nonce, domain, depositor,
                                              USDC, minted, action)                   → HookExecuted, Bridged
```

- **Only Noren's hook can finish a Noren burn on Arc.** The burn names `NorenArcHook` as `destinationCaller`, and Circle's
  transmitter refuses anyone else. The hook's `relay()` is open to every relayer, because Circle's attested message fixes
  the outcome. `onReport` accepts only the CRE forwarder.
- **Hook data is the shared Arc action:** `abi.encode(uint8 kind, address beneficiary, bytes32 ref, bytes params)`.
  `NorenArcHook.validateAction` checks it strictly: canonical ABI encoding, an exact `params` length per kind, and
  address and uint64 ranges.
  - Malformed hook data still delivers the USDC. It goes to the beneficiary, or to the depositor's address on Arc when no
    beneficiary can be read.
  - `LINE_REPORT` (6) is outbound only and never accepted inbound.
  - Unknown kinds go to the router, which books them as a claimable balance.
- **Idempotent per CCTP nonce.** The hook has `processed[nonce]`, Circle has `usedNonces`, and the router has
  `executed[rail][msgId]`.
- **If the router reverts, the whole call reverts.** The message stays unconsumed and can be retried, or the owner can
  clear the router so the next relay delivers straight to the beneficiary. Funds are never stranded in the hook.

| kind | name | params |
|---|---|---|
| 1 | PAY_INVOICE | `(address merchant, bytes32 invoiceId)` |
| 2 | EARN_DEPOSIT | `(address vault)`: allowlisted ERC-4626 |
| 3 | AQUA_ORDER | opaque order bytes; funds held under `ref` (`settleAquaOrder` / `cancelAquaOrder`) |
| 4 | CREDIT_LINE | `(bytes32 lineId, uint256 limitUsdc6, uint64 expiry, uint64 asOf)` |
| 5 | PAY_ON_CREDIT | `(bytes32 lineId, address merchant, bytes32 invoiceId, uint256 amountUsdc6)` |

## Contracts on Arc Testnet (5042002)

| Contract | Address | Tx |
|---|---|---|
| NorenArcHook (v2, current) | [0x8845ae4B87D706c31606182D5A9529b67ee6B20d](https://explorer.testnet.arc.io/address/0x8845ae4B87D706c31606182D5A9529b67ee6B20d) | [deploy](https://explorer.testnet.arc.io/tx/0xc23b3a48d619c40faec3a7c6744c47cde45327c095188a00a28b9fd5dd7cef4a) |
| `hook.setRouter(NorenArcActionRouter)` | router [0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4](https://explorer.testnet.arc.io/address/0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4) | [tx](https://explorer.testnet.arc.io/tx/0x3d145608994b366f0238c08b324c3078e0a80607a017a7437ce3f75e556770a8) |
| `router.setRail(hook, keccak256("CCTP"))` | | [tx](https://explorer.testnet.arc.io/tx/0x548f444bbbbc9f749f1a2617a41c35e6232c271b2fb23ed75b3b059f45228af7) |
| NorenArcHook v1 (superseded: older CREDIT_LINE encoding, no router) | [0xc0347F3f66C0867F385679a8E0ceF3DB4A3bcb45](https://explorer.testnet.arc.io/address/0xc0347F3f66C0867F385679a8E0ceF3DB4A3bcb45) | [deploy](https://explorer.testnet.arc.io/tx/0x8afeaf7c1fef568ae5e99d4e668072de912e9016938d3b0ac04c66658637e942) |
| Circle TokenMessengerV2 / MessageTransmitterV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` / `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | same address on every testnet below |
| CRE MockKeystoneForwarder (arc-testnet) | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` | `cre workflow supported-chains` |

The hook's owner is the deployer `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80`. The record is in `packages/cctp/deployments.json`.

## Source chains (checked on-chain by `scripts/verify-chains.ts`)

`fixtures/chains-verified.json` records the check for each chain:
- code at both Circle contracts
- `MessageTransmitterV2.localDomain()` equals the domain
- `TokenMessengerV2.remoteTokenMessengers(26)` is set
- USDC is resolved through `localMinter().getLocalToken(26, Arc USDC)`, never from an explorer search

The fast-fee column comes from Iris `GET /v2/burn/USDC/fees/{src}/26` (Nov 6 2026).

| Chain | Chain id | CCTP domain | USDC | Fast fee to Arc | CRE chain name |
|---|---|---|---|---|---|
| Ethereum Sepolia | 11155111 | 0 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 1 bps | ethereum-testnet-sepolia |
| Avalanche Fuji | 43113 | 1 | `0x5425890298aed601595a70AB815c96711a31Bc65` | 0 | avalanche-testnet-fuji |
| OP Sepolia | 11155420 | 2 | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | 1.3 bps | ethereum-testnet-sepolia-optimism-1 |
| Arbitrum Sepolia | 421614 | 3 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | 1.3 bps | ethereum-testnet-sepolia-arbitrum-1 |
| Base Sepolia | 84532 | 6 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 1.3 bps | ethereum-testnet-sepolia-base-1 |
| Polygon Amoy | 80002 | 7 | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | 0 | polygon-testnet-amoy |
| Unichain Sepolia | 1301 | 10 | `0x31d0220469e10c4E71834a79b1f276d740d3768F` | 1.5 bps | ethereum-testnet-sepolia-unichain-1 |
| Linea Sepolia | 59141 | 11 | `0xFEce4462D57bD51A6A552365A011b95f0E16d9B7` | 11 bps | ethereum-testnet-sepolia-linea-1 |
| World Chain Sepolia | 4801 | 14 | `0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88` | 1.3 bps | ethereum-testnet-sepolia-worldchain-1 |
| Robinhood Chain Testnet | 46630 | 35 | `0x2FD79307e37Ff0d60AE26A108FBA5B22bfC34b12` | 1.4 bps | robinhood-testnet |
| **Arc Testnet (hub)** | 5042002 | 26 | `0x3600000000000000000000000000000000000000` | n/a | arc-testnet |

- CRE allows 10 trigger subscriptions per workflow, so the relay watches these 10 chains. Ink Sepolia (domain 21) also
  has CCTP V2 but was left out for that reason.
- BNB Chain has no CCTP; Noren's CCIP rail covers chains CCTP can't reach.

## Live runs (public testnets, Nov 6 2026)

Every record is a JSON file in `packages/cctp/fixtures/`, and they are collected in `fixtures/live-runs.json`.
- **"CRE"** means Noren's workflow was run with `cre workflow simulate --broadcast` (CRE CLI v1.39) on the real burn log.
  The Arc tx is the CRE MockKeystoneForwarder calling `NorenArcHook.onReport`. Each record holds the workflow's log lines.
- **"SDK"** means `mintFromArc`, which calls Circle's `receiveMessage` directly.

**Into Arc** (the CRE relay):

| Route | Action | Burn | Minted on Arc (fee) | Arc tx | Events on Arc |
|---|---|---|---|---|---|
| Base Sepolia → Arc | PAY_INVOICE via router | [0x69189700…](https://sepolia.basescan.org/tx/0x691897008418bf06e0fbff5ae7c23be09663f84d2a976cec94a5f183184b6160) | 0.399948 (52) | [0x5f752147…](https://explorer.testnet.arc.io/tx/0x5f752147fb96908488a120d4fb840093d8411244d2f4140f20af13c99875cc84) | InvoicePaid, ActionExecuted, HookExecuted(routed), Bridged |
| Arbitrum Sepolia → Arc | plain | [0xf4cf3e42…](https://sepolia.arbiscan.io/tx/0xf4cf3e42f57a4097b406c587fe6f19a7e85e1d73f02937bb76f5d15d0847b53c) | 1.999740 (260) | [0xb72b97ea…](https://explorer.testnet.arc.io/tx/0xb72b97ea2d1a6d6aabbf532a947e7bfa1acf4b4d18c4bd6127929742e4bdbee6) | Bridged |
| Arbitrum Sepolia → Arc | AQUA_ORDER via router | [0xb7ff5e88…](https://sepolia.arbiscan.io/tx/0xb7ff5e888260730ac16c2583cb2b16c56403de5234b5b761c3cc3069f2fd2949) | 0.999870 (130) | [0xd46f2427…](https://explorer.testnet.arc.io/tx/0xd46f2427adbd3970e8119ba2090f1cb2e293768949ec32526ad8c90f2c6feb60) | AquaOrderOpened, ActionExecuted, HookExecuted, Bridged |
| Robinhood → Arc | plain | [0xc5c221b0…](https://explorer.testnet.chain.robinhood.com/tx/0xc5c221b026281d1832e92a108184ee535914a349eb2795de27d16a6ffca346f8) | 0.899874 (126) | [0x7828cd32…](https://explorer.testnet.arc.io/tx/0x7828cd32598c10a81046bfcaf9cfc36baef7d327387b2fd8b34396565e836ac7) | Bridged |
| Base Sepolia → Arc (hook v1, no router yet) | PAY_INVOICE delivered to beneficiary | [0xc41f6877…](https://sepolia.basescan.org/tx/0xc41f6877d07720adff523d479c4d8b79f92404a5a776fad1a8548369442ce22f) | 0.499935 (65) | [0x1cdf7ad8…](https://explorer.testnet.arc.io/tx/0x1cdf7ad89021b380156ce2d704c1a5775570beff8e98db4a91a9bcbb0d79b66f) | HookExecuted(routed=false), Bridged |

All of these were fast transfers (`finalityThresholdExecuted` 1000). Circle attested each one in 5 to 30 seconds.

**Out of Arc** (`burnFromArc` → Iris → `mintFromArc`, `destinationCaller` 0):

| Route | Approve | Burn on Arc | Iris attestation | Mint |
|---|---|---|---|---|
| Arc → Robinhood, 1 USDC | [0x2f5370ba…](https://explorer.testnet.arc.io/tx/0x2f5370ba927b32bcbdd907013a1e96422f76650ba855b55fc0fa3733ed62403f) | [0x433c334a…](https://explorer.testnet.arc.io/tx/0x433c334a242ccf2203eb4e1cdc3cc795c606cf3b7877647b0fc1bf6eb193f7fe) | [nonce 0x65e9c7e6…](https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=0x433c334a242ccf2203eb4e1cdc3cc795c606cf3b7877647b0fc1bf6eb193f7fe) (~4 s) | [0xc74ce4d1…](https://explorer.testnet.chain.robinhood.com/tx/0xc74ce4d19f01cb573df7d3c3af0e30d06ef043d6a0832cf87b6380755d1a56b5) |
| Arc → Base Sepolia, 1 USDC | [0x78e309d7…](https://explorer.testnet.arc.io/tx/0x78e309d79bc2ed2a4d2bb5d714d17d74cc5277056129d9ba796fd4ecec622ad5) | [0x8d512845…](https://explorer.testnet.arc.io/tx/0x8d512845052a1d84d18f57ffaba421db35dc7194e34ab8135daf3394f2548506) | [nonce 0x899e6e42…](https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=0x8d512845052a1d84d18f57ffaba421db35dc7194e34ab8135daf3394f2548506) | [0xc1279ae5…](https://sepolia.basescan.org/tx/0xc1279ae5d48118b158c8d8b8eb36e67c85ac3498e7585eaa1c1102dab9e655cb) |

**From the Noren app (Bridge → Robinhood Chain ⇄ Arc, Nov 6 2026).** These ran from the app's UI, signed by the browser's own test key `0x6D6C8c418564B5aA9d4f49547f7D081f9C6B42cc`, which `scripts/live/fund-test-key.ts` funded from the deployer with 1 USDC on Arc testnet ([0xfc249657…](https://explorer.testnet.arc.io/tx/0xfc24965706ff541168388b9b82872fe0cd0ea7e24047fef96285fac0e3853a4f)) and 0.003 ETH on Robinhood testnet ([0x35ed623d…](https://explorer.testnet.chain.robinhood.com/tx/0x35ed623d1473947a3b6d5adc401ec1ed45f90024991216e3ecb3f4d717cc2b4d)). Circle's faucet has no Robinhood testnet USDC, so the Robinhood leg spent what the Arc → Robinhood leg delivered. The browser finished each transfer itself (no relay running).

| Route | Approve | Burn | Minted (fee) | Mint | Click to landed |
|---|---|---|---|---|---|
| Arc → Robinhood, 0.60 USDC | [0xdf2074fa…](https://explorer.testnet.arc.io/tx/0xdf2074fa72c37490d276c194608a77c8ac7bd5105ceed32091cad4e35f4a22f3) | [0x03797d2e…](https://explorer.testnet.arc.io/tx/0x03797d2e9a08af41a78b901d89860dcc30990a9edfc5d91a1e31e02ccbe41307) | 0.600000 (0) | `receiveMessage` [0xa74ed6e3…](https://explorer.testnet.chain.robinhood.com/tx/0xa74ed6e3965976538cfd4b37c044f169e80f8549dbec3bfcf149416ad739c954) | 14 s |
| Robinhood → Arc, 0.50 USDC | [0xa52150d9…](https://explorer.testnet.chain.robinhood.com/tx/0xa52150d962c23fac7ad038631469d3c5668136be467a542907f98c3858cc17d6) | [0x47a2e51a…](https://explorer.testnet.chain.robinhood.com/tx/0x47a2e51abf964354da8feed31007ae2d3a7218f9a3a962d66e1e88d01b1927c9) | 0.499930 (70) | `NorenArcHook.relay` [0x67711657…](https://explorer.testnet.arc.io/tx/0x677116575e3ed4d77a8fa026bc51e9290a027b0072b283757414ededb8a2228d) | 9 s burn to mint |
| Robinhood → Arc, 0.10 USDC | (allowance left) | [0x4129b3d3…](https://explorer.testnet.chain.robinhood.com/tx/0x4129b3d33aaf6e2e03878c5d2c3e1e61b6f3d9a22612b6371470afd8862b2e42) | 0.099986 (14) | `NorenArcHook.relay` [0x1a1a756f…](https://explorer.testnet.arc.io/tx/0x1a1a756f1c2cc0cce6bc26548e3ba222af45c8209c9c4440db801202618882b9) | 12 s |

**From the Noren app, any chain → Arc (Bridge → "Bring USDC to Arc from any chain", Nov 6 2026, ~18:15 UTC).** One live transfer from each of Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia, started by clicking **Bring 0.50 USDC from …** in the app (wallet mode "test key", the same browser key `0x6D6C8c418564B5aA9d4f49547f7D081f9C6B42cc`). The browser burned on the source chain, waited for Circle's attestation and finished the mint on Arc itself with `NorenArcHook.relay`. All three were fast transfers (`finalityThresholdExecuted` 1000). `scripts/live/record-ui-cctp.ts` wrote them into `packages/cctp/fixtures/live-runs.json` from Iris and the chains' receipts.

| Route | Approve | Burn | Minted on Arc (fee, USDC6) | Mint on Arc | Click to landed (UI) |
|---|---|---|---|---|---|
| Ethereum Sepolia → Arc, 0.50 USDC | [0x6adaa869…](https://sepolia.etherscan.io/tx/0x6adaa8698f31cb9fd3a4f83641ac3433223853f5f029c889e9526fd44a4c2b78) | [0x307a9bcc…](https://sepolia.etherscan.io/tx/0x307a9bccbf0096967a2efff639afab0fde487933f2783bdd20f557ef0c40f597) | 0.499950 (50) | [0x8a60583d…](https://explorer.testnet.arc.io/tx/0x8a60583d674d6164344446abdbc74a79114058985507e9136ab1d8c4a423474d) | 31 s |
| Base Sepolia → Arc, 0.50 USDC | [0xb216f15a…](https://sepolia.basescan.org/tx/0xb216f15afe346982ef242da3fd70127b87b7b876311d43e6a151a5e33050f946) | [0x0c032843…](https://sepolia.basescan.org/tx/0x0c032843dba8cb14c6a8680fa8f143a6ced649b9473ea3e3f92f809b06dad544) | 0.499935 (65) | [0xa45d97f6…](https://explorer.testnet.arc.io/tx/0xa45d97f634e2954879239bd632c8774054f0a8bdb943753735a4bb757f87a733) | 19 s |
| Arbitrum Sepolia → Arc, 0.50 USDC | [0x76ce0664…](https://sepolia.arbiscan.io/tx/0x76ce0664803142c09e90dbae15147219491c3d92c522e4a2b0b1cecd71c47abc) | [0xc4b1c12e…](https://sepolia.arbiscan.io/tx/0xc4b1c12ece1830bfa5dc04938525d141b0d0815ffa3a2e8c5c9a68409b8cfef5) | 0.499935 (65) | [0x34b7f55e…](https://explorer.testnet.arc.io/tx/0x34b7f55edb7597420b30645e1c8ef402d3b88b821fdc8386be59691ef234d3d5) | 16 s |

How the test key was funded first (`pnpm exec tsx scripts/live/fund-test-key.ts 0x6D6C… ethereum-sepolia base-sepolia arbitrum-sepolia`, deployer under the shared nonce lock):
- Arc testnet: 0.122948 USDC so the key held 1 USDC for the mint's gas ([0x40d0d463…](https://explorer.testnet.arc.io/tx/0x40d0d463fdf75fb3041bf081e47f1009bc19da1b98e201536ba60de9f9e23fe2)).
- Ethereum Sepolia: 0.004 ETH ([0xeff678a9…](https://sepolia.etherscan.io/tx/0xeff678a983458c20bb034775a7a33c8f8a23146fec93b2b3b6cf3dd759d8f5a4)) and 0.6 USDC ([0xd3205a74…](https://sepolia.etherscan.io/tx/0xd3205a746faa92a379dd1723502c63b97611c3035dba092f3bcc008a687038ac)).
- Base Sepolia: 0.0015 ETH ([0x1b0527c9…](https://sepolia.basescan.org/tx/0x1b0527c9b6eebafab005728946a541fadf65ee2504c00925e3418664bf4df514)). The deployer held only 0.1 USDC on Base, so the script brought 0.61 USDC out of Arc over CCTP V2 straight to the key: burn on Arc [0xa2eecb1f…](https://explorer.testnet.arc.io/tx/0xa2eecb1ff3ce9ef533b2db4dd795eb7d31e21566e9248326f08ec0200a245e22), mint on Base [0xc444ba0c…](https://sepolia.basescan.org/tx/0xc444ba0c2bdc56d3ac9f4d960750ee55704c248a5d8df95015f4a253079ee478).
- Arbitrum Sepolia: 0.0015 ETH ([0x2e22356e…](https://sepolia.arbiscan.io/tx/0x2e22356e1b6075edad155152104b5e322b1cb9aed5b6bdf942b0a71dad38a203)) and 0.6 USDC ([0x9debc389…](https://sepolia.arbiscan.io/tx/0x9debc389842aa2a825d9c1c18f4049b17a92a6645e661d3fb82d4fd4bd71f659)).

The first Robinhood → Arc run's status card stayed on "Starting…" while the transfer completed on-chain: under React StrictMode the flow hook's "still mounted" flag was cleared by the dev double-mount. That is fixed (`packages/web/src/cctp-flow.ts`), and the 0.10 USDC run shows every step in the UI.

**Robinhood gas, measured from receipts:**
- mint: 171,340 gas
- approve: 55,437 gas
- burn: 111,724 gas

All three ran at 0.01 gwei, and `gasUsedForL1` was 0 on each, for a total of **0.00000339 ETH**.

The Robinhood USDC came from the Arc → Robinhood burn, because Circle's faucet has no Robinhood testnet USDC. The USDC
behind the Base and Arbitrum runs came from the Arc → Base burn and from Circle's faucet.

## Noren SDK (`@noren/cctp`)

```ts
import { bridgeToArc, trackToArc, burnFromArc, attestFromArc, mintFromArc, encodeAction,
         CCTP_CHAINS, SOURCE_CHAINS, NOREN_ARC_HOOK, txUrl } from "@noren/cctp";

// Into Arc. The default relay is "cre": the SDK burns, then watches Iris and NorenArcHook.
const r = await bridgeToArc({
  fromChain: "base-sepolia",             // any SourceChainKey
  amount: "25.00",                       // or 25_000_000n
  recipient: "0x…",                      // who gets the USDC on Arc (and the default beneficiary)
  action: { kind: "pay-invoice", merchant: "0x…", invoiceId: "inv-42" },   // optional CCTP hook
  walletClient,                          // viem WalletClient on the source chain
  fast: true,                            // finality 1000, fee from Iris; false = 2000, no fee
  relay: "cre",                          // or "self" with arcWallet (calls NorenArcHook.relay)
  onStatus: (s) => console.log(s.step),  // approving → burning → burned → attestation-pending
});                                      //   → attestation-ready → minting → minted
r.burnUrl; r.mintUrl; r.nonce; r.minted; r.feeExecuted;

// Out of Arc: burn, attest, then mint with gas on the destination.
const b = await burnFromArc({ toChain: "robinhood-testnet", amount: "1", recipient, walletClient: arcWallet });
const a = await attestFromArc("robinhood-testnet", b.burnTxHash);
await mintFromArc("robinhood-testnet", a, robinhoodWallet);
```

Other actions:
- `{ kind: "earn-deposit", vault }`
- `{ kind: "aqua-order", order: "0x…" }`
- `{ kind: "credit-line", lineId, limitUsdc6, expiry, asOf }`
- `{ kind: "pay-on-credit", lineId, merchant, invoiceId, amountUsdc6 }`

Failure modes:
- A missing key, gas or USDC raises `BridgeError("Setup required: …")`.
- An Iris response that isn't a real attestation is never treated as ready.
- The SDK checks the attested message against the burn before it relays: route, `destinationCaller`, recipient and amount.

## Running it

```bash
cd packages/cctp
pnpm test                                    # forge (unit + fork) + vitest + bun (CRE workflow)
pnpm verify-chains                           # re-checks every CCTP chain live, rewrites fixtures/chains-verified.json
pnpm deploy:arc-hook                         # deploy + setRouter + setRail on Arc Testnet
pnpm exec tsx scripts/live-to-arc.ts base-sepolia 0.5 pay-invoice   # burn, wait for Iris, cre simulate --broadcast
pnpm exec tsx scripts/live-arc-out.ts robinhood-testnet 1           # Arc burn, attestation, mint (resumable)
cd cre && cre workflow simulate cctp-relay --target staging-settings --trigger-index <i> \
  --evm-tx-hash <burn tx> --evm-event-index <MessageSent log index> --broadcast   # needs CRE_ETH_PRIVATE_KEY (Arc gas)
```

- The deployer key comes from the gitignored `.env.arc-deployer` (`NOREN_DEPLOYER_KEY`) and is never printed.
- The key is shared by several Noren agents, so every Arc and Robinhood tx runs under
  `/private/tmp/noren-arc-deployer.lock` with the pending nonce.

## Tests

| Suite | Count | What |
|---|---|---|
| `forge test`: NorenArcHook.t.sol | 17 | Covers:<br>- plain and hook paths, forwarder-only `onReport`, open `relay`<br>- bad attestation, replay, wrong domain or caller, short message<br>- router hand-off, router revert (retryable), garbage hook data refunds the depositor, bad params for a known kind<br>- strict `validateAction`, including a fuzz test that it never reverts<br>- admin access and ERC-165 |
| `forge test`: NorenArcHookFork.t.sol (forks) | 7 | **Arc Testnet fork:** Circle's real MessageTransmitterV2, TokenMessengerV2 and TokenMinterV2 mint through the hook, and the live NorenArcActionRouter pays an invoice. Circle refuses a message not addressed to the hook and an unknown attester. One extra attester is enabled through Circle's `attesterManager` on the fork only, because Iris cannot attest a burn that never happened. Arc's precompile-backed USDC is swapped for a plain ERC-20 stand-in on the fork.<br>**Robinhood fork,** one block before the public mint: Circle's real attestation from the live Arc burn mints 1 USDC, and a replay is refused. |
| `vitest`: test-sdk | 19 | - `parseMessage` field by field against Circle's own decoding of a real message, plus the on-chain `MessageSent` copy<br>- Iris states: complete, 404, pending, malformed, bad signatures length<br>- fees and `maxFee`<br>- action encoding<br>- live: the Iris sandbox, and `validateAction`, `localDomain`, forwarder, router and rail on the deployed hook |
| `bun test`: cre/cctp-relay | 8 | Covers:<br>- config validation<br>- `MessageSent` decoding of a real log<br>- route filter (not Arc, not the hook, wrong source)<br>- `sameBurn` against the real Iris message, and tamper detection<br>- Iris consensus fields<br>- report encoding |

## Limits, stated plainly

- **The relay ran in simulation.** It ran with `cre workflow simulate --broadcast`, not on a deployed DON. The Arc
  writes are real public-testnet transactions through CRE's MockKeystoneForwarder, which does not verify DON signatures.
  A deployed workflow writes through the KeystoneForwarder, which does. To deploy, run `setForwarder` on the hook.
- **The live scripts wait for Iris before running the simulation.** A deployed DON's log trigger fires at the configured
  confidence. If the attestation isn't ready yet, the workflow returns `attestation-pending` and writes nothing.
- **Outbound transfers use `destinationCaller` 0.** Outbound is the SDK's job. There is no Noren contract on the
  destination chains.
- **Unaudited.** NorenArcHook is unaudited.
- **AQUA_ORDER funds wait in the router.** They are held there until the Aqua operator settles the order or the
  beneficiary cancels it.

## For the integrator (README rows)

| Item | Value |
|---|---|
| USDC rail into Arc | Circle CCTP V2 from 10 testnets (Ethereum, Base, Arbitrum, OP Sepolia, Fuji, Amoy, Unichain, Linea, World Chain, Robinhood) → Arc Testnet; live txs in docs/CCTP.md |
| NorenArcHook (Arc Testnet) | `0x8845ae4B87D706c31606182D5A9529b67ee6B20d`, the destinationCaller of every Noren burn; routes CCTP hook actions to NorenArcActionRouter `0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4` |
| Chainlink CRE relay | `packages/cctp/cre/cctp-relay`: MessageSent log trigger, then the Iris attestation (HTTP consensus), then a report to NorenArcHook; live `simulate --broadcast` runs from Base, Arbitrum and Robinhood |
| SDK | `bridgeToArc({ fromChain, amount, recipient, action?, walletClient, onStatus })`; `burnFromArc` / `attestFromArc` / `mintFromArc` for Arc → other chains |
| Tests | 24 forge (7 on forks of Arc and Robinhood testnets with Circle's contracts), 19 vitest, 8 bun |
