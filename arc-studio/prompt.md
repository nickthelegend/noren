You are building **Noren** in Arc Studio: private USDC payments on Arc. A customer pays a merchant's invoice from a Privacy Pools (0xbow / Ethereum Foundation Kohaku) shielded pool, so the merchant gets USDC and a receipt but never the payer's address or history. Noren's off-chain stack (merchant server, ASP postman, SDK, dashboard and hosted checkout) lives in its own repository. In this Studio app we import, compile, test and deploy the Arc contracts, and give them a small live console.

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
- `context/ref/` is reference only: Noren's architecture doc, the Arc prize mapping, the fork test with real Groth16 proofs (`NorenCheckout.t.sol`) and the repo's deploy script (`deploy-arc.ts`). Follow its deployment order exactly.

## Rules

1. **Do not edit anything in `contracts/noren/`.** The Privacy Pools code is upstream (Apache-2.0) and Noren's contracts are tested against it. If something fails to compile, stop and report the exact compiler error. Don't patch around it.
2. Compiler: solc 0.8.28, optimizer on, 10000 runs, `bytecode_hash = "none"`, `cbor_metadata = false`, via-IR off. The flattened files repeat some declarations (for example IERC20), so use fully qualified names (`contracts/noren/X.sol:X`) where needed.
3. **No fake success.** Never mock a Groth16 proof or claim the private payment path was proven here. The real-proof path is tested in the Noren repo on an Arc testnet fork (`context/ref/NorenCheckout.t.sol`). Here we test the non-proof guards and the deployment wiring.

## Tasks

### A. Compile
Compile everything and report the contract sizes. Entrypoint and PrivacyPoolComplex must be under the 24,576-byte limit.

### B. Foundry tests (`test/noren/`)
Use a minimal test ERC-20 in place of USDC, inside the tests only. Deploy the stack the same way as in C, then assert:
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

### C. Deploy to Arc testnet (chain 5042002)
- USDC is `0x3600000000000000000000000000000000000000` (6 decimals; native gas is USDC).
- Noren's operator address is `0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80` (call it NOREN_OPS).

Deploy in this exact order:
1. `PoseidonT3`, then `PoseidonT4`.
2. `WithdrawalVerifier`, then `CommitmentVerifier`.
3. `Entrypoint` (the implementation).
4. `ERC1967Proxy(implementation, abi.encodeCall(Entrypoint.initialize, (STUDIO_DEPLOYER, NOREN_OPS)))`. The owner is your deployer wallet and the ASP postman is NOREN_OPS. This proxy is "the Entrypoint" from here on.
5. `PrivacyPoolComplex(entrypoint, withdrawalVerifier, commitmentVerifier, USDC)`, linking PoseidonT3 and PoseidonT4.
6. `Entrypoint.registerPool(USDC, pool, 1000000, 0, 500)` from the owner.
7. `NorenCheckout(entrypoint, pool, USDC)`.
8. `Entrypoint.grantRole(keccak256("OWNER_ROLE"), NOREN_OPS)`. Don't renounce your own role.
9. If present: deploy `NorenRateOracle` and `NorenCreditLine` with the constructor arguments their NatSpec documents. If an argument is a CRE forwarder or another address you can't find in the source, stop and ask. Don't guess.

After deploying, read the wiring back on-chain (the same checks as in B) and list every contract with its address, deploy tx hash and explorer link. If your wallet lacks testnet USDC for gas, say exactly how much you need and stop. Don't simulate a deployment.

### D. A small live console (the app preview)
This is a single page titled "Noren on Arc", using Noren's palette: navy `#1c2a5e` / ink `#17203f` on linen `#f4efe4`, white cards `#fffdf8`, accent `#d9772f`, font Geist or Inter. It must work at 375px wide. It reads the contracts deployed in C from Arc testnet:
- **Header:** chain, a link to each contract on the explorer, and the USDC pool balance (`USDC.balanceOf(pool)`).
- **Privacy pool:** the count of `Deposited` events and the Entrypoint's `latestRoot()`.
- **Payments:** a live feed of NorenCheckout `Paid(invoiceId, merchant, amount, receiptCommitment)` and `Refunded` events. Show the amount in USDC (6 decimals), the merchant and a shortened invoice id. Show a clear empty state ("No private payments yet") rather than placeholder rows.
- **Merchant registration:** connect a wallet and call `registerMerchant(payout)`, with readable errors.

No mock data. If an RPC read fails, show the error.

When you're done, summarise: compile status, the test pass count, the deployment table, and anything you could not do and why.
