# Chainlink CRE rate oracle

Noren quotes fiat invoices in USDC from Chainlink Data Feeds on Arc mainnet (see [CHAINLINK.md](CHAINLINK.md)). Until now that quote, and the rate lock, lived only in the server. This package moves the rate on-chain. A **Chainlink CRE workflow** reads the feeds on a cron schedule and writes a DON-signed report to **`NorenRateOracle` on Arc Testnet** through the CRE forwarder. Any contract or client can then quote or verify an invoice amount on-chain.

```text
cron ──▶ CRE workflow (TypeScript, WASM)
          ├─ HTTP capability: JSON-RPC to Arc mainnet (read-only, https://arc-rpc.publicnode.com)
          │    1. eth_getBlockByNumber("finalized")      consensus: chain ID identical, block number median
          │    2. eth_call decimals() + latestRoundData() for USDC/USD and 8 fiat/USD proxies,
          │       pinned to that block minus 2            consensus: raw results identical
          ├─ validate: answer > 0, updatedAt != 0, age <= 90,000 s (DON time)
          ├─ EVM read (arc-testnet): NorenRateOracle.roundsFor(codes) → skip if nothing changed
          └─ runtime.report() + EVM writeReport (arc-testnet) ──▶ forwarder ──▶ NorenRateOracle.onReport
```

## Why HTTP instead of the EVM capability for reads

Arc mainnet (chain 5042) is not a CRE EVM target; the SDK's EVM client lists `arc-testnet` but not `arc-mainnet`, and the feeds don't exist on Arc Testnet. So the workflow reads the feeds with the CRE **HTTP capability**, sending JSON-RPC `eth_call` batches. Every DON node sends the same request. The nodes first agree on one block number (median), then read every feed at that block, so honest nodes return byte-identical results. The second step aggregates with `identical`, so a node that returns different data fails consensus instead of moving the median. The write side uses the native EVM capability on `arc-testnet`.

## What is on-chain

`packages/contracts/src/NorenRateOracle.sol` (unaudited):

- `onReport(metadata, report)` accepts calls only from `forwarder`, and optionally only from one workflow owner (`setExpectedWorkflowOwner`, read from the metadata; leave it off in simulation because the mock forwarder sends placeholder metadata). The report is `abi.encode(uint64 sourceChainId, uint64 sourceBlock, address usdcUsdFeed, RateUpdate[] updates)`. It reverts when:
  - the source chain isn't 5042 or the USDC/USD proxy isn't the configured one
  - `sourceBlock` is older than the last report (`OlderReport`), or any round is older than the stored one (`OlderRound`)
  - a currency isn't configured, or its proxy or minor decimals don't match (`FeedMismatch`)
  - an answer is ≤ 0, `updatedAt` is 0, a round is more than 90,000 s old (`StalePrice`) or more than 120 s in the future
  - `rateE18` doesn't equal the value recomputed from the two answers (`RateMismatch`)

  A report with the same rounds is a no-op (`RateUnchanged`).
- `quote(currency, fiatAmount)` returns the USDC base units (rounded up), both round IDs and the older `updatedAt`. It reverts with `StalePrice` when the stored rounds are older than `maxAge`. The formula is the same as `quoteUsdc` in `packages/core/src/pricing.ts`: `ceil(A × F × 10^6 × 10^u / (U × 10^(m+f)))`.
- `quoteAtRounds(currency, fiatAmount, fiatRoundId, usdcRoundId)` and `verifyQuote(…, usdcAmount)` work on any round pair the oracle has recorded. This is the on-chain rate lock: an invoice that stored its two round IDs can be checked against the chain after the rate moves. There's no freshness check here; the invoice's expiry decides how long a lock is valid.
- `roundsFor(codes)`, `latestRate`, `recordedRate`, `rateE18`, `currencies()` are views. `setForwarder`, `setFeed`, `setMaxAge`, `setExpectedWorkflowOwner` and `transferOwnership` are owner-only.

Currencies: USD (a synthetic 1, as in pricing.ts), EUR, GBP, JPY, CAD, AUD, MXN, BRL and KRW. The proxy addresses are in `packages/cre-pricing/rate-oracle/config.staging.json`, the same ones as `packages/core/src/pricing.ts`.

Forwarders on Arc Testnet, from the [CRE forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts). Both have code on Arc Testnet (checked with `cast code`):

| Use | Contract | Address |
|---|---|---|
| `cre workflow simulate --broadcast` | MockKeystoneForwarder | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| Deployed workflows | KeystoneForwarder | `0x76c9cf548b4179F8901cda1f8623568b58215E62` |

## Run it

Needs Foundry, Bun, jq and the CRE CLI (tested with v1.39.0, SDK 1.23.0).

```sh
cd packages/cre-pricing/rate-oracle && bun install && cd ..   # once
./scripts/fork-simulate.sh                                   # full fork run, ~30 s
```

`fork-simulate.sh` takes these steps:

