// Bun tests (named *_test.ts so the root Vitest run does not collect them) for the workflow's pure logic. No mocks: the live tests send the workflow's own JSON-RPC
// batches to the real Arc mainnet RPC and cross-check the result against packages/core quoteUsdc.
// They fail (not skip) when the RPC is unreachable.
import { describe, expect, test } from "bun:test";
import { decodeAbiParameters } from "viem";
import { quoteUsdc } from "../../core/src/pricing";
import fixture from "../fixtures/fork-run.json";
import staging from "./config.staging.json";
import {
  buildUpdates,
  decodeRounds,
  encodeReport,
  headRequest,
  parseHead,
  parseRounds,
  REPORT_ABI,
  roundsRequest,
  usdcForFiat,
  validateConfig,
  type JsonRpcCall,
  type PricingConfig,
  type RateUpdate,
} from "./rates";

const config = staging as unknown as PricingConfig & { priceRpcUrl: string };

async function rpc(body: JsonRpcCall[]): Promise<unknown> {
  const res = await fetch(config.priceRpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Setup required: Arc mainnet RPC ${config.priceRpcUrl} returned HTTP ${res.status}`);
  return res.json();
}

async function liveUpdates() {
  const head = parseHead(await rpc(headRequest()));
  const block = head.blockNumber - 2;
  const raw = parseRounds(config, await rpc(roundsRequest(config, block)));
  const updates = buildUpdates(config, decodeRounds(config, raw), BigInt(Math.floor(Date.now() / 1000)));
  return { head, block, updates };
}

describe("config", () => {
  test("staging config is valid", () => expect(() => validateConfig(config)).not.toThrow());
  test("rejects a non-USD currency without a feed", () => {
    const bad = { ...config, currencies: [{ code: "EUR", minorDecimals: 2, feed: null }] };
    expect(() => validateConfig(bad)).toThrow("only USD may omit a feed");
  });
  test("rejects duplicate and malformed codes", () => {
    expect(() => validateConfig({ ...config, currencies: [config.currencies[1], config.currencies[1]] })).toThrow("duplicate");
    expect(() => validateConfig({ ...config, currencies: [{ ...config.currencies[1], code: "eur" }] })).toThrow("three uppercase");
  });
});

describe("live Arc mainnet Chainlink reads", () => {
  test("head is Arc mainnet and every feed round is valid", async () => {
    const { head, updates } = await liveUpdates();
    expect(head.chainId).toBe(5042);
    expect(updates.map((u) => u.currency)).toEqual(config.currencies.map((c) => c.code));
    for (const u of updates) {
      expect(u.fiatUsdAnswer > 0n && u.usdcUsdAnswer > 0n && u.rateE18 > 0n).toBe(true);
      if (u.currency !== "USD") expect(u.fiatUsdRoundId > 0n).toBe(true);
    }
  }, 30_000);

  test("USDC amounts equal packages/core quoteUsdc at the same rounds", async () => {
    for (const code of ["EUR", "JPY", "KRW", "GBP"]) {
      let matched = false;
      for (let attempt = 0; attempt < 3 && !matched; attempt++) {
        const [{ updates }, core] = await Promise.all([liveUpdates(), quoteUsdc({ currency: code, fiatAmount: 12_345n, rpcUrl: config.priceRpcUrl })]);
        const u = updates.find((x) => x.currency === code)!;
        if (u.fiatUsdRoundId !== core.fiatUsd.roundId || u.usdcUsdRoundId !== core.usdcUsd.roundId) continue; // a feed ticked between reads
        expect(usdcForFiat(u, 12_345n)).toBe(core.usdcAmount);
        expect(u.fiatUsdAnswer).toBe(core.fiatUsd.answer);
        expect(u.usdcUsdAnswer).toBe(core.usdcUsd.answer);
        matched = true;
      }
      expect(matched).toBe(true);
    }
  }, 60_000);

  test("a round older than maxAge is rejected", async () => {
    const head = parseHead(await rpc(headRequest()));
    const points = decodeRounds(config, parseRounds(config, await rpc(roundsRequest(config, head.blockNumber - 2))));
    const usdc = points.get(config.usdcUsdFeed)!;
    expect(() => buildUpdates(config, points, usdc.updatedAt + BigInt(config.maxAgeSeconds) + 1n)).toThrow("StalePrice: USDC/USD");
  }, 30_000);

  test("the report encoding round-trips", async () => {
    const { block, updates } = await liveUpdates();
    const [chainId, sourceBlock, usdcFeed, decoded] = decodeAbiParameters(REPORT_ABI, encodeReport(5042, block, config.usdcUsdFeed, updates));
    expect([chainId, sourceBlock, usdcFeed]).toEqual([5042n, BigInt(block), config.usdcUsdFeed]);
    expect(decoded as unknown as RateUpdate[]).toEqual(updates);
  }, 30_000);
});

describe("captured fork run", () => {
  test("captured report gives the same USDC amounts NorenRateOracle.quote returned on the fork", () => {
    const [chainId, , , updates] = decodeAbiParameters(REPORT_ABI, fixture.report as `0x${string}`);
    expect(chainId).toBe(5042n);
    const eur = (updates as unknown as RateUpdate[]).find((u) => u.currency === "EUR")!;
    const krw = (updates as unknown as RateUpdate[]).find((u) => u.currency === "KRW")!;
    expect(usdcForFiat(eur, 10_000n)).toBe(112_183_642n);
    expect(usdcForFiat(krw, 100n)).toBe(73_602n);
  });
});
