/**
 * Swap on Robinhood Chain: best execution between two real venues, on the local snapshot fork of mainnet.
 * - 1inch Aqua makers (SwapVM, Chainlink-pegged, registered in NorenLiquidity). Sells go through
 *   NorenLiquidity.sellExactAsset; buys go straight to the maker's SwapVM order (makers only sell stock they hold).
 * - Uniswap v4: the official V4Quoter, and the official Universal Router (V4_SWAP) through Permit2.
 * Every number is an eth_call or a receipt on the fork. A venue that can't quote says why; nothing is estimated.
 */
import { encodeAbiParameters, encodePacked, erc20Abi, maxUint256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { Onchain } from "../onchain";
import { USDG, creditOf } from "../onchain";
import type { Config } from "../api";
import { WETH, type Token } from "./tokens";

export const V4_QUOTER: Address = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
export const UNIVERSAL_ROUTER: Address = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** Fee tier, tick spacing: the standard v4 pools with no hooks. */
const TIERS: [number, number][] = [[3000, 60], [500, 10], [10000, 200], [100, 1]];

const liquidityAbi = parseAbi([
  "function bestQuoteForAsset(address asset, uint256 assetIn) view returns (bytes32 strategyHash, uint256 usdgOut)",
  "function strategiesFor(address asset) view returns (bytes32[])",
  "function order(bytes32 strategyHash) view returns ((address maker, uint256 traits, bytes data))",
  "function strategy(bytes32 strategyHash) view returns ((address maker, address asset, bool active, uint16 bidSpreadBps, uint16 askSpreadBps, uint64 registeredAt, uint32 fills, uint256 volumeUsdg, uint256 feesUsdg, bytes data))",
  "function router() view returns (address)",
  "function oracle() view returns (address)",
  "function sellExactAsset(address asset, uint256 assetIn, uint256 minUsdgOut, address to) returns (uint256 usdgOut, bytes32 strategyHash)",
]);
const routerAbi = parseAbi([
  "function quote((address maker, uint256 traits, bytes data) order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
  "function swap((address maker, uint256 traits, bytes data) order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
]);
const oracleAbi = parseAbi([
  "function valueUsd8(address asset, uint256 amount) view returns (uint256)",
  "function usd8ToUsdg(uint256 usd8, uint8 r) view returns (uint256)",
  "function usdgToUsd8(uint256 amountUsdg, uint8 r) view returns (uint256)",
  "function assetForUsd8(address asset, uint256 usd8, uint256 spreadBps) view returns (uint256 amount, (uint256 usd8, uint256 updatedAt, uint80 roundId, bool marketClosed) p)",
  "function price(address asset) view returns ((uint256 usd8, uint256 updatedAt, uint80 roundId, bool marketClosed))",
]);
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)", "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const wethAbi = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type RouteQuote =
  | { id: "aqua"; out: bigint; strategyHash: Hex; maker: Address; spreadBps: number; order?: { maker: Address; traits: bigint; data: Hex } }
  | { id: "v4"; out: bigint; key: PoolKey; zeroForOne: boolean; gasEstimate: bigint };
export type RouteMiss = { id: "aqua" | "v4"; error: string };
export type SwapQuote = { routes: (RouteQuote | RouteMiss)[]; best: RouteQuote | null; fair: bigint | null; marketClosed: boolean; at: number };

/** The ERC-20 a token trades as (ETH is wrapped). */
const erc = (t: Token) => (t.native ? WETH : t.address);
const short = (e: unknown) => {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return m.split("\n")[0].replace(/^The contract function "\w+" reverted (with the following reason|with the following signature)?:?\s*/i, "").slice(0, 160);
};

/** SwapVM TakerTraits as NorenLiquidity builds them: slice table, flags, threshold, optional recipient. */
function takerData(exactIn: boolean, threshold: bigint): Hex {
  const end = 32n;
  let idx = 32n | (end << 16n);
  for (let k = 2n; k < 10n; k++) idx |= end << (16n * k);
  const flags = 0x0040 | (exactIn ? 0x0001 : 0);
  return encodePacked(["uint160", "uint16", "uint256"], [idx, flags, threshold]);
}

