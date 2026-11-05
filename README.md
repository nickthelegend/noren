# Noren (暖簾)

**Private checkout for merchants on Arc.** A customer pays in USDC from a Kohaku shielded balance; the merchant gets paid and can refund; nobody, the merchant included, learns who the customer is.

- **Invoice-bound proofs.** The customer's Privacy Pools withdrawal proof binds the invoice, the merchant, the amount and the refund address. Change any field and the pool rejects it (`ContextMismatch`).
- **The merchant relays.** The merchant's server submits the payment and pays about $0.01 of USDC gas on Arc: the customer needs no gas, no public wallet, and no relayer company.
- **Private refunds.** The merchant refunds into the customer's shielded "refund inbox". The customer's Kohaku wallet discovers it automatically; the merchant never learns who they refunded and can't take it back.
- **Selective receipts.** A receipt commitment the customer can later open for warranty or tax.

Built on the Ethereum Foundation's [Kohaku](https://github.com/ethereum/kohaku) SDK and 0xbow's [Privacy Pools](https://github.com/0xbow-io/privacy-pools-core) (Apache-2.0, see NOTICE). Proofs are made on the customer's device.

## Status
Feasibility spike **passed** on a local fork of Arc testnet (chain 5042002): see [SPIKE.md](SPIKE.md). Proof generation ~2 s on a laptop; checkout withdrawal 583k gas; 9/9 Foundry tests against the real Groth16 verifier and pool with real proofs. Next: live Arc testnet deployment (needs testnet USDC from the Circle faucet), the merchant console and customer app.

```sh
pnpm install
pnpm spike     # anvil fork of Arc testnet → deploy Privacy Pools + NorenCheckout → shield → invoice-bound proof → pay → refund → forge tests
```

MIT © 2026 Nivesh Gajengi (Noren code). Vendored Privacy Pools contracts keep their Apache-2.0 headers.
