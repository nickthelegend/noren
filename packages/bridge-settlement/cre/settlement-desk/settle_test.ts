// Decision and parsing tests. The "live" group calls the real Relay and Across APIs and the real
// Robinhood and Arc mainnet RPCs (read-only, no keys) and parses what they return today.
import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from "viem";
import config from "./config.staging.json";
import {
  acrossFeesUrl,
  checkStableFeed,
  decide,
  decodeRequested,
  decodeRound,
  deskAbi,
  encodeReport,
  headRequest,
  parseAcrossFees,
  parseHead,
  parseRelayQuote,
  parseRound,
  REPORT_PARAMS,
  relayQuoteBody,
  roundRequest,
  slippageBps,
  validateConfig,
  type Config,
  type Request,
  type RouteQuote,
} from "./settle";

const DESK: Address = "0x1111111111111111111111111111111111111111";
const ARC_TREASURY: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const cfg = (): Config => ({ ...(config as Config), desk: { ...(config as Config).desk, address: DESK } });
const ID: Hex = keccak256(stringToHex("settlement-1"));
const req = (amount = 100_000_000n, maxSlippageBps = 50n): Request => ({ id: ID, merchant: DESK, arcRecipient: ARC_TREASURY, amountUsdg6: amount, maxSlippageBps });
const q = (out: bigint, ok = true): RouteQuote => ({ ok, outUsdc6: out, seconds: 1n, reason: ok ? "" : "down" });

describe("config", () => {
  test("staging config needs the desk address", () => expect(() => validateConfig(config as Config)).toThrow("Setup required: config.desk.address"));
  test("complete config passes", () => expect(() => validateConfig(cfg())).not.toThrow());
});

describe("SettlementRequested", () => {
  test("decodes the event", () => {
    const log = {
      address: DESK,
      topics: encodeEventTopics({ abi: deskAbi, eventName: "SettlementRequested", args: { id: ID, merchant: DESK } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters("address, uint256, uint16"), [ARC_TREASURY, 100_000_000n, 50]),
    };
    expect(decodeRequested(log, DESK)).toEqual(req());
    expect(() => decodeRequested({ ...log, address: ARC_TREASURY }, DESK)).toThrow("expected");
  });
});

describe("decide", () => {
  const usdg = 99_998_000n, usdc = 99_990_000n; // fair = 100 x 0.99998 / 0.9999 = 100.008 USDC
  test("approves the better quote within bounds, minimum at fair x (1 - max)", () => {
    const d = decide(req(), q(99_939_000n), q(99_935_000n), usdg, usdc);
    const fair = 100_000_000n * usdg / usdc;
    expect(d.kind).toBe(1);
    expect(d.route).toBe(1);
    expect(d.quotedOutUsdc6).toBe(99_939_000n);
    expect(d.minOutUsdc6).toBe(fair * 9_950n / 10_000n);
    expect(d.slippageBps).toBe(slippageBps(fair, 99_939_000n));
  });
  test("falls back to Across when Relay is down", () => {
    const d = decide(req(), q(0n, false), q(99_935_000n), usdg, usdc);
    expect(d.route).toBe(2);
  });
  test("rejects when every quote is worse than max slippage", () => {
    const d = decide(req(100_000_000n, 1n), q(99_939_000n), q(99_935_000n), usdg, usdc);
    expect(d.kind).toBe(2);
    expect(d.route).toBe(0);
    expect(d.summary).toContain("reject: best quote Relay");
  });
  test("rejects with no quotes", () => {
    expect(decide(req(), q(0n, false), q(0n, false), usdg, usdc).summary).toContain("no usable quote");
  });
  test("minimum never exceeds the quote it approves", () => {
    const d = decide(req(100_000_000n, 500n), q(99_000_000n), q(0n, false), usdg, usdc);
    expect(d.minOutUsdc6 <= d.quotedOutUsdc6).toBe(true);
  });
  test("report is 256 bytes in the desk's layout", () => {
    const d = decide(req(), q(99_939_000n), q(99_935_000n), usdg, usdc);
    const r = encodeReport(d, ID, usdg, usdc, 1_793_950_000n);
    expect((r.length - 2) / 2).toBe(256);
    const { decodeAbiParameters } = require("viem");
    expect(decodeAbiParameters(REPORT_PARAMS, r)).toEqual([1, ID, 1, d.minOutUsdc6, 99_939_000n, usdg, usdc, 1_793_950_000n]);
  });
});

describe("feeds", () => {
  const c = cfg();
  test("peg band and staleness", () => {
    expect(checkStableFeed("USDG/USD", { answer: 99_998_000n, updatedAt: 1000n }, 2000, c)).toBe(99_998_000n);
    expect(() => checkStableFeed("USDG/USD", { answer: 97_000_000n, updatedAt: 1000n }, 2000, c)).toThrow("peg band");
    expect(() => checkStableFeed("USDG/USD", { answer: 99_998_000n, updatedAt: 0n }, c.feeds.maxAgeSeconds + 1, c)).toThrow("stale");
    expect(() => checkStableFeed("USDG/USD", { answer: 0n, updatedAt: 1n }, 2, c)).toThrow("not positive");
  });
});

describe("live APIs and feeds (read-only)", () => {
  const c = cfg();
  test("Relay quotes USDG on Robinhood -> USDC on Arc with a depositErc20 for the desk", async () => {
    const res = await fetch(c.relay.quoteUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(relayQuoteBody(c, req())) });
    expect(res.status).toBe(200);
    const parsed = parseRelayQuote(c, req(), await res.json());
    expect(parsed.reason).toBe("");
    expect(parsed.ok).toBe(true);
    expect(parsed.outUsdc6 > 98_000_000n && parsed.outUsdc6 < 100_100_000n).toBe(true);
    console.log(`live Relay: 100 USDG -> ${parsed.outUsdc6} USDC6 on Arc, ~${parsed.seconds}s`);
  }, 20_000);
  test("Relay quote with a wrong amount is refused by the parser", async () => {
    const res = await fetch(c.relay.quoteUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(relayQuoteBody(c, req())) });
    expect(parseRelayQuote(c, req(100_000_001n), await res.json()).reason).toBe("relay: amount mismatch");
  }, 20_000);
  test("Across quotes the same route on the configured SpokePool", async () => {
    const res = await fetch(acrossFeesUrl(c, req()));
    expect(res.status).toBe(200);
    const parsed = parseAcrossFees(c, req(), await res.json());
    expect(parsed.reason).toBe("");
    expect(parsed.outUsdc6 > 98_000_000n && parsed.outUsdc6 < 100_000_000n).toBe(true);
    console.log(`live Across: 100 USDG -> ${parsed.outUsdc6} USDC6 on Arc, ~${parsed.seconds}s`);
  }, 20_000);
  for (const [name, url, chainId, feed] of [
    ["USDG/USD", c.feeds.robinhoodRpcUrl, 4663, c.feeds.usdgUsd],
    ["USDC/USD", c.feeds.arcRpcUrl, 5042, c.feeds.usdcUsd],
  ] as const) {
    test(`${name} Chainlink feed reads and passes the checks`, async () => {
      const post = async (body: unknown) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      const head = parseHead(await post(headRequest()));
      expect(head.chainId).toBe(chainId);
      const round = parseRound(await post(roundRequest(feed, head.blockNumber - c.feeds.blockLag)));
      const price = checkStableFeed(name, decodeRound(round.raw), round.blockTime, c);
      console.log(`live ${name}: ${price} (8 dp)`);
    }, 20_000);
  }
});
