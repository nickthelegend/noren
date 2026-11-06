// Pure logic for the Noren settlement workflow: API request shapes, response parsing, Chainlink
// feed decoding, the slippage decision and the report encoding. No CRE capability calls here, so
// it is unit-testable with bun and runs unchanged in the CRE WASM runtime (viem only).
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddress,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";

export const deskAbi = parseAbi([
  "event SettlementRequested(bytes32 indexed id, address indexed merchant, address arcRecipient, uint256 amountUsdg6, uint16 maxSlippageBps)",
  "struct Settlement { address merchant; uint64 requestedAt; uint16 maxSlippageBps; uint8 status; uint8 route; address arcRecipient; uint64 validUntil; uint256 amountUsdg6; uint256 minOutUsdc6; uint256 quotedOutUsdc6; }",
  "function settlement(bytes32 id) view returns (Settlement)",
]);
export const SETTLEMENT_REQUESTED = toEventSelector("SettlementRequested(bytes32,address,address,uint256,uint16)");
export const STATUS_REQUESTED = 1;

export const ROUTE = { relay: 1, across: 2 } as const;
export const REPORT_APPROVE = 1;
export const REPORT_REJECT = 2;
/** NorenSettlementDesk.MAX_SLIPPAGE_CAP_BPS: the desk refuses any minimum below amount x 95%. */
export const DESK_HARD_CAP_BPS = 500n;
export const REPORT_PARAMS = parseAbiParameters(
  "uint8 kind, bytes32 id, uint8 route, uint256 minOutUsdc6, uint256 quotedOutUsdc6, uint256 usdgUsd8, uint256 usdcUsd8, uint64 validUntil",
);
/** Relay Depository depositErc20(address depositor, address token, uint256 amount, bytes32 id). */
export const RELAY_DEPOSIT_ERC20 = "0xe8017952";

export type Config = {
  desk: { chainSelectorName: string; address: Address; gasLimit: string };
  originChainId: number;
  destinationChainId: number;
  usdg: Address;
  arcUsdc: Address;
  relay: { quoteUrl: string; depository: Address };
  across: { feesUrl: string; spokePool: Address };
  feeds: {
    robinhoodRpcUrl: string;
    usdgUsd: Address;
    arcRpcUrl: string;
    usdcUsd: Address;
    blockLag: number;
    maxAgeSeconds: number;
    /** Each stablecoin must price within this band of $1 (bps). */
    pegBandBps: number;
  };
  approvalTtlSeconds: number;
  confidence: "SAFE" | "LATEST" | "FINALIZED";
};

export function validateConfig(c: Config): void {
  const addrs: [string, string][] = [
    ["desk.address", c.desk?.address], ["usdg", c.usdg], ["arcUsdc", c.arcUsdc], ["relay.depository", c.relay?.depository],
    ["across.spokePool", c.across?.spokePool], ["feeds.usdgUsd", c.feeds?.usdgUsd], ["feeds.usdcUsd", c.feeds?.usdcUsd],
  ];
  for (const [k, v] of addrs) {
    if (!v || !isAddress(v) || BigInt(v) === 0n) {
      throw new Error(k === "desk.address" ? "Setup required: config.desk.address (deploy NorenSettlementDesk first)" : `config.${k} must be an address`);
    }
  }
  if (!c.relay.quoteUrl.startsWith("https://") || !c.across.feesUrl.startsWith("https://")) throw new Error("API URLs must be https");
  if (!(c.approvalTtlSeconds > 0 && c.approvalTtlSeconds <= 3600)) throw new Error("approvalTtlSeconds must be 1..3600");
}

// ---------------------------------------------------------------- the request

export type Request = { id: Hex; merchant: Address; arcRecipient: Address; amountUsdg6: bigint; maxSlippageBps: bigint };

