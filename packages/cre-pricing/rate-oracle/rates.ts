// Pure helpers for the Noren rate-oracle CRE workflow.
// No Node.js or browser APIs: this file is compiled to WASM (QuickJS) with main.ts,
// and is also imported by the Bun tests that run against the live Arc mainnet RPC.
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

export const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export type CurrencyConfig = {
  /** ISO 4217 code, three uppercase letters. */
  code: string;
  /** Fiat minor-unit decimals (EUR 2, JPY 0). */
  minorDecimals: number;
  /** Chainlink fiat/USD proxy on Arc mainnet; null for the synthetic USD/USD rate of 1. */
  feed: Address | null;
};

export type PricingConfig = {
  sourceChainId: number;
  usdcUsdFeed: Address;
  maxAgeSeconds: number;
  currencies: CurrencyConfig[];
};

export type JsonRpcCall = { jsonrpc: "2.0"; id: number; method: string; params: unknown[] };
export type JsonRpcReply = { id: number; result?: string; error?: { code: number; message: string } };

export type RoundPoint = { feed: Address; answer: bigint; decimals: number; roundId: bigint; updatedAt: bigint };

/** One entry of the on-chain report; field order matches NorenRateOracle.RateUpdate. */
export type RateUpdate = {
  currency: string;
  fiatMinorDecimals: number;
  fiatUsdFeed: Address;
  fiatUsdAnswer: bigint;
  fiatUsdDecimals: number;
  fiatUsdRoundId: bigint;
  fiatUsdUpdatedAt: bigint;
  usdcUsdAnswer: bigint;
  usdcUsdDecimals: number;
  usdcUsdRoundId: bigint;
  usdcUsdUpdatedAt: bigint;
  rateE18: bigint;
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const REPORT_ABI = parseAbiParameters(
  "uint64 sourceChainId, uint64 sourceBlock, address usdcUsdFeed, (string currency, uint8 fiatMinorDecimals, address fiatUsdFeed, int256 fiatUsdAnswer, uint8 fiatUsdDecimals, uint80 fiatUsdRoundId, uint64 fiatUsdUpdatedAt, int256 usdcUsdAnswer, uint8 usdcUsdDecimals, uint80 usdcUsdRoundId, uint64 usdcUsdUpdatedAt, uint256 rateE18)[] updates",
);

export function validateConfig(config: PricingConfig): void {
  if (!Number.isSafeInteger(config.sourceChainId) || config.sourceChainId <= 0) throw new Error("config.sourceChainId must be a positive integer");
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.usdcUsdFeed)) throw new Error("config.usdcUsdFeed must be an address");
  if (!Number.isSafeInteger(config.maxAgeSeconds) || config.maxAgeSeconds <= 0) throw new Error("config.maxAgeSeconds must be a positive integer");
  if (config.currencies.length === 0) throw new Error("config.currencies is empty");
  const seen = new Set<string>();
  for (const c of config.currencies) {
    if (!/^[A-Z]{3}$/.test(c.code)) throw new Error(`currency code ${c.code} must be three uppercase letters`);
    if (seen.has(c.code)) throw new Error(`duplicate currency ${c.code}`);
    seen.add(c.code);
    if (!Number.isInteger(c.minorDecimals) || c.minorDecimals < 0 || c.minorDecimals > 4) throw new Error(`${c.code}: minorDecimals must be 0-4`);
    if (c.feed !== null && !/^0x[0-9a-fA-F]{40}$/.test(c.feed)) throw new Error(`${c.code}: feed must be an address or null`);
    if (c.feed === null && c.code !== "USD") throw new Error(`${c.code}: only USD may omit a feed`);
  }
}

/** Step 1 request: chain ID plus the finalized block number of the source chain. */
export function headRequest(): JsonRpcCall[] {
  return [
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["finalized", false] },
  ];
}

export function parseHead(replies: JsonRpcReply[] | unknown): { chainId: number; blockNumber: number } {
  const byId = indexReplies(replies, 2);
  const chainId = Number(BigInt(requireResult(byId, 1, "eth_chainId")));
  const block = byId.get(2)?.result as unknown as { number?: string } | null | undefined;
  if (!block || typeof block.number !== "string") throw new Error("eth_getBlockByNumber(finalized) returned no block");
  return { chainId, blockNumber: Number(BigInt(block.number)) };
}

/** Feeds read per run: USDC/USD first, then each fiat feed in config order. */
export function feedList(config: PricingConfig): Address[] {
  const out: Address[] = [config.usdcUsdFeed];
  for (const c of config.currencies) if (c.feed && !out.includes(c.feed)) out.push(c.feed);
  return out;
}

/** Step 2 request: decimals() and latestRoundData() for every feed, pinned to one block. */
export function roundsRequest(config: PricingConfig, blockNumber: number): JsonRpcCall[] {
  const tag = `0x${blockNumber.toString(16)}`;
  const decimalsData = encodeFunctionData({ abi: feedAbi, functionName: "decimals" });
  const roundData = encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" });
  const calls: JsonRpcCall[] = [];
  feedList(config).forEach((feed, i) => {
    calls.push({ jsonrpc: "2.0", id: 2 * i + 1, method: "eth_call", params: [{ to: feed, data: decimalsData }, tag] });
    calls.push({ jsonrpc: "2.0", id: 2 * i + 2, method: "eth_call", params: [{ to: feed, data: roundData }, tag] });
  });
  return calls;
}

/** Returns the raw eth_call results in request order. Consensus runs on these exact hex strings. */
export function parseRounds(config: PricingConfig, replies: JsonRpcReply[] | unknown): string[] {
  const n = feedList(config).length * 2;
  const byId = indexReplies(replies, n);
  const out: string[] = [];
  for (let id = 1; id <= n; id++) out.push(requireResult(byId, id, "eth_call"));
  return out;
}

