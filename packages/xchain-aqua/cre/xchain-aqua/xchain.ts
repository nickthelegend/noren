// Pure logic for the Noren cross-chain Aqua courier: ABIs, log and payload decoding, and the
// checks each delivery makes. No CRE capability calls here, so it is unit-testable with bun and
// runs unchanged inside the CRE WASM runtime (viem only, no Node built-ins).
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

// ---------------------------------------------------------------- ABIs (packages/xchain-aqua/contracts)

export const messageEventAbi = parseAbi([
  "event XChainMessage(bytes32 indexed orderId, uint64 indexed toChainId, address indexed to, bytes payload)",
]);
export const TOPIC_XCHAIN_MESSAGE = toEventSelector("XChainMessage(bytes32,uint64,address,bytes)");

export const escrowAbi = parseAbi(["function orderStatus(bytes32 orderId) view returns (uint8)"]);
export const settlerAbi = parseAbi(["function orderStatus(bytes32 orderId) view returns (uint8)"]);
export const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** NorenCrossChainEscrow.Status */
export const ESCROW_STATUS = ["None", "Open", "Released", "Refundable", "Refunded"] as const;
/** NorenCrossChainSettler.Status */
export const SETTLER_STATUS = ["None", "Filled", "Expired"] as const;

export const KIND = { ORDER: 1, ORDER_DELIVERED: 2, FILLED: 3, EXPIRED: 4, PRICE: 5 } as const;

const ORDER_TUPLE =
  "(uint64 srcChainId, address srcEscrow, uint64 dstChainId, address dstSettler, address taker, address tokenIn, uint256 amountIn, address tokenOut, uint256 minAmountOut, address recipient, address maker, bytes32 strategyHash, uint64 fillDeadline, uint64 refundAfter, uint256 nonce)";
const PRICE_TUPLE =
  "(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound, uint8 decimals, uint256 uiMultiplier, address sourceFeed)";
export const ORDER_PAYLOAD = parseAbiParameters(`uint8 kind, ${ORDER_TUPLE} order, ${PRICE_TUPLE} price`);
export const ORDER_ONLY = parseAbiParameters(ORDER_TUPLE);
export const SETTLEMENT_PAYLOAD = parseAbiParameters(
  "uint8 kind, bytes32 orderId, uint64 dstChainId, address dstSettler, address maker, address payout, uint256 amountIn, uint256 amountOut",
);

// ---------------------------------------------------------------- config

export type ChainConfig = {
  /** Short name used in logs: "robinhood", "arc", "base". */
  name: string;
  /** CRE chain selector name, e.g. "robinhood-testnet", "arc-testnet", "ethereum-testnet-sepolia-base-1". */
  chainSelectorName: string;
  /** EVM chain id the contracts see (block.chainid). */
  chainId: number;
  /** NorenCrossChainEscrow on this chain (source side), or zero. */
  escrow: Address;
  /** NorenCrossChainSettler on this chain (Arc, the hub), or zero. */
  settler: Address;
  gasLimit: string;
};

export type XChainConfig = {
  /** Trigger index i watches chains[i]: its escrow and settler XChainMessage events. */
  chains: ChainConfig[];
  /** Skip orders whose Chainlink round is older than this (the SwapVM instruction checks again on-chain). */
  maxPriceAgeSec: number;
  confidence: "SAFE" | "LATEST" | "FINALIZED";
};

