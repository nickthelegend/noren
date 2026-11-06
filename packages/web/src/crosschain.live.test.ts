// Live: reads InvoicePaid from the public Arc testnet NorenArcActionRouter in windows, twice (the second read is cached
// and only covers new blocks). Run: pnpm exec vitest run packages/web/src/crosschain.live.test.ts
import { describe, expect, it } from "vitest";
import { crossChainPayments } from "./crosschain";

describe("From other chains (live Arc testnet)", () => {
  it("reads every window from the router's deploy block, then refreshes from the cache", async () => {
    const merchant = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const a = await crossChainPayments(merchant);
    const t0 = performance.now(); const b = await crossChainPayments(merchant);
    expect(Array.isArray(a)).toBe(true); expect(b.length).toBeGreaterThanOrEqual(a.length);
    expect(performance.now() - t0).toBeLessThan(5000);
    // Five parallel reads (the dashboard plus other panels) must not trip the RPC's rate limit.
    const all = await Promise.all(["0x1", "0x2", "0x3", "0x4", "0x5"].map((x) => crossChainPayments(x.padEnd(42, "0") as `0x${string}`)));
    for (const r of all) expect(Array.isArray(r)).toBe(true);
  }, 120_000);
});