export function decodeRounds(config: PricingConfig, raw: string[]): Map<Address, RoundPoint> {
  const feeds = feedList(config);
  if (raw.length !== feeds.length * 2) throw new Error(`expected ${feeds.length * 2} eth_call results, got ${raw.length}`);
  const points = new Map<Address, RoundPoint>();
  feeds.forEach((feed, i) => {
    const decimals = decodeFunctionResult({ abi: feedAbi, functionName: "decimals", data: raw[2 * i] as Hex });
    const [roundId, answer, , updatedAt] = decodeFunctionResult({ abi: feedAbi, functionName: "latestRoundData", data: raw[2 * i + 1] as Hex });
    points.set(feed, { feed, answer, decimals: Number(decimals), roundId, updatedAt });
  });
  return points;
}

function checkRound(point: RoundPoint, pair: string, nowSeconds: bigint, maxAge: bigint) {
  if (point.answer <= 0n) throw new Error(`InvalidPrice: ${pair} answer ${point.answer} must be positive`);
  if (point.updatedAt === 0n) throw new Error(`IncompleteRound: ${pair} updatedAt is 0`);
  if (point.decimals > 18) throw new Error(`InvalidPrice: ${pair} has ${point.decimals} decimals`);
  const age = nowSeconds - point.updatedAt;
  if (age > maxAge) throw new Error(`StalePrice: ${pair} round ${point.roundId} updated ${age} s ago (max ${maxAge} s)`);
}

/** USDC per one fiat major unit, 18 decimals, rounded down. Same inputs as packages/core/src/pricing.ts. */
export function rateE18(fiatAnswer: bigint, fiatDecimals: number, usdcAnswer: bigint, usdcDecimals: number): bigint {
  return (fiatAnswer * 10n ** BigInt(usdcDecimals) * 10n ** 18n) / (usdcAnswer * 10n ** BigInt(fiatDecimals));
}

/** USDC base units for a fiat amount in minor units, rounded up (identical to quoteUsdc and NorenRateOracle.quote). */
export function usdcForFiat(u: RateUpdate, fiatAmount: bigint): bigint {
  const numerator = fiatAmount * u.fiatUsdAnswer * 1_000_000n * 10n ** BigInt(u.usdcUsdDecimals);
  const denominator = u.usdcUsdAnswer * 10n ** BigInt(u.fiatMinorDecimals + u.fiatUsdDecimals);
  return (numerator + denominator - 1n) / denominator;
}

export function buildUpdates(config: PricingConfig, points: Map<Address, RoundPoint>, nowSeconds: bigint): RateUpdate[] {
  const maxAge = BigInt(config.maxAgeSeconds);
  const usdc = points.get(config.usdcUsdFeed);
  if (!usdc) throw new Error("USDC/USD round missing");
  checkRound(usdc, "USDC/USD", nowSeconds, maxAge);
  return config.currencies.map((c) => {
    const fiat: RoundPoint = c.feed
      ? (points.get(c.feed) ?? (() => { throw new Error(`${c.code}/USD round missing`); })())
      : { feed: ZERO_ADDRESS, answer: 1n, decimals: 0, roundId: 0n, updatedAt: usdc.updatedAt };
    if (c.feed) checkRound(fiat, `${c.code}/USD`, nowSeconds, maxAge);
    return {
      currency: c.code,
      fiatMinorDecimals: c.minorDecimals,
      fiatUsdFeed: fiat.feed,
      fiatUsdAnswer: fiat.answer,
      fiatUsdDecimals: fiat.decimals,
      fiatUsdRoundId: fiat.roundId,
      fiatUsdUpdatedAt: fiat.updatedAt,
      usdcUsdAnswer: usdc.answer,
      usdcUsdDecimals: usdc.decimals,
      usdcUsdRoundId: usdc.roundId,
      usdcUsdUpdatedAt: usdc.updatedAt,
      rateE18: rateE18(fiat.answer, fiat.decimals, usdc.answer, usdc.decimals),
    };
  });
}

export function encodeReport(sourceChainId: number, sourceBlock: number, usdcUsdFeed: Address, updates: RateUpdate[]): Hex {
  return encodeAbiParameters(REPORT_ABI, [
    BigInt(sourceChainId),
    BigInt(sourceBlock),
    usdcUsdFeed,
    updates.map((u) => ({ ...u })),
  ]);
}

export function formatRate(r: bigint): string {
  const whole = r / 10n ** 18n;
  const frac = (r % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function indexReplies(replies: JsonRpcReply[] | unknown, expected: number): Map<number, JsonRpcReply> {
  if (!Array.isArray(replies)) throw new Error(`JSON-RPC batch reply is not an array: ${JSON.stringify(replies).slice(0, 200)}`);
  if (replies.length !== expected) throw new Error(`JSON-RPC batch returned ${replies.length} replies, expected ${expected}`);
  const byId = new Map<number, JsonRpcReply>();
  for (const r of replies as JsonRpcReply[]) byId.set(Number(r.id), r);
  return byId;
}

function requireResult(byId: Map<number, JsonRpcReply>, id: number, method: string): string {
  const r = byId.get(id);
  if (!r) throw new Error(`${method} id ${id}: missing reply`);
  if (r.error) throw new Error(`${method} id ${id}: RPC error ${r.error.code} ${r.error.message}`);
  if (typeof r.result !== "string" || !r.result.startsWith("0x")) throw new Error(`${method} id ${id}: unexpected result ${JSON.stringify(r.result)}`);
  if (method === "eth_call" && r.result === "0x") throw new Error(`eth_call id ${id}: empty return data (no contract at that address?)`);
  return r.result;
}
