/** The Robinhood package's SDK (`@noren/robinhood/sdk`), wired to the browser's test key and the fork addresses in /config. */
import { createNorenRobinhood, USDG, WETH } from "@noren/robinhood/sdk";
import type { Address } from "viem";
import type { Wallet } from "./NorenApp";

export function rhSdk(w: Wallet) {
  const c = w.oc.credit;
  if (!c?.creditContract || !c.stockOracle || !c.gateway) throw new Error("Setup required: NorenCredit, NorenAssetOracle and NorenGateway aren't deployed on the Robinhood fork (pnpm dev:all)");
  const { pub, wallet } = w.oc.robinhood();
  return createNorenRobinhood({
    publicClient: pub as never, walletClient: wallet as never,
    addresses: { oracle: c.stockOracle, vault: c.vault as Address, gateway: c.gateway, credit: c.creditContract, usdg: USDG, weth: WETH, liquidity: c.aquaLiquidity as Address | undefined, aqua: c.aqua as Address | undefined },
  });
}
export type RhSdk = ReturnType<typeof rhSdk>;
export type Positions = Awaited<ReturnType<RhSdk["readPositions"]>>;