export function swapper(cfg: Config, oc: Onchain) {
  const credit = creditOf(cfg);
  const liquidity = (credit?.aquaLiquidity as Address | undefined) ?? null;
  const oracle = credit?.stockOracle ?? null;
  const rh = () => oc.robinhood();

  async function aquaQuote(tin: Token, tout: Token, amountIn: bigint): Promise<RouteQuote | RouteMiss> {
    if (!liquidity) return { id: "aqua", error: "Setup required: NorenLiquidity isn't deployed on the Robinhood fork" };
    const { pub } = rh();
    try {
      if (tout.address === USDG) {
        const [h, out] = await pub.readContract({ address: liquidity, abi: liquidityAbi, functionName: "bestQuoteForAsset", args: [erc(tin), amountIn] });
        if (BigInt(h) === 0n) return { id: "aqua", error: `No maker is quoting ${tin.sym} right now (none registered, a stale Chainlink feed, or not enough USDG)` };
        const s = await pub.readContract({ address: liquidity, abi: liquidityAbi, functionName: "strategy", args: [h] });
        return { id: "aqua", out, strategyHash: h, maker: s.maker, spreadBps: s.bidSpreadBps };
      }
      // Buying: a maker sells only stock it holds (bought earlier at its bid), at the Chainlink price plus its ask spread.
      const [hs, router] = await Promise.all([
        pub.readContract({ address: liquidity, abi: liquidityAbi, functionName: "strategiesFor", args: [erc(tout)] }),
        pub.readContract({ address: liquidity, abi: liquidityAbi, functionName: "router" }),
      ]);
      if (!hs.length) return { id: "aqua", error: `No Aqua maker trades ${tout.sym}` };
      let best: RouteQuote | null = null, why = "";
      for (const h of hs) {
        const [order, s] = await Promise.all([
          pub.readContract({ address: liquidity, abi: liquidityAbi, functionName: "order", args: [h] }),
          pub.readContract({ address: liquidity, abi: liquidityAbi, functionName: "strategy", args: [h] }),
        ]);
        if (!s.active) continue;
        if (s.askSpreadBps === 0xffff) { why = "makers only buy (one-sided strategy)"; continue; }
        try {
          const [, out] = await pub.readContract({ address: router, abi: routerAbi, functionName: "quote", args: [order, USDG, erc(tout), amountIn, takerData(true, 0n)] });
          if (out > 0n && (!best || out > best.out)) best = { id: "aqua", out, strategyHash: h, maker: s.maker, spreadBps: s.askSpreadBps, order };
        } catch (e) { why = /Insufficient|Underfunded|balance/i.test(short(e)) ? `makers hold no ${tout.sym} yet (they buy it at the bid, then resell it)` : short(e); }
      }
      return best ?? { id: "aqua", error: `No maker can sell ${tout.sym}: ${why || "no active strategy"}` };
    } catch (e) { return { id: "aqua", error: short(e) }; }
  }

  async function v4Quote(tin: Token, tout: Token, amountIn: bigint): Promise<RouteQuote | RouteMiss> {
    const { pub } = rh();
    const a = erc(tin), b = erc(tout);
    const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    let best: RouteQuote | null = null;
    for (const [fee, tickSpacing] of TIERS) {
      const key = { currency0, currency1, fee, tickSpacing, hooks: zeroAddress };
      try {
        const { result } = await pub.simulateContract({ address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne: currency0 === a, exactAmount: amountIn, hookData: "0x" }] });
        const [out, gasEstimate] = result as readonly [bigint, bigint];
        if (out > 0n && (!best || out > best.out)) best = { id: "v4", out, key, zeroForOne: currency0 === a, gasEstimate };
      } catch { /* no pool at this tier, or not enough liquidity in range */ }
    }
    return best ?? { id: "v4", error: `No Uniswap v4 pool can fill ${tin.sym} → ${tout.sym} at this size` };
  }

  /** Chainlink value of `amountIn`, in units of `tout` (the fair price both venues are measured against). */
  async function fair(tin: Token, tout: Token, amountIn: bigint): Promise<{ out: bigint | null; marketClosed: boolean }> {
    if (!oracle) return { out: null, marketClosed: false };
    const { pub } = rh();
    try {
      if (tout.address === USDG) {
        const [usd8, p] = await Promise.all([pub.readContract({ address: oracle, abi: oracleAbi, functionName: "valueUsd8", args: [erc(tin), amountIn] }), pub.readContract({ address: oracle, abi: oracleAbi, functionName: "price", args: [erc(tin)] })]);
        return { out: await pub.readContract({ address: oracle, abi: oracleAbi, functionName: "usd8ToUsdg", args: [usd8, 0] }), marketClosed: p.marketClosed };
      }
      const usd8 = await pub.readContract({ address: oracle, abi: oracleAbi, functionName: "usdgToUsd8", args: [amountIn, 0] });
      const [amount, p] = await pub.readContract({ address: oracle, abi: oracleAbi, functionName: "assetForUsd8", args: [erc(tout), usd8, 0n] });
      return { out: amount, marketClosed: p.marketClosed };
    } catch { return { out: null, marketClosed: false }; }
  }

  return {
    liquidity,
    async quote(tin: Token, tout: Token, amountIn: bigint): Promise<SwapQuote> {
      const [aq, uq, f] = await Promise.all([aquaQuote(tin, tout, amountIn), v4Quote(tin, tout, amountIn), fair(tin, tout, amountIn)]);
      const ok = [aq, uq].filter((r): r is RouteQuote => "out" in r);
      const best = ok.sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : 0))[0] ?? null;
      return { routes: [aq, uq], best, fair: f.out, marketClosed: f.marketClosed, at: Date.now() };
    },

    /** Executes `route` on the fork. Returns the swap tx, what arrived (balance delta of `tout`) and gas. */
    async execute(route: RouteQuote, tin: Token, tout: Token, amountIn: bigint, slipBps: number, step: (s: string) => void) {
      const { pub, wallet, chain, account } = rh();
      const me = account.address;
      const minOut = (route.out * BigInt(10_000 - slipBps)) / 10_000n;
      let gas = 0n;
      const send = async (label: string, req: Parameters<typeof wallet.writeContract>[0]) => {
        step(label);
        const h = await wallet.writeContract(req);
        const r = await pub.waitForTransactionReceipt({ hash: h });
        if (r.status !== "success") throw new Error(`${label} reverted: ${h}`);
        gas += r.gasUsed * r.effectiveGasPrice;
        return h;
      };
      const balOut = () => (tout.native ? pub.getBalance({ address: me }) : pub.readContract({ address: tout.address, abi: erc20Abi, functionName: "balanceOf", args: [me] }));
      const wethBal = () => pub.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [me] });
      const before = await balOut();
      const wethBefore = tout.native ? await wethBal() : 0n;
      if (tin.native) await send("Wrapping ETH", { address: WETH, abi: wethAbi, functionName: "deposit", value: amountIn, chain, account } as never);
      const inAddr = erc(tin);
      const approve = async (spender: Address) => {
        const have = await pub.readContract({ address: inAddr, abi: erc20Abi, functionName: "allowance", args: [me, spender] });
        if (have < amountIn) await send(`Approving ${tin.sym}`, { address: inAddr, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256], chain, account });
      };
      let hash: Hex;
      if (route.id === "aqua") {
        if (tout.address === USDG) {
          await approve(liquidity!);
          await pub.simulateContract({ account, address: liquidity!, abi: liquidityAbi, functionName: "sellExactAsset", args: [inAddr, amountIn, minOut, me] });
          hash = await send("Selling to the Aqua maker", { address: liquidity!, abi: liquidityAbi, functionName: "sellExactAsset", args: [inAddr, amountIn, minOut, me], chain, account });
        } else {
          const router = await pub.readContract({ address: liquidity!, abi: liquidityAbi, functionName: "router" });
          await approve(router);
          const args = [route.order!, inAddr, erc(tout), amountIn, takerData(true, minOut)] as const;
          await pub.simulateContract({ account, address: router, abi: routerAbi, functionName: "swap", args });
          hash = await send("Buying from the Aqua maker", { address: router, abi: routerAbi, functionName: "swap", args, chain, account });
        }
      } else {
        await approve(PERMIT2);
        const [p2] = await pub.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [me, inAddr, UNIVERSAL_ROUTER] });
        if (p2 < amountIn) await send("Permit2 allowance for the Universal Router", { address: PERMIT2, abi: permit2Abi, functionName: "approve", args: [inAddr, UNIVERSAL_ROUTER, 2n ** 160n - 1n, Math.floor(Date.now() / 1000) + 30 * 86400], chain, account });
        const input = v4SwapInput(route.key, route.zeroForOne, inAddr, erc(tout), amountIn, minOut);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
        await pub.simulateContract({ account, address: UNIVERSAL_ROUTER, abi: urAbi, functionName: "execute", args: ["0x10", [input], deadline] });
        hash = await send("Swapping on Uniswap v4", { address: UNIVERSAL_ROUTER, abi: urAbi, functionName: "execute", args: ["0x10", [input], deadline], chain, account });
      }
      if (tout.native) {
        const got = (await wethBal()) - wethBefore;
        if (got > 0n) await send("Unwrapping WETH", { address: WETH, abi: wethAbi, functionName: "withdraw", args: [got], chain, account });
      }
      const after = await balOut();
      // For ETH out, gas is paid in the same token: add it back so "received" is what the swap delivered.
      const received = after - before + (tout.native ? gas : 0n);
      return { hash, received, minOut, gasWei: gas };
    },
  };
}
export type Swapper = ReturnType<typeof swapper>;

/** Universal Router V4_SWAP input: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL. Robinhood's router (v4-periphery with
 *  per-hop price limits) reads an extra uint256 before hookData; 0 means no limit beyond amountOutMinimum. */
function v4SwapInput(key: PoolKey, zeroForOne: boolean, tokenIn: Address, tokenOut: Address, amountIn: bigint, minOut: bigint): Hex {
  const poolKey = { type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] } as const;
  const swap = encodeAbiParameters(
    [{ type: "tuple", components: [{ ...poolKey, name: "poolKey" }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] }],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenIn, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenOut, minOut]);
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], ["0x060c0f", [swap, settle, take]]);
}