export function decodeRequested(log: { address: Hex; topics: Hex[]; data: Hex }, desk: Address): Request {
  if (log.address.toLowerCase() !== desk.toLowerCase()) throw new Error(`SettlementRequested from ${log.address}, expected ${desk}`);
  const ev = decodeEventLog({ abi: deskAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  if (ev.eventName !== "SettlementRequested") throw new Error("expected SettlementRequested");
  return { id: ev.args.id, merchant: ev.args.merchant, arcRecipient: ev.args.arcRecipient, amountUsdg6: ev.args.amountUsdg6, maxSlippageBps: BigInt(ev.args.maxSlippageBps) };
}

// ---------------------------------------------------------------- Relay

export const relayQuoteBody = (c: Config, r: Request) => ({
  user: c.desk.address,
  recipient: r.arcRecipient,
  originChainId: c.originChainId,
  destinationChainId: c.destinationChainId,
  originCurrency: c.usdg,
  destinationCurrency: c.arcUsdc,
  amount: r.amountUsdg6.toString(),
  tradeType: "EXACT_INPUT",
});

export type RouteQuote = { ok: boolean; outUsdc6: bigint; seconds: bigint; reason: string };

/**
 * Parse a Relay /quote response and check its deposit step: the Depository, depositErc20 with this
 * desk as depositor, USDG and the exact amount, on Robinhood. The keeper fetches fresh calldata at
 * execution and the desk re-checks it; here the shape is checked so a bad route is never approved.
 */
export function parseRelayQuote(c: Config, r: Request, body: unknown): RouteQuote {
  const q = body as {
    steps?: { id?: string; items?: { data?: { to?: string; data?: string; chainId?: number; value?: string } }[] }[];
    details?: { currencyOut?: { amount?: string; currency?: { address?: string; chainId?: number } }; timeEstimate?: number };
    message?: string;
  };
  const fail = (reason: string): RouteQuote => ({ ok: false, outUsdc6: 0n, seconds: 0n, reason });
  if (!q || !Array.isArray(q.steps)) return fail(`relay: ${q?.message ?? "no steps in quote"}`);
  const deposit = q.steps.find((s) => s.id === "deposit")?.items?.[0]?.data;
  if (!deposit?.to || !deposit.data) return fail("relay: no deposit step");
  if (deposit.chainId !== c.originChainId) return fail(`relay: deposit on chain ${deposit.chainId}`);
  if (getAddress(deposit.to) !== getAddress(c.relay.depository)) return fail(`relay: deposit target ${deposit.to} is not the Depository`);
  if (deposit.value && BigInt(deposit.value) !== 0n) return fail("relay: deposit sends native value");
  if (!deposit.data.startsWith(RELAY_DEPOSIT_ERC20) || deposit.data.length !== 2 + 8 + 64 * 4) return fail("relay: not depositErc20");
  const [depositor, token, amount] = decodeAbiParameters(parseAbiParameters("address, address, uint256, bytes32"), `0x${deposit.data.slice(10)}` as Hex);
  if (getAddress(depositor) !== getAddress(c.desk.address)) return fail("relay: depositor is not the desk");
  if (getAddress(token) !== getAddress(c.usdg)) return fail("relay: token is not USDG");
  if (amount !== r.amountUsdg6) return fail("relay: amount mismatch");
  const out = q.details?.currencyOut;
  if (!out?.amount || !/^[0-9]+$/.test(out.amount)) return fail("relay: no output amount");
  if (!out.currency?.address || getAddress(out.currency.address) !== getAddress(c.arcUsdc) || out.currency.chainId !== c.destinationChainId) {
    return fail("relay: output is not USDC on Arc");
  }
  return { ok: true, outUsdc6: BigInt(out.amount), seconds: BigInt(Math.max(0, Math.round(q.details?.timeEstimate ?? 0))), reason: "" };
}

// ---------------------------------------------------------------- Across

export const acrossFeesUrl = (c: Config, r: Request): string =>
  `${c.across.feesUrl}?inputToken=${c.usdg}&outputToken=${c.arcUsdc}&originChainId=${c.originChainId}` +
  `&destinationChainId=${c.destinationChainId}&amount=${r.amountUsdg6}&recipient=${r.arcRecipient}&depositor=${c.desk.address}`;

export function parseAcrossFees(c: Config, r: Request, body: unknown): RouteQuote {
  const q = body as { outputAmount?: string; isAmountTooLow?: boolean; spokePoolAddress?: string; estimatedFillTimeSec?: number; limits?: { maxDeposit?: string }; message?: string };
  const fail = (reason: string): RouteQuote => ({ ok: false, outUsdc6: 0n, seconds: 0n, reason });
  if (!q || typeof q.outputAmount !== "string" || !/^[0-9]+$/.test(q.outputAmount)) return fail(`across: ${q?.message ?? "no outputAmount"}`);
  if (q.isAmountTooLow) return fail("across: amount too low");
  if (!q.spokePoolAddress || getAddress(q.spokePoolAddress) !== getAddress(c.across.spokePool)) return fail(`across: SpokePool ${q.spokePoolAddress} is not the configured one`);
  if (q.limits?.maxDeposit && BigInt(q.limits.maxDeposit) < r.amountUsdg6) return fail("across: above maxDeposit");
  return { ok: true, outUsdc6: BigInt(q.outputAmount), seconds: BigInt(Math.max(0, Math.round(q.estimatedFillTimeSec ?? 0))), reason: "" };
}

// ---------------------------------------------------------------- Chainlink feeds over JSON-RPC

export type JsonRpcCall = { jsonrpc: "2.0"; id: number; method: string; params: unknown[] };
export const headRequest = (): JsonRpcCall[] => [
  { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
  { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
];
/** latestRoundData() selector. */
export const LATEST_ROUND_DATA = "0xfeaf968c";
export const roundRequest = (feed: Address, block: number): JsonRpcCall[] => [
  { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: feed, data: LATEST_ROUND_DATA }, `0x${block.toString(16)}`] },
  { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] },
];

const byId = (body: unknown): Map<number, { result?: unknown; error?: { message?: string } }> => {
  if (!Array.isArray(body)) throw new Error("JSON-RPC batch reply is not an array");
  type Reply = { id: number; result?: unknown; error?: { message?: string } };
  return new Map((body as Reply[]).map((x) => [x.id, x]));
};

export function parseHead(body: unknown): { chainId: number; blockNumber: number } {
  const m = byId(body);
  const chain = m.get(1)?.result, block = m.get(2)?.result;
  if (typeof chain !== "string" || typeof block !== "string") throw new Error(`JSON-RPC head failed: ${m.get(1)?.error?.message ?? m.get(2)?.error?.message ?? "no result"}`);
  return { chainId: Number(BigInt(chain)), blockNumber: Number(BigInt(block)) };
}

/** Raw latestRoundData result plus the block timestamp, so all nodes must agree byte for byte. */
export function parseRound(body: unknown): { raw: Hex; blockTime: number } {
  const m = byId(body);
  const raw = m.get(1)?.result, blk = m.get(2)?.result as { timestamp?: string } | undefined;
  if (typeof raw !== "string" || raw.length !== 2 + 64 * 5) throw new Error(`latestRoundData failed: ${m.get(1)?.error?.message ?? "bad result"}`);
  if (!blk?.timestamp) throw new Error("block timestamp missing");
  return { raw: raw as Hex, blockTime: Number(BigInt(blk.timestamp)) };
}

export function decodeRound(raw: Hex): { roundId: bigint; answer: bigint; updatedAt: bigint } {
  const [roundId, answer, , updatedAt] = decodeAbiParameters(parseAbiParameters("uint80, int256, uint256, uint256, uint80"), raw);
  return { roundId, answer, updatedAt };
}

/** A $1 stablecoin feed (8 dp) must be positive, fresh at its block and inside the peg band. */
export function checkStableFeed(name: string, round: { answer: bigint; updatedAt: bigint }, blockTime: number, c: Config): bigint {
  if (round.answer <= 0n) throw new Error(`${name} feed answer ${round.answer} is not positive`);
  if (BigInt(blockTime) - round.updatedAt > BigInt(c.feeds.maxAgeSeconds)) throw new Error(`${name} feed is stale: updated ${round.updatedAt}, block time ${blockTime}`);
  const band = 100_000_000n * BigInt(c.feeds.pegBandBps) / 10_000n;
  if (round.answer < 100_000_000n - band || round.answer > 100_000_000n + band) throw new Error(`${name} at ${round.answer} (8 dp) is outside the ${c.feeds.pegBandBps} bps peg band`);
  return round.answer;
}

// ---------------------------------------------------------------- decision

export type Decision = {
  kind: typeof REPORT_APPROVE | typeof REPORT_REJECT;
  route: 0 | 1 | 2;
  fairOutUsdc6: bigint;
  minOutUsdc6: bigint;
  quotedOutUsdc6: bigint;
  slippageBps: bigint;
  summary: string;
};

export const slippageBps = (fair: bigint, quoted: bigint): bigint => (quoted >= fair ? 0n : ((fair - quoted) * 10_000n + fair - 1n) / fair);

/**
 * Fair output = amount x USDG/USD / USDC/USD. Each live quote is measured against it; the better of the
 * quotes within the merchant's max slippage is approved, with minimum = fair x (1 - max slippage).
 * Nothing within bounds: reject (the merchant can retry or cancel).
 */
export function decide(r: Request, relay: RouteQuote, across: RouteQuote, usdgUsd8: bigint, usdcUsd8: bigint): Decision {
  const fair = r.amountUsdg6 * usdgUsd8 / usdcUsd8;
  const candidates = [
    { route: ROUTE.relay, q: relay, name: "Relay" },
    { route: ROUTE.across, q: across, name: "Across" },
  ].filter((x) => x.q.ok);
  const scored = candidates.map((x) => ({ ...x, slip: slippageBps(fair, x.q.outUsdc6) }));
  const inBounds = scored.filter((x) => x.slip <= r.maxSlippageBps).sort((a, b) => (b.q.outUsdc6 > a.q.outUsdc6 ? 1 : b.q.outUsdc6 < a.q.outUsdc6 ? -1 : 0));
  const best = scored.sort((a, b) => (b.q.outUsdc6 > a.q.outUsdc6 ? 1 : -1))[0];
  if (inBounds.length === 0) {
    return {
      kind: REPORT_REJECT, route: 0, fairOutUsdc6: fair, minOutUsdc6: 0n, quotedOutUsdc6: best?.q.outUsdc6 ?? 0n, slippageBps: best?.slip ?? 0n,
      summary: best
        ? `reject: best quote ${best.name} ${best.q.outUsdc6} is ${best.slip} bps under fair ${fair}, max ${r.maxSlippageBps}`
        : `reject: no usable quote (${relay.reason}; ${across.reason})`,
    };
  }
  const pick = inBounds[0];
  let minOut = fair * (10_000n - r.maxSlippageBps) / 10_000n;
  if (minOut > pick.q.outUsdc6) minOut = pick.q.outUsdc6;
  const hardFloor = r.amountUsdg6 * (10_000n - DESK_HARD_CAP_BPS) / 10_000n;
  if (minOut < hardFloor) throw new Error(`minimum ${minOut} below the desk's hard floor ${hardFloor}`);
  return {
    kind: REPORT_APPROVE, route: pick.route, fairOutUsdc6: fair, minOutUsdc6: minOut, quotedOutUsdc6: pick.q.outUsdc6, slippageBps: pick.slip,
    summary: `approve ${pick.name}: quote ${pick.q.outUsdc6} USDC6 (${pick.slip} bps under fair ${fair}), minimum ${minOut}`,
  };
}

export const encodeReport = (d: Decision, id: Hex, usdgUsd8: bigint, usdcUsd8: bigint, validUntil: bigint): Hex =>
  encodeAbiParameters(REPORT_PARAMS, [d.kind, id, d.route, d.minOutUsdc6, d.quotedOutUsdc6, usdgUsd8, usdcUsd8, validUntil]);