1. Starts Anvil on `127.0.0.1:8710` forking Arc Testnet. The fork contains the real MockKeystoneForwarder.
2. Deploys `NorenRateOracle` with that forwarder, using Anvil's published dev account (fork only).
3. Runs `cre workflow simulate rate-oracle --target local-fork` once without `--broadcast` and checks that the oracle is still empty.
4. Runs it with `--broadcast`.
5. Checks that the transaction went to the forwarder.
6. Checks that a direct `onReport` call reverts.
7. Reads `quote()` for every currency.
8. Simulates again and expects "no write".
9. Kills Anvil.

`NOREN_CRE_FORK_PORT` picks another port in 8710-8719. `NOREN_CRE_CAPTURE=1` rewrites `fixtures/fork-run.json`; the Foundry tests embed that report, so regenerate the test file if you change it.

Tests:

```sh
cd packages/cre-pricing/rate-oracle && bun test                           # 8 tests, live Arc mainnet RPC
cd packages/contracts && forge test --match-contract NorenRateOracle      # 22 tests (2 need Arc mainnet + Arc Testnet RPC)
```

- The Bun tests send the workflow's own JSON-RPC batches to Arc mainnet. When the round IDs match, they check that the USDC amounts equal `packages/core` `quoteUsdc` for EUR, JPY, KRW and GBP. They also cover the stale-round rejection and that the report encoding round-trips. They're named `*_test.ts` so the root Vitest run doesn't collect them.
- The Foundry unit tests use the exact report bytes the CRE simulator delivered on the fork (tx `0x9815b279…08f5`, saved in `fixtures/fork-run.json`). The negative tests change one field of that real report.
- The live suite checks two things:
  - every round in the report against `getRoundData(roundId)` on Arc mainnet
  - that the real Arc Testnet MockKeystoneForwarder delivers the captured raw report to a fresh oracle on an Arc Testnet fork

  There are no mocked feed values anywhere.

## Simulation transcript (Nov 6 2026, local fork of Arc Testnet)

The output below is copied from the script. Repeated build lines (compile, limits, hashes) are left out, and the dry run's per-currency lines are the same as run 1's.

```text
== Arc Testnet fork at http://127.0.0.1:8710 (fork block 70971407), MockKeystoneForwarder has code
== NorenRateOracle deployed on the fork at 0xdc1a7241E726d20d8D94a7b65Cf9a16eAFD8dBf5 (forwarder 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1)
== cre workflow simulate, no --broadcast (dry run: nothing is sent)
2026-11-06T09:51:35Z [USER LOG] Report signed for 9 changed of 9; not broadcast, nothing sent
✓ Workflow Simulation Result:
"{\"status\":\"not-broadcast\",\"sourceBlock\":29780281,\"currencies\":9,\"changed\":[\"USD\",\"EUR\",\"GBP\",\"JPY\",\"CAD\",\"AUD\",\"MXN\",\"BRL\",\"KRW\"]}"
oracle still empty after the dry run (lastSourceBlock 0)
== cre workflow simulate --broadcast (run 1)
✓ Workflow compiled
2026-11-06T09:51:41Z [SIMULATION] Simulator Initialized
2026-11-06T09:51:41Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-11-06T09:51:42Z [USER LOG] Arc mainnet finalized block 29780296; reading feeds at 29780294
2026-11-06T09:51:42Z [USER LOG] USD: 1 USD = 1.00018403386223065 USDC (fiat round 0 @ 1793892429, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:42Z [USER LOG] EUR: 1 EUR = 1.121836417900893764 USDC (fiat round 18446744073709551777 @ 1793927723, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:42Z [USER LOG] GBP: 1 GBP = 1.347682973667154756 USDC (fiat round 18446744073709551624 @ 1793864289, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:42Z [USER LOG] JPY: 1 JPY = 0.006333765412835961 USDC (fiat round 18446744073709551925 @ 1793928855, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:42Z [USER LOG] CAD: 1 CAD = 0.712554339998559734 USDC (fiat round 18446744073709551795 @ 1793936522, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:42Z [USER LOG] AUD: 1 AUD = 0.691117165558462757 USDC (fiat round 18446744073709551866 @ 1793934633, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:42Z [USER LOG] MXN: 1 MXN = 0.053447644366563447 USDC (fiat round 18446744073709551990 @ 1793929917, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:42Z [USER LOG] BRL: 1 BRL = 0.182538317050337262 USDC (fiat round 18446744073709551855 @ 1793892461, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:42Z [USER LOG] KRW: 1 KRW = 0.000736015426838538 USDC (fiat round 18446744073709552101 @ 1793933972, USDC round 36893488147419103337 @ 1793892429)
2026-11-06T09:51:43Z [USER LOG] NorenRateOracle updated: 9 changed of 9, tx 0xc7e071a8747c1efdf7882130be930338a83ab373ddce68dee324a367667ced05
✓ Workflow Simulation Result:
"{\"status\":\"written\",\"sourceBlock\":29780294,\"currencies\":9,\"changed\":[\"USD\",\"EUR\",\"GBP\",\"JPY\",\"CAD\",\"AUD\",\"MXN\",\"BRL\",\"KRW\"],\"txHash\":\"0xc7e071a8747c1efdf7882130be930338a83ab373ddce68dee324a367667ced05\"}"
== Forwarder transaction 0xc7e071a8747c1efdf7882130be930338a83ab373ddce68dee324a367667ced05 on the fork
status true, to 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1 (MockKeystoneForwarder), block 70971409, timestamp 1793938900, gas used 1466417
== A direct onReport call from a non-forwarder account must revert
reverted as expected: ... execution reverted: custom error 0xfa4c7361: 000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266... (UnauthorizedForwarder selector 0xfa4c7361)
== On-chain state after run 1
lastSourceBlock (Arc mainnet block the feeds were read at): 29780294
quote(USD, 10000 minor units = 100 USD) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 100018404 0 36893488147419103337 1793892429
quote(EUR, 10000 minor units = 100 EUR) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 112183642 18446744073709551777 36893488147419103337 1793892429
quote(GBP, 10000 minor units = 100 GBP) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 134768298 18446744073709551624 36893488147419103337 1793864289
quote(JPY, 100 minor units = 100 JPY) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 633377 18446744073709551925 36893488147419103337 1793892429
quote(CAD, 10000 minor units = 100 CAD) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 71255434 18446744073709551795 36893488147419103337 1793892429
quote(AUD, 10000 minor units = 100 AUD) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 69111717 18446744073709551866 36893488147419103337 1793892429
quote(MXN, 10000 minor units = 100 MXN) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 5344765 18446744073709551990 36893488147419103337 1793892429
quote(BRL, 10000 minor units = 100 BRL) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 18253832 18446744073709551855 36893488147419103337 1793892429
quote(KRW, 100 minor units = 100 KRW) -> usdcAmount fiatRound usdcRound oldestUpdatedAt: 73602 18446744073709552101 36893488147419103337 1793892429
RateUpdated events: 9
== cre workflow simulate --broadcast (run 2: same rounds expected, no write)
2026-11-06T09:51:48Z [USER LOG] Arc mainnet finalized block 29780308; reading feeds at 29780306
2026-11-06T09:51:48Z [USER LOG] All 9 rates already on-chain at these rounds; no write
✓ Workflow Simulation Result:
"{\"status\":\"unchanged\",\"sourceBlock\":29780306,\"currencies\":9}"
```