export function validateConfig(config: XChainConfig): void {
  if (!Array.isArray(config.chains) || config.chains.length === 0) throw new Error("config.chains is required");
  const ids = new Set<number>();
  for (const c of config.chains) {
    if (!c.name || !c.chainSelectorName) throw new Error("each chain needs name and chainSelectorName");
    if (!Number.isInteger(c.chainId) || c.chainId <= 0) throw new Error(`config.chains[${c.name}].chainId must be a positive integer`);
    if (ids.has(c.chainId)) throw new Error(`chain id ${c.chainId} listed twice`);
    ids.add(c.chainId);
    for (const k of ["escrow", "settler"] as const) {
      if (!isAddress(c[k])) throw new Error(`config.chains[${c.name}].${k} must be an address (zero if absent)`);
    }
    if (c.escrow === zeroAddress && c.settler === zeroAddress) {
      throw new Error(`Setup required: config.chains[${c.name}] has neither an escrow nor a settler (deploy them first)`);
    }
    if (!/^[0-9]+$/.test(c.gasLimit)) throw new Error(`config.chains[${c.name}].gasLimit must be a decimal string`);
  }
  if (!config.chains.some((c) => c.settler !== zeroAddress)) throw new Error("Setup required: no chain has a settler");
  if (!Number.isInteger(config.maxPriceAgeSec) || config.maxPriceAgeSec <= 0) throw new Error("config.maxPriceAgeSec must be a positive integer");
  if (!["SAFE", "LATEST", "FINALIZED"].includes(config.confidence)) throw new Error("config.confidence must be SAFE, LATEST or FINALIZED");
}

export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------- decoding

export type RawLog = { address: Hex; topics: Hex[]; data: Hex };

export type XChainMessageLog = { emitter: Address; orderId: Hex; toChainId: number; to: Address; payload: Hex };

