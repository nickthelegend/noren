# Phase 2 test results

Run on 2026-11-06 (local Arc testnet fork at chain 5042002; no public transactions). Commands:

```sh
pnpm install --store-dir '/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.pnpm-store'
pnpm test
pnpm exec tsc --noEmit
pnpm e2e
```

`pnpm test`: **7 passed, 0 failed** across 2 Vitest files (3 core encoding cases, 4 server validation cases). `pnpm exec tsc --noEmit`: passed. The e2e command ran **9 Foundry tests passed, 0 failed, 0 skipped** against the real 0xbow pool and Groth16 verifier using a fresh Kohaku proof.

The full e2e finished in **40.78 s**. A 20 USDC shield deposit used **352,744 gas** with the fork-only USDC shim. The first 7.50 USDC invoice proof took **1.245 s** with the artifact cache warm; after a new ASP root, re-proving took **1.080 s**. The merchant paid through the HTTP server, refunded 2.50 USDC, and the customer's separate refund account showed 2.50 as pending and then approved after the postman published a new root. A separate pool deposit from an address marked blacklisted in the fork USDC shim left the ASP root unchanged.

Exact on-chain revert checks: stale ASP root → `IncorrectASPRoot`, altered payee → `ContextMismatch`, outsider relay → `NotMerchant`, expired invoice → `Expired`, replay → `AlreadyPaid`. Each check also submitted a transaction and observed a reverted receipt. The stale-root proof was regenerated and then paid successfully.

Selected local-fork transaction hashes from this run:

| Action | Hash |
| --- | --- |
| 20 USDC shield | `0xb593120a56f9b99fa9697fc2f39a6da349020063079f1d1e7a900feaffb27031` |
| Blacklisted pool deposit | `0xb27f31503444c3086490cf9837d3bc5b6aafdcd915b33dddbe2d1db949ea7ca0` |
| Initial ASP root | `0x03516fd26a16db9fec842711d75a8461f3a9d507aef3c855cd1a9d3dc9116134` |
| New ASP root | `0xe67ea8c756d8c217eb7980787cb2af1dc59fb46d1eb1af12dde26df2d609e078` |
| Merchant payment | `0x8106fc58cafad0d7d6690b271b0feab14e74db61a1752db31f15b67a2614398d` |
| Refund approval | `0x137f2c2e5d67d59e730539e20234d226d9b06b3d580267d704084252df38225d` |
| Refund deposit | `0xa0f9e67cdb3f704fc83f2df8a3cf780f7b9891baee6c1bf47a83d9ef3ef8d41e` |
| Refund ASP root | `0xf46913daf1026ea0bda460e94fa5f9bad9cdbcbbf68709d4c0e7fc6a3e3779da` |

The Anvil-only USDC shim is necessary because stock Anvil cannot execute Arc's native USDC bridge; the pool, Entrypoint, and verifiers were not mocked. These hashes disappear when the fork exits. Live Arc gas and browser proving time remain unmeasured. Arc testnet deployment was intentionally not attempted.
