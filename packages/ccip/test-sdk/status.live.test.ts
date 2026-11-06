import { describe, expect, it } from "vitest";
import { getCcipMessage, trackJourney } from "../sdk/status.ts";
import { CHAINS } from "../sdk/chains.ts";

// Public network: reads Chainlink's CCIP API and the testnets. Run with `pnpm --filter @noren/ccip test:live`.
const ARC_TO_BASE = "0x8dc21f93991c32eb1319f9ce95907708c3fa7a27d577fe5b460e5bcc61639ceb" as const;

describe("CCIP API (live)", () => {
  it("reads the first Arc -> Base Sepolia Noren message", async () => {
    const m = await getCcipMessage(ARC_TO_BASE);
    expect(m?.status).toBe("SUCCESS");
    expect(m?.sourceSelector).toBe(CHAINS.arc.selector);
    expect(m?.destSelector).toBe(CHAINS.baseSepolia.selector);
    expect(m?.sender.toLowerCase()).toBe(CHAINS.arc.gateway!.toLowerCase());
  }, 30_000);

  it("tracks a one-hop journey", async () => {
    const j = await trackJourney(ARC_TO_BASE, "arc", "baseSepolia");
    expect(j.hops).toHaveLength(1);
    expect(j.hops[0].ccipStatus).toBe("SUCCESS");
    expect(j.hops[0].receiptTx).toMatch(/^0x[0-9a-f]{64}$/);
  }, 30_000);
});
