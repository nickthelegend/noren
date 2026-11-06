// Quote a cross-chain swap with the Noren SDK (xchain-demo.sh checks the SDK against the real fill).
// usage: tsx scripts/sdk-quote.ts <sourceRpc> <arcRpc> <escrow> <settler> <tokenIn> <strategyHash> <amountIn>
import { createPublicClient, http, type Address, type Hex } from "viem";
import { quoteCrossChainSwap } from "../sdk/index.ts";

const [sourceRpc, arcRpc, escrow, settler, tokenIn, strategyHash, amountIn] = process.argv.slice(2);
if (!amountIn) throw new Error("usage: sdk-quote.ts <sourceRpc> <arcRpc> <escrow> <settler> <tokenIn> <strategyHash> <amountIn>");
const q = await quoteCrossChainSwap({
  source: createPublicClient({ transport: http(sourceRpc) }),
  arc: createPublicClient({ transport: http(arcRpc) }),
  escrow: escrow as Address,
  settler: settler as Address,
  tokenIn: tokenIn as Address,
  strategyHash: strategyHash as Hex,
  amountIn: BigInt(amountIn),
});
console.log(JSON.stringify(q, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
