/**
 * Reads for "your deposit is 1inch Aqua liquidity": a Noren maker (an Earn deposit vault or the lender pool) and its
 * Aqua strategies on NorenLiquidity, with realised fees from the chain. Everything comes from contract reads and the
 * MakerFill / MakerSale logs; nothing is projected.
 */
import { parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import type { Wallet } from "./NorenApp";

export const liquidityAbi = parseAbi([
  "function strategiesOf(address maker) view returns (bytes32[])",
  "function strategy(bytes32 strategyHash) view returns ((address maker, address asset, bool active, uint16 bidSpreadBps, uint16 askSpreadBps, uint64 registeredAt, uint32 fills, uint256 volumeUsdg, uint256 feesUsdg, bytes data))",
  "function balances(bytes32 strategyHash) view returns (uint256 usdgBalance, uint256 assetBalance)",
  "function makerFeesUsdg(address maker) view returns (uint256)",
]);
const fillEv = parseAbiItem("event MakerFill(bytes32 indexed strategyHash, address indexed maker, address indexed asset, address taker, uint256 assetIn, uint256 usdgOut, uint256 oracleValueUsdg, uint256 feeUsdg)");
const saleEv = parseAbiItem("event MakerSale(bytes32 indexed strategyHash, address indexed maker, address indexed asset, address taker, uint256 assetOut, uint256 usdgIn, uint256 oracleValueUsdg, uint256 feeUsdg)");

export type MakerStrategy = { hash: Hex; asset: Address; active: boolean; bidBps: number; askBps: number; fills: number; volumeUsdg: bigint; feesUsdg: bigint; aquaUsdg: bigint; aquaAsset: bigint };
export type MakerFillRow = { kind: "buy" | "sell"; asset: Address; taker: Address; amount: bigint; usdg: bigint; feeUsdg: bigint; tx: Hex; block: bigint };
export type MakerView = { maker: Address; strategies: MakerStrategy[]; feesUsdg: bigint; fills: MakerFillRow[] };

/** One maker's Aqua strategies, live balances and its last fills (newest first). */
export async function readMaker(w: Wallet, maker: Address): Promise<MakerView> {
  const liq = w.oc.credit?.aquaLiquidity as Address | undefined;
  if (!liq) throw new Error("Setup required: NorenLiquidity (the Aqua maker registry) isn't in this stack's config (pnpm dev:all)");
  const { pub } = w.oc.robinhood();
  const from = w.oc.credit?.robinhoodFromBlock ? BigInt(w.oc.credit.robinhoodFromBlock) : 0n;
  const [hashes, feesUsdg, buys, sells] = await Promise.all([
    pub.readContract({ address: liq, abi: liquidityAbi, functionName: "strategiesOf", args: [maker] }),
    pub.readContract({ address: liq, abi: liquidityAbi, functionName: "makerFeesUsdg", args: [maker] }),
    pub.getLogs({ address: liq, event: fillEv, args: { maker }, fromBlock: from, toBlock: "latest" }),
    pub.getLogs({ address: liq, event: saleEv, args: { maker }, fromBlock: from, toBlock: "latest" }),
  ]);
  const strategies = await Promise.all(hashes.map(async (h) => {
    const [s, b] = await Promise.all([
      pub.readContract({ address: liq, abi: liquidityAbi, functionName: "strategy", args: [h] }),
      pub.readContract({ address: liq, abi: liquidityAbi, functionName: "balances", args: [h] }).catch(() => [0n, 0n] as const),
    ]);
    return { hash: h, asset: s.asset, active: s.active, bidBps: s.bidSpreadBps, askBps: s.askSpreadBps, fills: s.fills, volumeUsdg: s.volumeUsdg, feesUsdg: s.feesUsdg, aquaUsdg: b[0], aquaAsset: b[1] };
  }));
  const fills: MakerFillRow[] = [
    ...buys.map((l) => ({ kind: "buy" as const, asset: l.args.asset!, taker: l.args.taker!, amount: l.args.assetIn!, usdg: l.args.usdgOut!, feeUsdg: l.args.feeUsdg!, tx: l.transactionHash!, block: l.blockNumber! })),
    ...sells.map((l) => ({ kind: "sell" as const, asset: l.args.asset!, taker: l.args.taker!, amount: l.args.assetOut!, usdg: l.args.usdgIn!, feeUsdg: l.args.feeUsdg!, tx: l.transactionHash!, block: l.blockNumber! })),
  ].sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
  return { maker, strategies, feesUsdg, fills };
}