## What this proves, and what it doesn't

The run shows:

- The CRE workflow compiles to WASM and runs in the official simulator.
- It reads live Chainlink rounds from Arc mainnet over the HTTP capability.
- The report goes through the real MockKeystoneForwarder on (a fork of) Arc Testnet, and `NorenRateOracle` stores the rates.
- `quote()` returns the same USDC amounts as Noren's off-chain `quoteUsdc` for the same rounds.

The limits:

- **Simulation trust.** The MockKeystoneForwarder checks no DON signatures, so anyone can call it. An oracle pointed at the mock is for simulation only. Real use needs `setForwarder(0x76c9cf548b4179F8901cda1f8623568b58215E62)` (the KeystoneForwarder, which verifies DON signatures), a deployed workflow, and then `setExpectedWorkflowOwner`.
- **Consensus in simulation is single-node.** The median and identical aggregation code paths run, but only one node contributes.
- **The write ran on a local fork, not on public Arc Testnet.** All addresses and tx hashes above are fork-only.
- **BLOCKED: public Arc Testnet broadcast.** It needs a funded Arc Testnet key. Nick gets testnet USDC from the Circle faucet (`https://faucet.circle.com`, Arc Testnet) for a fresh key, and puts that key in the gitignored `packages/cre-pricing/.env` as `CRE_ETH_PRIVATE_KEY`. Then:
  1. Deploy `NorenRateOracle` with the mock forwarder on `https://rpc.testnet.arc.io`.
  2. Set `oracle.address` in `config.staging.json`.
  3. Run `cre workflow simulate rate-oracle --target staging-settings --non-interactive --trigger-index 0 --broadcast`.

  Without the address, the staging run fails with `Setup required: config.oracle.address`.
- **Not deployed to the CRE DON.** That needs deploy access (`cre account access`) and Nick's go-ahead.
- **The checkout doesn't call the oracle yet.** `NorenCheckout.sol` is unchanged. `verifyQuote` / `quoteAtRounds` give the server, or a future checkout version, an on-chain check of an invoice's locked amount. The settlement contract doesn't enforce it today.
- **Staleness.** USDC/USD on Arc mainnet updates on its 86,400 s heartbeat. `quote()` reverts once either stored round is older than `maxAge` (90,000 s), so the workflow must keep running.
- **Gas.** The first write of all 9 currencies used 1,466,417 gas. A write with no changed rounds is skipped by the workflow. A report where some rounds changed rewrites only those currencies.