export function decodeMessageLog(log: RawLog): XChainMessageLog {
  if (log.topics[0]?.toLowerCase() !== TOPIC_XCHAIN_MESSAGE) throw new Error(`not an XChainMessage log (topic ${log.topics[0]})`);
  const ev = decodeEventLog({ abi: messageEventAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  return {
    emitter: getAddress(log.address),
    orderId: ev.args.orderId,
    toChainId: Number(ev.args.toChainId),
    to: getAddress(ev.args.to),
    payload: ev.args.payload,
  };
}

export type Order = {
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
export type PriceRound = {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
  decimals: number;
  uiMultiplier: bigint;
  sourceFeed: Address;
};
export type Settlement = {
  kind: number;
  orderId: Hex;
  dstChainId: bigint;
  dstSettler: Address;
  maker: Address;
  payout: Address;
  amountIn: bigint;
  amountOut: bigint;
};

export const payloadKind = (payload: Hex): number => {
  if (payload.length < 66) throw new Error("payload shorter than one word");
  return Number(BigInt(payload.slice(0, 66)));
};

export function decodeOrderPayload(payload: Hex): { order: Order; price: PriceRound } {
  const [kind, order, price] = decodeAbiParameters(ORDER_PAYLOAD, payload);
  if (kind !== KIND.ORDER) throw new Error(`expected an ORDER payload, got kind ${kind}`);
  return { order: order as Order, price: price as PriceRound };
}

export function decodeSettlementPayload(payload: Hex): Settlement {
  const [kind, orderId, dstChainId, dstSettler, maker, payout, amountIn, amountOut] = decodeAbiParameters(SETTLEMENT_PAYLOAD, payload);
  if (kind !== KIND.FILLED && kind !== KIND.EXPIRED) throw new Error(`expected a FILLED or EXPIRED payload, got kind ${kind}`);
  return { kind, orderId, dstChainId, dstSettler, maker, payout, amountIn, amountOut };
}

/** keccak256(abi.encode(order)): the id both contracts use. */
export const orderId = (o: Order): Hex => keccak256(encodeAbiParameters(ORDER_ONLY, [o]));

// ---------------------------------------------------------------- decisions

export type Delivery = { target: ChainConfig; receiver: Address; report: Hex; summary: string };
export type Decision = { write: true; delivery: Delivery } | { write: false; reason: string };

/** Route an XChainMessage: which chain and contract receive it, checked against the config. */
export function routeMessage(config: XChainConfig, source: ChainConfig, msg: XChainMessageLog): { target: ChainConfig; role: "settler" | "escrow" } {
  const fromEscrow = sameAddress(msg.emitter, source.escrow);
  const fromSettler = sameAddress(msg.emitter, source.settler);
  if (!fromEscrow && !fromSettler) throw new Error(`log from ${msg.emitter}, not a configured contract on ${source.name}`);
  const target = config.chains.find((c) => c.chainId === msg.toChainId);
  if (!target) throw new Error(`message to chain ${msg.toChainId}, which is not configured`);
  const role = fromEscrow ? "settler" : "escrow";
  const expected = fromEscrow ? target.settler : target.escrow;
  if (!sameAddress(expected, msg.to)) throw new Error(`message to ${msg.to} on ${target.name}, expected the configured ${role} ${expected}`);
  return { target, role };
}

export type OrderChecks = {
  /** Settler status of the order on the destination chain (latest). */
  settlerStatus: number;
  /** The source feed's latest round at the log's block (null if the order carries no price). */
  roundAtBlock: { roundId: bigint; updatedAt: bigint } | null;
  nowSeconds: bigint;
};

/** An escrowed order on its way to the Arc settler. */
export function decideOrder(config: XChainConfig, source: ChainConfig, target: ChainConfig, msg: XChainMessageLog, checks: OrderChecks): Decision {
  const { order, price } = decodeOrderPayload(msg.payload);
  const id = orderId(order);
  if (id !== msg.orderId) throw new Error(`payload order id ${id} != log order id ${msg.orderId}`);
  if (Number(order.srcChainId) !== source.chainId || !sameAddress(order.srcEscrow, msg.emitter)) {
    throw new Error(`order names source ${order.srcChainId}/${order.srcEscrow}, but the log came from ${source.chainId}/${msg.emitter}`);
  }
  if (Number(order.dstChainId) !== target.chainId || !sameAddress(order.dstSettler, target.settler)) {
    throw new Error(`order names destination ${order.dstChainId}/${order.dstSettler}, not the configured settler on ${target.name}`);
  }
  if (checks.settlerStatus !== 0) return { write: false, reason: `order ${id} is already ${SETTLER_STATUS[checks.settlerStatus] ?? checks.settlerStatus} on ${target.name}` };
  if (checks.nowSeconds > order.fillDeadline) {
    return { write: false, reason: `order ${id} passed its fill deadline ${order.fillDeadline}; anyone can call expire(order) on ${target.name} so the taker can refund` };
  }
  if (price.updatedAt !== 0n) {
    if (!checks.roundAtBlock) throw new Error("order carries a price but the source feed was not read");
    // The escrow read the feed in the taker's transaction; the DON re-reads it at that block.
    if (checks.roundAtBlock.roundId < price.roundId) {
      throw new Error(`payload round ${price.roundId} is newer than the feed's round ${checks.roundAtBlock.roundId} at the log's block`);
    }
    const age = checks.nowSeconds - price.updatedAt;
    if (age > BigInt(config.maxPriceAgeSec)) {
      return { write: false, reason: `Chainlink round ${price.roundId} is ${age}s old (max ${config.maxPriceAgeSec}s): stale price, not filling` };
    }
  }
  return {
    write: true,
    delivery: {
      target,
      receiver: target.settler,
      report: msg.payload,
      summary: `ORDER ${id}: ${order.amountIn} of ${order.tokenIn} on ${source.name} for >= ${order.minAmountOut} of ${order.tokenOut} on ${target.name}, maker ${order.maker}, price round ${price.roundId} answer ${price.answer}`,
    },
  };
}

/** A FILLED or EXPIRED settlement on its way back to the source escrow. */
export function decideSettlement(source: ChainConfig, target: ChainConfig, msg: XChainMessageLog, escrowStatus: number): Decision {
  const s = decodeSettlementPayload(msg.payload);
  if (s.orderId !== msg.orderId) throw new Error(`settlement order id ${s.orderId} != log order id ${msg.orderId}`);
  if (Number(s.dstChainId) !== source.chainId || !sameAddress(s.dstSettler, msg.emitter)) {
    throw new Error(`settlement claims settler ${s.dstChainId}/${s.dstSettler}, but the log came from ${source.chainId}/${msg.emitter}`);
  }
  if (escrowStatus !== 1) return { write: false, reason: `order ${s.orderId} is ${ESCROW_STATUS[escrowStatus] ?? escrowStatus} in the ${target.name} escrow, not Open` };
  const what = s.kind === KIND.FILLED ? `FILLED: release ${s.amountIn} to maker payout ${s.payout} (taker got ${s.amountOut})` : "EXPIRED: unlock the taker's refund";
  return { write: true, delivery: { target, receiver: target.escrow, report: msg.payload, summary: `${what} for order ${s.orderId} on ${target.name}` } };
}
