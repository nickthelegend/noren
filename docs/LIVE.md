# Live on Arc testnet

Noren runs on the **public Arc testnet** (chain 5042002, RPC `https://rpc.testnet.arc.io`, explorer `https://explorer.testnet.arc.io`). Every transaction below is real: real testnet USDC, real Groth16 proofs, real Chainlink CRE reports. The machine-readable record, with every receipt re-checked on the RPC, is [`deployments/5042002.json`](../deployments/5042002.json) (keys `steps` and `live`).

Recorded Nov 6 2026, 07:00–07:30 UTC.

## Contracts

| Contract | Address | Deploy tx |
|---|---|---|
| NorenCheckout | [`0xe18a80506fdb7f5498aad7387a21134118a77547`](https://explorer.testnet.arc.io/address/0xe18a80506fdb7f5498aad7387a21134118a77547) | [0x84838717…5a3a](https://explorer.testnet.arc.io/tx/0x84838717576c3a55df4b02a19d41ee2cbb0b71efe2b5771ee19d195617565a3a) |
| Entrypoint (ERC1967Proxy) | [`0xa22f3200ecb4319b48dca49677c2f73cd7260ad5`](https://explorer.testnet.arc.io/address/0xa22f3200ecb4319b48dca49677c2f73cd7260ad5) | [0x6728b191…61b7](https://explorer.testnet.arc.io/tx/0x6728b191cd820197a6d58543c8b7f1d8804d86380940a3e7f36effde1f4461b7) |
| Entrypoint implementation | [`0x8116700710ad49b5c19425f458e9cb5120a495f1`](https://explorer.testnet.arc.io/address/0x8116700710ad49b5c19425f458e9cb5120a495f1) | [0x81e853dc…afac](https://explorer.testnet.arc.io/tx/0x81e853dcdc023f296ade84acff5a125c25848d0cbcbb2676c1fa1b20a8f7afac) |
| PrivacyPoolComplex (USDC) | [`0x393d8d46e1dff8a719820e36d70ba509896ea57d`](https://explorer.testnet.arc.io/address/0x393d8d46e1dff8a719820e36d70ba509896ea57d) | [0x5c3de6a4…89a7](https://explorer.testnet.arc.io/tx/0x5c3de6a47a05b8d50cef162b99b9eee4d81110245ddf5cebb809be14021f89a7) |
| Entrypoint.registerPool (USDC, min 1 USDC, fee 0, max relay 5%) | — | [0x5b7d01ce…287d](https://explorer.testnet.arc.io/tx/0x5b7d01cec3a4822498b32de21e195130a9dc2eae5063f2e2634bee18a855287d) |
| WithdrawalVerifier | [`0x015306ac6f866bf9b2dd157a79d65159697fb4cf`](https://explorer.testnet.arc.io/address/0x015306ac6f866bf9b2dd157a79d65159697fb4cf) | [0x880bd94d…4077](https://explorer.testnet.arc.io/tx/0x880bd94d28929911842e826d1f776e93e10eb60eee337b7010ebef2e85624077) |
| CommitmentVerifier | [`0xe57a438a8ded2ad7d1a12ddf497a0da0bd2d2ba3`](https://explorer.testnet.arc.io/address/0xe57a438a8ded2ad7d1a12ddf497a0da0bd2d2ba3) | [0x5ebcf1bc…2ec1](https://explorer.testnet.arc.io/tx/0x5ebcf1bc5ac18802475c874653fc129e5654f250fc4c57f702f3d567594c2ec1) |
| PoseidonT3 | [`0x194155904568e29627a8e451be61d3b7be918197`](https://explorer.testnet.arc.io/address/0x194155904568e29627a8e451be61d3b7be918197) | [0x02ede40e…7436](https://explorer.testnet.arc.io/tx/0x02ede40ef0c31d8a4ee3ab177098a638668d429c5dee115128209d7bced57436) |
| PoseidonT4 | [`0x101951a6b269247591673f4eefccca63d72450bf`](https://explorer.testnet.arc.io/address/0x101951a6b269247591673f4eefccca63d72450bf) | [0xdf28e3db…d0ce](https://explorer.testnet.arc.io/tx/0xdf28e3db5a7a4b5ea00394515321fd91b1cac09b425ee736e36599bf2548d0ce) |
| NorenRateOracle (CRE pricing) | [`0xdb828bdcf33ef0a5a32861e4831ff3dd87be831c`](https://explorer.testnet.arc.io/address/0xdb828bdcf33ef0a5a32861e4831ff3dd87be831c) | [0x00c1df9c…c7d0](https://explorer.testnet.arc.io/tx/0x00c1df9c222572210a8b6787482a11efe19d7f20b2ec076979a9932a4de9c7d0) |
| NorenCreditLine (CRE bridge, Arc side) | [`0x7140aad0bb38dc6908a857b446897c78b0d88876`](https://explorer.testnet.arc.io/address/0x7140aad0bb38dc6908a857b446897c78b0d88876) | [0x1287a445…0077](https://explorer.testnet.arc.io/tx/0x1287a4453d3f8a44dd55d94997437309ddb3752d14ccddcc7f3a49da2dc90077) |

- **Operator** (deployer, merchant and ASP postman): `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80`.
- **USDC**: `0x3600000000000000000000000000000000000000` (6 decimals).
- **CRE forwarder** for the oracle and the credit line: Arc testnet's MockKeystoneForwarder `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`, the one `cre workflow simulate --broadcast` uses.

## Private checkout, end to end (`scripts/live/e2e-live.ts`)

This run used:
- the merchant server (`packages/server`) and the ASP postman (`packages/postman`), both run in one process;
- the Noren SDK (`createNoren`) for merchant calls;
- `@noren/core/customer` (Kohaku) for the customer.

The merchant is the operator. Its payout address `0x32EeabA92847DB5D6fD74248b82BB05d82a1F821` and the customer `0x519042674306F780C277152A38365547AF180b8a` are fresh keys made for this run.

| # | Step | Sent by | Tx | Gas |
|---|---|---|---|---|
| 1 | `registerMerchant(payout)` | merchant | [0xb20de4bc…cffd](https://explorer.testnet.arc.io/tx/0xb20de4bcb0cc031e0644ae9dc1541c2140db8195fdd2c006da671ff1e04fcffd) | 45,533 |
| 2 | Fund the customer with 6 USDC | operator | [0xa790c400…1491](https://explorer.testnet.arc.io/tx/0xa790c400aa4739572691116a36d7692d8d612395899a70013f255eca96af1491) | 73,950 |
| 3 | Customer approves the Entrypoint | customer | [0x507a67d2…8af4](https://explorer.testnet.arc.io/tx/0x507a67d2439db820c9b685a5a3c6d651ba155d88acd90769cf6890fd70388af4) | 55,426 |
| 4 | **Shield 5 USDC** (Kohaku `prepareShield` → `Entrypoint.deposit`) | customer | [0xbc38cde1…89b9](https://explorer.testnet.arc.io/tx/0xbc38cde15ff532dad348969aa08a08d958a3c447040876c1c842caa3b54089b9) | 355,959 |
| 5 | ASP approves the deposit: checks `USDC.isBlacklisted`, then `updateRoot` | postman | [0x1bae7d18…a978](https://explorer.testnet.arc.io/tx/0x1bae7d18001d3e2e12f962ff90afbcc7d53b4536acf6bcdcbf7388c900f2a978) | 166,761 |
| 6 | **Pay a 2.50 USDC invoice privately** (`NorenCheckout.pay`, relayed by the merchant server) | merchant | [0x1ce6858a…776a](https://explorer.testnet.arc.io/tx/0x1ce6858a82a86d309d41f4639d9c958a3d50a82804ed6b2efc7d82435780776a) | 616,437 |
| 7 | Refund: merchant approves 1.00 USDC | merchant | [0xec231956…ff8b](https://explorer.testnet.arc.io/tx/0xec2319562fc2dd56d9e71b0c219a504f544a38ae9286d83bb493873574caff8b) | 55,438 |
| 8 | **Refund 1.00 USDC** into the customer's shielded refund inbox (`NorenCheckout.refund`) | merchant | [0x890ab6a6…016a](https://explorer.testnet.arc.io/tx/0x890ab6a618a3caf187eb26a3071660ef2f2f2d8de9298b8c71658f66c2ee016a) | 396,626 |
| 9 | ASP approves the refund deposit (`updateRoot`) | postman | [0xb4c1119e…5642](https://explorer.testnet.arc.io/tx/0xb4c1119e165e6207242d926192274c01cb34d270485480d88838fbc80a9f5642) | 149,661 |

What the run checked, and what you can check on the explorer:
- **Invoice.** Invoice `0x1bc1a9de…61a0` was drafted by the merchant server. The customer bound a refund precommitment and a receipt commitment to it.
- **Proof.** The withdrawal proof was made in Node in **2.54 s**. It used `@noren/core`'s `proveInvoicePayment`, the same snarkjs Groth16 prover and the same 0xbow circuit artifacts that the hosted checkout runs in the browser. Only the runtime differs (Node instead of a browser tab).
- **Payment.** Tx 6 moves 2.50 USDC from the pool to NorenCheckout, then from NorenCheckout to the payout. The run checked that the payout's balance went up by exactly 2.50 USDC.
- **Webhooks.** Signed `payment.succeeded` and `refund.succeeded` webhooks arrived and passed HMAC-SHA256 verification (`verifyWebhook`).
- **Refund.** After the second ASP root, the customer's refund inbox showed 1.00 USDC as spendable. 2.50 USDC is still shielded in the pool.
- **Unlinkability.** The customer's address appears in neither the input nor the logs of tx 6 (pay) or tx 8 (refund). It shows up only in its own shield transactions (3 and 4).

USDC used: the operator went from 19.700254 to 12.669976 USDC over the run. That is 6.00 to the customer, 1.00 for the refund and about 0.03 in gas. The customer spent about 0.008 USDC in gas.

Rerun: `pnpm exec tsx scripts/live/e2e-live.ts`, then `pnpm exec tsx scripts/live/record.ts`.
- **Keys.** The script loads `NOREN_DEPLOYER_KEY` from the main checkout's gitignored `.env.arc-deployer`. It makes the customer and payout keys once, in the main checkout's gitignored `.keys-live-arc.json` (mode 0600). It never prints a key.
- **Resuming.** Finished steps are recorded in `data/live-arc/state.json`, so a rerun never repeats a transfer, shield, payment or refund.
- **Ports.** 8800 (merchant server), 8801 (ASP tree), 8802 (webhook receiver).

## Chainlink CRE on Arc testnet (`scripts/live/cre-live.ts`)

The script runs `cre workflow simulate … --target staging-settings --broadcast` with CRE CLI v1.39.0. The simulator signs the report and sends it through the real MockKeystoneForwarder on Arc testnet to the contract's `onReport`. `CRE_ETH_PRIVATE_KEY` reaches the CLI only through a temporary 0600 env file that is deleted after the run. Nothing was deployed to the CRE DON.

| Step | Tx |
|---|---|
| `packages/cre-pricing`, dry run (no `--broadcast`): report signed for 9 currencies, nothing sent, oracle unchanged | — |
| **CRE pricing report → MockKeystoneForwarder → `NorenRateOracle.onReport`**: 9 currencies, rates read live from Chainlink feeds on Arc mainnet at block 29801897 | [0xa7f67bcc…1b64](https://explorer.testnet.arc.io/tx/0xa7f67bcc1b1a7095c1b9ffb9c20a357abea78ddbaa4b1a255b65854633321b64) (1,466,429 gas) |
| **CRE bridge handler 3 (HTTP trigger), kind-2 starter report → `NorenCreditLine.onReport`**: a 1 USDC line for the customer | [0x2b066d78…f42e](https://explorer.testnet.arc.io/tx/0x2b066d786b83c7fbe9d51035fbf543667139c74304e414aa6a91d50fe0f9f42e) (189,193 gas) |
| Operator approves the credit pool | [0x201c7bdd…ebc1](https://explorer.testnet.arc.io/tx/0x201c7bddf53e089e54c354596132f414f630d4d7da330e839ac24042bd21ebc1) |
| Operator funds the credit pool with 1 USDC (`fund`) | [0x6555e644…eb30](https://explorer.testnet.arc.io/tx/0x6555e644e766bad6dc28479854be822ccdd67e9f9eb5a05ec7f7872627faeb30) |
| **Borrower pays 0.50 USDC to the merchant payout from the line (`payInvoice` → `Drawn`)** | [0xa4cff3c4…db79](https://explorer.testnet.arc.io/tx/0xa4cff3c47d71bb93d7f7d1e5519999894d8cbe38f2ea4ef4a56dae55f18edb79) |
| CRE bridge handler 2 (EVM log trigger on that live `Drawn` log) decides there is no write: a starter line has no Robinhood collateral line behind it | — |
| Operator withdraws the unused 0.50 USDC (`withdraw`) | [0x05300f10…17f5](https://explorer.testnet.arc.io/tx/0x05300f102cbaafdddf6fc5ae5ea70d42f6fb6065dbca722b9164c6e45c7b17f5) |

Read back on-chain after the pricing write:
- `quote("EUR", 100.00)` = 112.183642 USDC
- `quote("JPY", 10,000)` = 63.337655 USDC
- A direct `onReport` from a non-forwarder account reverts with `UnauthorizedForwarder` (checked with `eth_call`, so no tx was sent).

The live workflow configs, with the two contract addresses filled in, are `scripts/live/cre/rate-oracle.live.json` and `scripts/live/cre/credit-bridge.live.json`.

Total spend across both scripts: the operator went from 19.700254 to **12.006459 USDC**. That is 7.69 USDC in all, of which about 0.19 USDC was gas.

## What is fork-only or limited, honestly

- **Robinhood Chain side.** It runs on a local Anvil fork of Robinhood Chain mainnet: NorenCredit, NorenGateway, Pay with stocks, Pay later collateral and the Aqua makers. Robinhood testnet has no Chainlink feeds, so none of it is deployed on a public chain. For the same reason, CRE bridge handlers 0 and 1 (`CreditLineOpened`/`Closed` on Robinhood → Arc) and handler 2's write to Robinhood were simulated only on forks (`packages/cre-bridge/scripts/fork-simulate.sh`). On Arc testnet only the starter-line path ran.
- **The starter report has no World ID behind it.** Its nullifier is a labelled test value, `keccak256("noren-live-arc test nullifier, not a World ID proof, …")`. The run shows the CRE → forwarder → NorenCreditLine write path on a public chain. It does not show World ID verification. `config.robinhood.address` in `credit-bridge.live.json` is the sentinel `0x…dEaD`, because the workflow's `validateConfig` requires a non-zero address. Handlers 2 and 3 never write to Robinhood for a starter line.
- **CRE ran in simulation.** `cre workflow simulate --broadcast` signs with the simulator's keys and delivers through the **Mock**KeystoneForwarder. A DON deployment would use KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62` and DON signatures. The workflows are not deployed to the DON.
- **The ASP tree URL is loopback.** The postman served its tree on `127.0.0.1:8801` for the run, so the CIDs in the two `updateRoot` transactions point at a loopback URL. The roots themselves are on-chain and anyone can check them. A public deployment needs `NOREN_TREE_URL` on a public host (`packages/postman/src/main.ts` refuses a non-loopback RPC without one).
- **The anonymity set is tiny.** The live pool holds this run's deposits and nothing else, so on this testnet pool anyone could guess the payer. The privacy comes from the pool's crowd, which grows with real use.
- **No browser in this run.** The proof was made in Node with the same library and circuit artifacts. The hosted checkout and Noren Merchant dashboard (`pnpm dev:stack`) still run against a local Arc fork. The fork suite is also fork-only: `pnpm e2e` (9 Foundry checkout tests with real proofs, 5 attack reverts and a EUR-priced invoice) runs on an Arc testnet fork.
- **No fiat invoice in this run.** The live invoice was priced in USD. EUR pricing and the oracle's `verifyQuote` rate lock run in `pnpm e2e` on a fork. The live NorenRateOracle holds real rates, but no live invoice was checked against it.
