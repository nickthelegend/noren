// Pure-logic tests for the courier's checks (no chain calls; the fork runs are in scripts/xchain-demo.sh).
import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";
import {
  decidePrice,
  decideRouterOrder,
  payloadKind,
  decideOrder,
  decideSettlement,
  decodeMessageLog,
  KIND,
  messageEventAbi,
  ORDER_PAYLOAD,
  orderId,
  routeMessage,
  SETTLEMENT_PAYLOAD,
  validateConfig,
  type Order,
  type PriceRound,
  type XChainConfig,
} from "./xchain";

const A = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const ESCROW = A(0xe5c);
const SETTLER = A(0x5e7);
const config: XChainConfig = {
  chains: [
    { name: "robinhood", chainSelectorName: "robinhood-testnet", chainId: 4663, escrow: ESCROW, settler: A(0), gasLimit: "1500000" },
    { name: "arc", chainSelectorName: "arc-testnet", chainId: 5042002, escrow: A(0), settler: SETTLER, gasLimit: "3000000" },
  ],
  maxPriceAgeSec: 259200,
  confidence: "SAFE",
};
const [rh, arc] = config.chains;
const NOW = 1_794_000_000n;

const order: Order = {
  srcChainId: 4663n,
  srcEscrow: ESCROW,
  dstChainId: 5042002n,
  dstSettler: SETTLER,
  taker: A(1),
  tokenIn: getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"),
  amountIn: 2n * 10n ** 18n,
  tokenOut: getAddress("0x3600000000000000000000000000000000000000"),
  minAmountOut: 1n,
  recipient: A(2),
  maker: A(3),
  strategyHash: `0x${"ab".repeat(32)}`,
  fillDeadline: NOW + 1800n,
  refundAfter: NOW + 9000n,
  nonce: 1n,
};
const price: PriceRound = {
  roundId: 100n,
  answer: 18_556_000_000n,
  startedAt: NOW - 600n,
  updatedAt: NOW - 600n,
  answeredInRound: 100n,
  decimals: 8,
  uiMultiplier: 10n ** 18n,
  sourceFeed: getAddress("0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"),
};

const logOf = (emitter: Address, id: Hex, toChainId: number, to: Address, payload: Hex) => ({
  address: emitter as Hex,
  topics: encodeEventTopics({ abi: messageEventAbi, eventName: "XChainMessage", args: { orderId: id, toChainId: BigInt(toChainId), to } }) as Hex[],
  data: encodeAbiParameters([{ type: "bytes" }], [payload]),
});

const orderPayload = (o = order, p = price) => encodeAbiParameters(ORDER_PAYLOAD, [KIND.ORDER, o, p]);
const fillPayload = (kind: number = KIND.FILLED, id = orderId(order), settler = SETTLER) =>
  encodeAbiParameters(SETTLEMENT_PAYLOAD, [kind, id, 5042002n, settler, order.maker, A(9), order.amountIn, 300_000_000n]);

describe("orders (escrow -> Arc settler)", () => {
  const msg = decodeMessageLog(logOf(ESCROW, orderId(order), 5042002, SETTLER, orderPayload()));

  test("routes to the configured settler and writes the payload unchanged", () => {
    validateConfig(config);
    expect(routeMessage(config, rh, msg).target.name).toBe("arc");
    const d = decideOrder(config, rh, arc, msg, { settlerStatus: 0, roundAtBlock: { roundId: 100n, updatedAt: price.updatedAt }, nowSeconds: NOW });
    expect(d.write).toBe(true);
    if (d.write) {
      expect(d.delivery.report).toBe(msg.payload);
      expect(d.delivery.receiver).toBe(SETTLER);
    }
  });

  test("skips an order already filled or expired on Arc (replay)", () => {
    const d = decideOrder(config, rh, arc, msg, { settlerStatus: 1, roundAtBlock: { roundId: 100n, updatedAt: price.updatedAt }, nowSeconds: NOW });
    expect(d.write).toBe(false);
    if (!d.write) expect(d.reason).toContain("already Filled");
  });

  test("skips a stale Chainlink round", () => {
    const old = { ...price, updatedAt: NOW - 300_000n, startedAt: NOW - 300_000n };
    const m = decodeMessageLog(logOf(ESCROW, orderId(order), 5042002, SETTLER, orderPayload(order, old)));
    const d = decideOrder(config, rh, arc, m, { settlerStatus: 0, roundAtBlock: { roundId: 100n, updatedAt: old.updatedAt }, nowSeconds: NOW });
    expect(d.write).toBe(false);
    if (!d.write) expect(d.reason).toContain("stale price");
  });

  test("skips after the fill deadline and points at expire()", () => {
    const d = decideOrder(config, rh, arc, msg, { settlerStatus: 0, roundAtBlock: { roundId: 100n, updatedAt: price.updatedAt }, nowSeconds: order.fillDeadline + 1n });
    expect(d.write).toBe(false);
    if (!d.write) expect(d.reason).toContain("expire(order)");
  });

  test("fails loudly when the payload's round is newer than the feed at that block", () => {
    expect(() => decideOrder(config, rh, arc, msg, { settlerStatus: 0, roundAtBlock: { roundId: 99n, updatedAt: 0n }, nowSeconds: NOW })).toThrow("newer than the feed");
  });

  test("fails loudly on a log id that does not match the payload", () => {
    const m = decodeMessageLog(logOf(ESCROW, `0x${"11".repeat(32)}`, 5042002, SETTLER, orderPayload()));
    expect(() => decideOrder(config, rh, arc, m, { settlerStatus: 0, roundAtBlock: null, nowSeconds: NOW })).toThrow("order id");
  });

  test("refuses messages from unknown contracts or to an unexpected receiver", () => {
    expect(() => routeMessage(config, rh, decodeMessageLog(logOf(A(0xbad), orderId(order), 5042002, SETTLER, orderPayload())))).toThrow("not a configured contract");
    expect(() => routeMessage(config, rh, decodeMessageLog(logOf(ESCROW, orderId(order), 5042002, A(0xbad), orderPayload())))).toThrow("expected the configured settler");
  });
});

