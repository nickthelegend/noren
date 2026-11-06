import { describe, expect, it } from "vitest";
import { ARC_SWAP, quoteArcSwap } from "./arc-swap";

describe("public Arc testnet USDC → EURC quotes (read only)", () => {
  it("quotes both live venues and selects the highest output", async () => {
    const quote = await quoteArcSwap(1_000000n, ARC_SWAP.aqua.maker);
    expect(quote.routes).toHaveLength(2);
    const [uniswap, aqua] = quote.routes;
    expect(uniswap.id).toBe("uniswap");
    expect(uniswap).toHaveProperty("out");
    if (!("out" in uniswap)) throw new Error(uniswap.error);
    expect(uniswap.out).toBeGreaterThan(0n);
    expect(uniswap.detail).toContain("PoolKey");
    expect(uniswap.detail).toContain("fee=500");
    expect(aqua.id).toBe("aqua");
    if ("out" in aqua) expect(aqua.out).toBeGreaterThan(0n);
    else expect(aqua.error).toMatch(/^Aqua maker: .+/);
    const expected = "out" in aqua && aqua.out > uniswap.out ? aqua : uniswap;
    expect(quote.best).toEqual(expected);
    console.log(JSON.stringify({
      uniswap: uniswap.out.toString(),
      aqua: "out" in aqua ? { out: aqua.out.toString(), source: aqua.source } : { error: aqua.error },
      best: quote.best?.id,
      fairEurc: quote.fairEurc?.toString() ?? null,
    }));
  }, 60_000);
});
