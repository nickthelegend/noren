// Noren SDK: cross-chain swaps against 1inch Aqua makers on Arc ("Cross-chain swap").
//
// A taker on a source chain (Robinhood Chain, Base Sepolia, ...) locks a token in the Noren escrow
// there; Chainlink CRE carries the order and the Chainlink round to Arc, where a maker's
// Chainlink-pegged Aqua strategy pays USDC to the taker's Arc address; CRE carries the fill back
// and the escrow releases the locked token to the maker. All amounts are base units (bigint).
import {
  encodeAbiParameters,
  hexToBigInt,
  keccak256,
  maxUint256,
  slice,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { AQUA_ORDER_PARAMS, aquaAbi, erc20Abi, escrowAbi, ESCROW_STATUS, ORDER_PARAMS, SETTLER_STATUS, settlerAbi } from "./abi.ts";

export * from "./abi.ts";

export const XCHAIN = {
  chainIds: { robinhood: 4663, arcTestnet: 5042002, baseSepolia: 84532 },
  aqua: "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a" as Address,
  arcUsdc: "0x3600000000000000000000000000000000000000" as Address,
  arcEurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Address,
  /** Source tokens with a route to Arc USDC in the reference deployment. */
  sourceTokens: {
    4663: { NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address },
    84532: { WETH: "0x4200000000000000000000000000000000000006" as Address },
  },
} as const;

/** Mirrors contracts/src/XChainOrder.sol CrossChainOrder. */
export type CrossChainOrder = {
  srcChainId: bigint;
  srcEscrow: Address;
  dstChainId: bigint;
  dstSettler: Address;
  taker: Address;
  tokenIn: Address;
  amountIn: bigint;
  tokenOut: Address;
  minAmountOut: bigint;
  recipient: Address;
  maker: Address;
  strategyHash: Hex;
  fillDeadline: bigint;
  refundAfter: bigint;
  nonce: bigint;
};

export type Pc = PublicClient<Transport, Chain | undefined>;
export type Wc = WalletClient<Transport, Chain | undefined, Account>;

const BPS = 10_000n;
const FLAG_UI_MULTIPLIER = 0x01;
const FLAG_MARKET_HOURS = 0x02;

/** keccak256(abi.encode(order)): the id the escrow and settler use. */
export const crossChainOrderId = (o: CrossChainOrder): Hex => keccak256(encodeAbiParameters(ORDER_PARAMS, [o]));

/** Saturday, Sunday and Monday before 06:00 UTC: US-equity Chainlink feeds don't update (NorenOraclePeg). */
export const marketClosed = (ts: bigint): boolean => {
  const dow = (ts / 86_400n + 4n) % 7n;
  if (dow === 6n || dow === 0n) return true;
  return dow === 1n && ts % 86_400n < 21_600n;
};

/** The pricing terms baked into a strategy's SwapVM program: Salt(8) ‖ NorenOraclePeg(117). */
export function decodePegProgram(data: Hex) {
  const args = slice(data, 12, 12 + 117);
  const u = (a: number, b: number) => Number(hexToBigInt(slice(args, a, b)));
  return {
    bidSpreadBps: u(92, 94),
    askSpreadBps: u(94, 96),
    closedExtraBps: u(96, 98),
    flags: u(100, 101),
    minPriceUsd8: hexToBigInt(slice(args, 101, 109)),
    maxPriceUsd8: hexToBigInt(slice(args, 109, 117)),
  };
}

export type CrossChainQuote = {
  amountOut: bigint; // USDC (6 dp) the maker pays on Arc, exactly as NorenOraclePeg computes it
  priceUsd8: bigint;
  roundId: bigint;
  updatedAt: bigint;
  priceAgeSec: bigint;
  maxAgeSec: bigint;
  fresh: boolean; // the strategy would accept this round now
  marketClosed: boolean;
  spreadBps: number;
  uiMultiplier: bigint;
  maker: Address;
  payout: Address;
  makerCanPay: boolean; // wallet balance, Aqua allowance and the strategy's Aqua virtual balance cover amountOut
  problems: string[];
};

/**
 * Quote a cross-chain swap: `amountIn` of the escrow token on the source chain for USDC on Arc from
 * the maker's strategy. Reads the same Chainlink round the escrow would attach right now
 * (escrow.currentPrice) and the strategy's terms on Arc, and applies NorenOraclePeg's arithmetic.
 */
export async function quoteCrossChainSwap(p: {
  source: Pc;
  arc: Pc;
  escrow: Address;
  settler: Address;
  tokenIn: Address;
  strategyHash: Hex;
  amountIn: bigint;
}): Promise<CrossChainQuote> {
  const problems: string[] = [];
  const [price, strat, arcBlock] = await Promise.all([
    p.source.readContract({ address: p.escrow, abi: escrowAbi, functionName: "currentPrice", args: [p.tokenIn] }),
    p.arc.readContract({ address: p.settler, abi: settlerAbi, functionName: "strategy", args: [p.strategyHash] }),
    p.arc.getBlock(),
  ]);
  if (!strat.active) throw new Error(`strategy ${p.strategyHash} is not active on the Arc settler`);
  if (price.updatedAt === 0n) throw new Error(`Setup required: the escrow has no Chainlink feed for ${p.tokenIn}`);
  const r = await p.arc.readContract({ address: p.settler, abi: settlerAbi, functionName: "route", args: [strat.routeKey] });
  if (!r.takerSellsBase || r.delivered) throw new Error("not an escrowed route where the taker sells the base token");
  const terms = decodePegProgram(strat.data);
  const now = arcBlock.timestamp;
  const closed = (r.flags & FLAG_MARKET_HOURS) !== 0 && marketClosed(now);
  const maxAge = BigInt(closed ? r.baseMaxAgeClosed : r.baseMaxAgeOpen);
  const age = now > price.updatedAt ? now - price.updatedAt : 0n;
  const fresh = age <= maxAge;
  if (!fresh) problems.push(`Chainlink round is ${age}s old; this strategy accepts ${maxAge}s`);
  const dec = Number(price.decimals);
  const px = dec === 8 ? price.answer : dec > 8 ? price.answer / 10n ** BigInt(dec - 8) : price.answer * 10n ** BigInt(8 - dec);
  if (terms.minPriceUsd8 !== 0n && px < terms.minPriceUsd8) problems.push("price below the maker's band");
  if (terms.maxPriceUsd8 !== 0n && px > terms.maxPriceUsd8) problems.push("price above the maker's band");
  const mult = (r.flags & FLAG_UI_MULTIPLIER) !== 0 ? price.uiMultiplier : 10n ** 18n;
  const [baseDec, quoteDec] = await Promise.all([
    p.arc.readContract({ address: r.inToken, abi: erc20Abi, functionName: "decimals" }),
    p.arc.readContract({ address: r.outToken, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const spread = terms.bidSpreadBps + (closed ? terms.closedExtraBps : 0);
  const num = px * mult * 10n ** BigInt(quoteDec);
  const den = 10n ** 8n * 10n ** 18n * 10n ** BigInt(baseDec);
  const amountOut = (p.amountIn * num * (BPS - BigInt(spread))) / (den * BPS);

  const router = await p.arc.readContract({ address: p.settler, abi: settlerAbi, functionName: "router" });
  const [walletBal, allowance, virt] = await Promise.all([
    p.arc.readContract({ address: r.outToken, abi: erc20Abi, functionName: "balanceOf", args: [strat.maker] }),
    p.arc.readContract({ address: r.outToken, abi: erc20Abi, functionName: "allowance", args: [strat.maker, XCHAIN.aqua] }),
    p.arc.readContract({ address: XCHAIN.aqua, abi: aquaAbi, functionName: "rawBalances", args: [strat.maker, router, p.strategyHash, r.outToken] }),
  ]);
  const makerCanPay = walletBal >= amountOut && allowance >= amountOut && BigInt(virt[0]) >= amountOut;
  if (!makerCanPay) problems.push("the maker can't cover this amount right now");
  return {
    amountOut,
    priceUsd8: px,
    roundId: price.roundId,
    updatedAt: price.updatedAt,
    priceAgeSec: age,
    maxAgeSec: maxAge,
    fresh,
    marketClosed: closed,
    spreadBps: spread,
    uiMultiplier: mult,
    maker: strat.maker,
    payout: strat.payout,
    makerCanPay,
    problems,
  };
}

/**
 * Build an order with deadlines that are valid on both clocks: the fill deadline (checked on Arc)
 * and the refund time (checked on the source chain) start from the later of the two chains' times,
 * and the refund waits the escrow's minReleaseWindow after the deadline.
 */
export async function buildCrossChainOrder(p: {
  source: Pc;
  arc: Pc;
  escrow: Address;
  settler: Address;
  taker: Address;
  recipient: Address;
  tokenIn: Address;
  amountIn: bigint;
  maker: Address;
  strategyHash: Hex;
  minAmountOut: bigint;
  fillWindowSec?: bigint;
  nonce?: bigint;
}): Promise<CrossChainOrder> {
  const [srcId, arcId, srcBlock, arcBlock, minRelease] = await Promise.all([
    p.source.getChainId(),
    p.arc.getChainId(),
    p.source.getBlock(),
    p.arc.getBlock(),
    p.source.readContract({ address: p.escrow, abi: escrowAbi, functionName: "minReleaseWindow" }),
  ]);
  const later = srcBlock.timestamp > arcBlock.timestamp ? srcBlock.timestamp : arcBlock.timestamp;
  const fillDeadline = later + (p.fillWindowSec ?? 1800n);
  if (p.minAmountOut <= 0n) throw new Error("minAmountOut must be positive");
  return {
    srcChainId: BigInt(srcId),
    srcEscrow: p.escrow,
    dstChainId: BigInt(arcId),
    dstSettler: p.settler,
    taker: p.taker,
    tokenIn: p.tokenIn,
    amountIn: p.amountIn,
    tokenOut: XCHAIN.arcUsdc,
    minAmountOut: p.minAmountOut,
    recipient: p.recipient,
    maker: p.maker,
    strategyHash: p.strategyHash,
    fillDeadline,
    refundAfter: fillDeadline + minRelease + 1800n,
    nonce: p.nonce ?? BigInt(Date.now()),
  };
}

/** Approve (if needed) and lock the order's tokenIn in the escrow. The wallet must be the taker. */
export async function openCrossChainSwap(p: { source: Pc; wallet: Wc; escrow: Address; order: CrossChainOrder }) {
  if (p.wallet.account.address.toLowerCase() !== p.order.taker.toLowerCase()) throw new Error("the wallet must be the order's taker");
  let approveTx: Hex | null = null;
  const allowance = await p.source.readContract({ address: p.order.tokenIn, abi: erc20Abi, functionName: "allowance", args: [p.order.taker, p.escrow] });
  if (allowance < p.order.amountIn) {
    approveTx = await p.wallet.writeContract({ address: p.order.tokenIn, abi: erc20Abi, functionName: "approve", args: [p.escrow, p.order.amountIn], chain: p.wallet.chain });
    await p.source.waitForTransactionReceipt({ hash: approveTx });
  }
  const txHash = await p.wallet.writeContract({ address: p.escrow, abi: escrowAbi, functionName: "open", args: [p.order], chain: p.wallet.chain });
  const receipt = await p.source.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`open reverted: ${txHash}`);
  return { orderId: crossChainOrderId(p.order), txHash, approveTx };
}

export type CrossChainSwapStatus = {
  orderId: Hex;
  escrow: (typeof ESCROW_STATUS)[number];
  arc: (typeof SETTLER_STATUS)[number];
  fill: { maker: Address; payout: Address; amountIn: bigint; amountOut: bigint; filledAt: bigint } | null;
  /** What the app should show next. */
  next: "waiting-for-fill" | "waiting-for-release" | "done" | "expire-on-arc" | "refund" | "refunded";
};

/** Where an order is on both chains, and what happens next. */
export async function crossChainSwapStatus(p: { source: Pc; arc: Pc; escrow: Address; settler: Address; order: CrossChainOrder }): Promise<CrossChainSwapStatus> {
  const orderId = crossChainOrderId(p.order);
  const [e, s, arcBlock] = await Promise.all([
    p.source.readContract({ address: p.escrow, abi: escrowAbi, functionName: "orderStatus", args: [orderId] }),
    p.arc.readContract({ address: p.settler, abi: settlerAbi, functionName: "orderStatus", args: [orderId] }),
    p.arc.getBlock(),
  ]);
  const escrow = ESCROW_STATUS[e] ?? "None";
  const arc = SETTLER_STATUS[s] ?? "None";
  let fill = null;
  if (arc === "Filled") fill = await p.arc.readContract({ address: p.settler, abi: settlerAbi, functionName: "fillOf", args: [orderId] });
  let next: CrossChainSwapStatus["next"] = "waiting-for-fill";
  if (escrow === "Released") next = "done";
  else if (escrow === "Refunded") next = "refunded";
  else if (escrow === "Refundable") next = "refund";
  else if (arc === "Filled") next = "waiting-for-release";
  else if (arc === "Expired") next = "waiting-for-release";
  else if (arcBlock.timestamp > p.order.fillDeadline) next = "expire-on-arc";
  return { orderId, escrow, arc, fill, next };
}

/** After the fill deadline: mark the unfilled order expired on Arc (anyone may call). */
export async function expireCrossChainSwap(p: { arc: Pc; wallet: Wc; settler: Address; order: CrossChainOrder }) {
  const txHash = await p.wallet.writeContract({ address: p.settler, abi: settlerAbi, functionName: "expire", args: [p.order], chain: p.wallet.chain });
  const receipt = await p.arc.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`expire reverted: ${txHash}`);
  return { txHash };
}

/** Return the escrowed tokens to the taker (after an EXPIRED report, or after refundAfter). */
export async function refundCrossChainSwap(p: { source: Pc; wallet: Wc; escrow: Address; orderId: Hex }) {
  const txHash = await p.wallet.writeContract({ address: p.escrow, abi: escrowAbi, functionName: "refund", args: [p.orderId], chain: p.wallet.chain });
  const receipt = await p.source.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`refund reverted: ${txHash}`);
  return { txHash };
}

/** Active Arc makers for a source token, from the settler's StrategyRegistered events. */
export async function listCrossChainMakers(p: { arc: Pc; settler: Address; srcChainId: number; srcToken: Address; outToken?: Address; fromBlock?: bigint }) {
  const key = await p.arc.readContract({ address: p.settler, abi: settlerAbi, functionName: "routeKey", args: [BigInt(p.srcChainId), p.srcToken, p.outToken ?? XCHAIN.arcUsdc] });
  const logs = await p.arc.getContractEvents({ address: p.settler, abi: settlerAbi, eventName: "StrategyRegistered", args: { routeKey: key }, fromBlock: p.fromBlock ?? 0n });
  const out = [];
  for (const l of logs) {
    const h = l.args.strategyHash as Hex;
    const s = await p.arc.readContract({ address: p.settler, abi: settlerAbi, functionName: "strategy", args: [h] });
    if (s.active) out.push({ strategyHash: h, maker: s.maker, payout: s.payout, bidSpreadBps: l.args.bidSpreadBps as number, fills: s.fills, volumeOut: s.volumeOut });
  }
  return out;
}

/**
 * Order bytes for the Arc action router, action kind 3 (AQUA_ORDER): USDC delivered by CCTP V2 (or an
 * instruction over CCIP) is swapped by NorenCrossChainSettler.fillDelivered against the maker's strategy.
 */
export function encodeAquaOrderAction(p: {
  srcChainId: number;
  tokenOut: Address;
  minAmountOut: bigint;
  recipient: Address;
  maker: Address;
  strategyHash: Hex;
  fillDeadline: bigint;
  nonce: bigint;
}): Hex {
  return encodeAbiParameters(AQUA_ORDER_PARAMS, [{ ...p, srcChainId: BigInt(p.srcChainId) }]);
}

/** Slippage helper: amountOut minus `bps`. */
export const withSlippage = (amountOut: bigint, bps: number): bigint => (amountOut * (BPS - BigInt(bps))) / BPS;

export { maxUint256 };