describe("settlements (Arc settler -> escrow)", () => {
  test("delivers FILLED while the escrow holds the order Open", () => {
    const m = decodeMessageLog(logOf(SETTLER, orderId(order), 4663, ESCROW, fillPayload()));
    expect(routeMessage(config, arc, m).target.name).toBe("robinhood");
    const d = decideSettlement(arc, rh, m, 1);
    expect(d.write).toBe(true);
    if (d.write) expect(d.delivery.summary).toContain("FILLED");
  });

  test("skips when the escrow already released or refunded (double release)", () => {
    const m = decodeMessageLog(logOf(SETTLER, orderId(order), 4663, ESCROW, fillPayload()));
    const d = decideSettlement(arc, rh, m, 2);
    expect(d.write).toBe(false);
    if (!d.write) expect(d.reason).toContain("Released");
  });

  test("fails loudly on a settlement that claims another settler", () => {
    const m = decodeMessageLog(logOf(SETTLER, orderId(order), 4663, ESCROW, fillPayload(KIND.FILLED, orderId(order), A(0xbad))));
    expect(() => decideSettlement(arc, rh, m, 1)).toThrow("claims settler");
  });

  test("EXPIRED unlocks the refund", () => {
    const m = decodeMessageLog(logOf(SETTLER, orderId(order), 4663, ESCROW, fillPayload(KIND.EXPIRED)));
    const d = decideSettlement(arc, rh, m, 1);
    expect(d.write && d.delivery.summary.startsWith("EXPIRED")).toBe(true);
  });
});

test("config needs a settler and real addresses", () => {
  expect(() => validateConfig({ ...config, chains: [rh] })).toThrow("no chain has a settler");
  expect(() => validateConfig({ ...config, chains: [{ ...rh, escrow: A(0) }, arc] })).toThrow("Setup required");
});

describe("Arc action router orders and relayed prices", () => {
  const ROUTER = A(0x407);
  const arcWithRouter = { ...arc, actionRouter: ROUTER };
  const relay = { name: "EUR/USD", chainSelectorName: "ethereum-testnet-sepolia", feed: A(0xe0), relayedFeed: A(0xe1) };
  const src = { roundId: 7n, answer: 112_150_000n, startedAt: NOW - 100n, updatedAt: NOW - 100n, answeredInRound: 7n };
  const none = { roundId: 0n, answer: 0n, startedAt: 0n, updatedAt: 0n, answeredInRound: 0n };

  test("an open AQUA_ORDER becomes a ROUTER_ORDER report for the settler", () => {
    const d = decideRouterOrder(arcWithRouter, ROUTER, `0x${"cd".repeat(32)}`, true, "x");
    expect(d.write && d.delivery.receiver === SETTLER && payloadKind(d.delivery.report) === KIND.ROUTER_ORDER).toBe(true);
    const closed = decideRouterOrder(arcWithRouter, ROUTER, `0x${"cd".repeat(32)}`, false, "x");
    expect(closed.write).toBe(false);
    expect(() => decideRouterOrder(arcWithRouter, A(0xbad), `0x${"cd".repeat(32)}`, true, "x")).toThrow("not the configured action router");
  });

  test("relays a newer fresh round, skips relayed or stale ones", () => {
    const d = decidePrice(arc, relay, src, 8, none, relay.feed, NOW, 90_000);
    expect(d.write && payloadKind(d.delivery.report) === KIND.PRICE).toBe(true);
    expect(decidePrice(arc, relay, src, 8, src, relay.feed, NOW, 90_000).write).toBe(false);
    expect(decidePrice(arc, relay, { ...src, updatedAt: NOW - 100_000n }, 8, none, relay.feed, NOW, 90_000).write).toBe(false);
    expect(() => decidePrice(arc, relay, src, 8, none, A(0xbad), NOW, 90_000)).toThrow("mirrors");
  });
});
