# World is Flat edition: Robinhood Chain only

This edition uses Robinhood Chain mainnet (4663) and the real $WIF ERC-20 at `0x5173b8eA6923c2d40267890D45C46a3480954773`. It does not use Arc, CCTP, or the privacy pool. The project name and logo remain Noren.

## On-chain route and flywheel

`NorenGateway.pay` accepts $WIF, USDG, ETH, or an approved Stock Token. For $WIF it uses `NorenWifRouter` to make two swaps in one Uniswap v4 PoolManager unlock: exact-output WIF → ETH, then ETH → exact invoice USDG. The gateway checks `maxAssetIn` against the WIF actually spent, returns unused WIF, transfers the invoice amount to the merchant, and records the paid invoice. The display quote uses the live v4 `getSlot0` prices with a 3% cushion; the execution bound is the caller's `maxAssetIn`.

Pool keys verified on chain on November 8, 2026:

| Pool | Key `(currency0, currency1, fee, tickSpacing, hooks)` | Pool ID |
|---|---|---|
| ETH/WIF | `(0x0, WIF, 0, 200, 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044)` | `0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79` |
| ETH/USDG | `(0x0, USDG, 500, 10, 0x0)` | `0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982` |

The WIF key and PoolManager callback pattern are credited to [Noroshi](https://github.com/nickthelegend/noroshi), MIT licensed. The ETH/USDG pool returned an in-range liquidity reading and a successful 100 USDG exact-input and exact-output quote through the deployed V4Quoter.

With the WIF router enabled, non-WIF invoice payments pay a default 30 bps protocol fee in USDG. The owner may set 0–100 bps and choose the burn share (default 100%). A WIF payment has 0 bps. Fee USDG accrues in the gateway; anyone can call `burnAccrued(minWifOut)` once the threshold is met. It swaps accrued USDG → ETH → WIF through the same live pools, pays a default 1% WIF keeper tip, calls `WIF.burn` on the rest, increments `totalWifBurned`, and emits `WifBurned(bytes32(0), usdgIn, wifBurned)`. Batch burning keeps tiny invoice payments from each paying for two extra swaps. The mainnet script sets the threshold to 0.05 USDG so a 25 USDG Stock Token demo payment can trigger a burn. The owner may change it later. Credit invoice payments contribute from the existing credit merchant fee.

Stock Token use is restricted by the issuer's [current jurisdiction list](https://docs.robinhood.com/rhj/restricted-jurisdictions/). The WIF checkout requires eligibility confirmation before it enables NVDA payment. The Stock Token contract and Noren oracle enforce the chain's transfer restrictions too.

## Fork end to end

From the repository root, install dependencies and build the SwapVM artifact (the existing Robinhood harness needs it):

```sh
CI=true pnpm install --frozen-lockfile
cd packages/aqua/swapvm-ext && forge build
cd ../../robinhood/contracts
forge test --match-contract NorenWifRouterTest
forge test --match-contract NorenWifEditionTest --fork-url https://rpc.mainnet.chain.robinhood.com
```

Use the latest block. The public RPC prunes older state. The complete Robinhood suite uses `sh packages/robinhood/scripts/test-fork.sh` from the root, which starts a fresh Anvil fork.

To run the browser against a **local fork deployment**, start `packages/robinhood/scripts/fork.sh`, fund an ephemeral fork deployer with ETH, 60 USDG and 10,000 WIF on that fork, then run `DeployWif.s.sol` with `--broadcast` against the local Anvil URL. Set `NOREN_WIF_GATEWAY` to the printed gateway address, `NOREN_RH_RPC_URL` and `VITE_NOREN_RH_RPC` to the browser-reachable fork RPC, and `NOREN_WIF_DEPLOY_BLOCK` to its deployment block. Start the WIF server and web app:

```sh
NOREN_EDITION=wif pnpm --filter @noren/server start
NOREN_EDITION=wif pnpm --filter @noren/web dev
NOREN_EDITION=wif pnpm --filter @noren/web build
```

The WIF build serves only the Robinhood payment and burn pages. The merchant dashboard reads `totalWifBurned`, accrued USDG, recent `WifBurned` logs and merchant invoice logs from chain. The receipt reads the on-chain invoice status and burn data. The server only supplies public chain configuration; it starts no Arc services.

## Mainnet transaction checklist

**Do not run the script until Nick supplies a funded deployer and approves mainnet broadcast.** The script checks its ETH, USDG and WIF balances before starting a broadcast. When funding is short it prints only the deployer address. It does not log the key or balances. Keep the app and server live through **November 16, 2026 at 17:30 UTC**.

1. Deploy with `forge script script/DeployWif.s.sol:DeployWif --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast`. Record gateway `________` and deploy transactions: `https://robinhoodchain.blockscout.com/tx/________`.
2. Merchant creates a 10 USDG invoice on the WIF dashboard. Invoice ID `________`; tx `https://robinhoodchain.blockscout.com/tx/________`.
3. Customer pays that invoice in $WIF (zero protocol fee). Tx `https://robinhoodchain.blockscout.com/tx/________`.
4. Merchant creates a 25 USDG invoice. Invoice ID `________`; tx `https://robinhoodchain.blockscout.com/tx/________`.
5. An eligible customer pays the second invoice with NVDA Stock Tokens. Tx `https://robinhoodchain.blockscout.com/tx/________`. Confirm the merchant's USDG balance rose by 25 and the gateway accrued 0.075 USDG.
6. Any account calls `burnAccrued(minWifOut)` with a fresh minimum-output quote. Tx `https://robinhoodchain.blockscout.com/tx/________`. Confirm `WifBurned`, `totalWifBurned`, and the matching reduction in WIF total supply.
7. Record the demo video link `________`, public repo link `https://github.com/nickthelegend/noren`, hosted app `________`, and keep the app live until the deadline above.
