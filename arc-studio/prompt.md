You are building **Noren** in Arc Studio: private USDC payments on Arc. A customer pays a merchant's invoice from a Privacy Pools (0xbow / Ethereum Foundation Kohaku) shielded pool, so the merchant gets USDC and a receipt but never the payer's address or history. Noren's off-chain stack (merchant server, ASP postman, SDK, dashboard and hosted checkout) lives in its own repository. In this Studio app we import, compile and test the Arc contracts, verify the live Arc testnet deployment against them, and give them a small live console.

## Files you have

- `contracts/noren/*.sol` are flattened sources (solc 0.8.28). The only change from `forge flatten` output: Privacy Pools' `interface IState` was moved above `IPrivacyPool` so solc accepts the order. Compiled with the settings below, every file gives bytecode identical to the Noren repo's build:
  - `PoseidonT3.sol`, `PoseidonT4.sol`: external Poseidon libraries.
  - `WithdrawalVerifier.sol`, `CommitmentVerifier.sol`: Groth16 verifiers for the 0xbow circuits.
  - `Entrypoint.sol`: 0xbow Privacy Pools Entrypoint (UUPS, behind a proxy).
  - `ERC1967Proxy.sol`: OpenZeppelin proxy.
  - `PrivacyPoolComplex.sol`: the ERC-20 (USDC) pool. It links PoseidonT3 and PoseidonT4.
  - `NorenCheckout.sol`: Noren's invoice-bound processooor. `pay(withdrawal, proof)` is relayed by the merchant. `refund(invoiceId, amount)` deposits into the customer's precommitment.
  - `NorenQuoter.sol`: a view-only Chainlink fiat-to-USDC quoter, meant for Arc mainnet feeds.
  - If present, `NorenRateOracle.sol` (FX rates written by a Chainlink CRE workflow through `onReport`) and `NorenCreditLine.sol` (a credit line written by CRE `onReport`, with `payInvoice` and `repay`).
- `context/ref/` is reference only: Noren's architecture doc, the Arc prize mapping, the fork test with real Groth16 proofs (`NorenCheckout.t.sol`) and the repo's deploy script (`deploy-arc.ts`), which made the live deployment in C.

## Rules

1. **Do not edit anything in `contracts/noren/`.** The Privacy Pools code is upstream (Apache-2.0) and Noren's contracts are tested against it. If something fails to compile, stop and report the exact compiler error. Don't patch around it.
2. Compiler: solc 0.8.28, optimizer on, 10000 runs, `bytecode_hash = "none"`, `cbor_metadata = false`, via-IR off. The flattened files repeat some declarations (for example IERC20), so use fully qualified names (`contracts/noren/X.sol:X`) where needed.
3. **No fake success.** Never mock a Groth16 proof or claim the private payment path was proven here. The real-proof path is tested in the Noren repo on an Arc testnet fork (`context/ref/NorenCheckout.t.sol`). Here we test the non-proof guards and the deployment wiring.

## Tasks

### A. Compile
Compile everything and report the contract sizes. Entrypoint and PrivacyPoolComplex must be under the 24,576-byte limit.

### B. Foundry tests (`test/noren/`)
Use a minimal test ERC-20 in place of USDC, inside the tests only. In `setUp`, deploy the stack in the order of `deploy-arc.ts`: PoseidonT3, PoseidonT4, WithdrawalVerifier, CommitmentVerifier, Entrypoint implementation, `ERC1967Proxy(implementation, abi.encodeCall(Entrypoint.initialize, (owner, postman)))`, `PrivacyPoolComplex(entrypoint, withdrawalVerifier, commitmentVerifier, token)` linking both Poseidon libraries, `Entrypoint.registerPool(token, pool, 1000000, 0, 500)`, then `NorenCheckout(entrypoint, pool, token)`. Then assert:
- Entrypoint `assetConfig(token).pool == pool`, `pool.ENTRYPOINT() == entrypoint`, `pool.ASSET() == token`, `checkout.pool() == pool`, `checkout.entrypoint() == entrypoint`.
- `registerMerchant(address(0))` reverts `InvalidPayout`. `registerMerchant(payout)` sets `merchantPayout` and emits `MerchantRegistered`.
- `pay` reverts with:
  - `WrongProcessooor` when `withdrawal.processooor != checkout`
  - `InvalidData` when `data.length != 192`
  - `InvalidInvoice` for a zero invoice id
  - `Expired` after expiry
  - `UnknownMerchant` for an unregistered merchant
  - `NotMerchant` when someone other than the merchant relays
- `refund` on an unpaid invoice reverts `NotPaid`.
- Only the `ASP_POSTMAN` role can call `Entrypoint.updateRoot`.

Run the tests and report the pass count.

### C. The live deployment on Arc testnet (chain 5042002): verify, do not redeploy
Noren's operator `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80` (NOREN_OPS) already deployed these contracts on Arc testnet from the same bytecode, in the order of `context/ref/deploy-arc.ts`. **Do not deploy anything.** USDC is `0x3600000000000000000000000000000000000000` (6 decimals; native gas is USDC).

| Contract | Address |
|---|---|
| Entrypoint (ERC1967Proxy) | `0xa22f3200ecb4319b48dca49677c2f73cd7260ad5` |
| PrivacyPoolComplex (USDC) | `0x393d8d46e1dff8a719820e36d70ba509896ea57d` |
| NorenCheckout | `0xe18a80506fdb7f5498aad7387a21134118a77547` |
| WithdrawalVerifier | `0x015306ac6f866bf9b2dd157a79d65159697fb4cf` |
| CommitmentVerifier | `0xe57a438a8ded2ad7d1a12ddf497a0da0bd2d2ba3` |
| NorenRateOracle | `0xdb828bdcf33ef0a5a32861e4831ff3dd87be831c` |
| NorenCreditLine | `0x7140aad0bb38dc6908a857b446897c78b0d88876` |

The CRE forwarder for both oracle and credit line is Arc testnet's MockKeystoneForwarder `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`. The pool's deployment block is 70991810.

Read the wiring back on-chain with `cast` against `https://rpc.testnet.arc.io` (read-only calls only): the same checks as in B, plus `forwarder()` on the oracle and credit line, and the runtime bytecode at each address against your compiled `deployedBytecode` (ignore immutable and linked-library slots; for the Entrypoint, compare the implementation behind the proxy). Report a table: contract, address, explorer link (`https://explorer.testnet.arc.io/address/<address>`), and whether each check passed.

### D. A small live console (the app preview)
This is a single page titled "Noren on Arc", using Noren's palette: navy `#1c2a5e` / ink `#17203f` on linen `#f4efe4`, white cards `#fffdf8`, accent `#d9772f`, font Geist or Inter. It must work at 375px wide. It reads the live contracts listed in C from Arc testnet (`https://rpc.testnet.arc.io`; scan logs from block 70991810 in chunks of at most 5,000 blocks):
- **Header:** chain, a link to each contract on the explorer, and the USDC pool balance (`USDC.balanceOf(pool)`).
- **Privacy pool:** the count of `Deposited` events and the Entrypoint's `latestRoot()`.
- **Payments:** a live feed of NorenCheckout `Paid(invoiceId, merchant, amount, receiptCommitment)` and `Refunded` events. Show the amount in USDC (6 decimals), the merchant and a shortened invoice id. Show a clear empty state ("No private payments yet") rather than placeholder rows.
- **Merchant registration:** connect a wallet and call `registerMerchant(payout)`, with readable errors.

No mock data. If an RPC read fails, show the error.

When you're done, summarise: compile status, the test pass count, the on-chain verification table, and anything you could not do and why.
