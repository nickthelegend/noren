import { describe, expect, it } from 'vitest';
import { createPublicClient, defineChain, http } from 'viem';
import { CURRENCIES, DEFAULT_PRICE_RPC, USDC_USD_FEED, feedAbi, quoteUsdc } from './pricing.ts';

const rpcUrl = process.env.ARC_MAINNET_RPC ?? process.env.NOREN_PRICE_RPC ?? DEFAULT_PRICE_RPC;
const networkRequired = (error: unknown) => { throw new Error(`network required: Arc mainnet Chainlink feeds at ${rpcUrl}: ${String(error)}`); };

describe('Arc mainnet Chainlink pricing (network required)', () => {
  it('answers description() on every configured proxy', async () => {
    const client: any = createPublicClient({ chain: defineChain({ id: 5042, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }), transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
    const chainId = await client.getChainId().catch(networkRequired);
    expect(chainId).toBe(5042);
    for (const feed of [...CURRENCIES.map(c => c.feed).filter((f): f is NonNullable<typeof f> => f !== null), USDC_USD_FEED]) {
      const description: string = await client.readContract({ address: feed, abi: feedAbi, functionName: 'description' }).catch(networkRequired);
      expect(description.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('quotes EUR 6.90 and JPY 1000 using live rounds and exact ceiling math', async () => {
    for (const [currency, amount, minorDecimals] of [['EUR', 690n, 2n], ['JPY', 1000n, 0n]] as const) {
        const q = await quoteUsdc({ currency, fiatAmount: amount, rpcUrl }).catch(networkRequired);
        const numerator = amount * q.fiatUsd.answer * 1_000_000n * 10n ** BigInt(q.usdcUsd.decimals);
        const denominator = q.usdcUsd.answer * 10n ** (minorDecimals + BigInt(q.fiatUsd.decimals));
        expect(q.usdcAmount).toBe((numerator + denominator - 1n) / denominator);
        expect(q.usdcAmount).toBeGreaterThan(0n);
        expect(q.fiatUsd.roundId).toBeGreaterThan(0n);
        expect(q.usdcUsd.roundId).toBeGreaterThan(0n);
        expect(q.chainId).toBe(5042);
        if (currency === 'EUR') console.info(`Live EUR 6.90 quote: ${q.usdcAmount} USDC base units; fiat round ${q.fiatUsd.roundId}; USDC round ${q.usdcUsd.roundId}`);
    }
  }, 60_000);

  it('reports a clear setup error when the price RPC is offline', async () => {
    await expect(quoteUsdc({ currency: 'EUR', fiatAmount: 690n, rpcUrl: 'http://127.0.0.1:8712' })).rejects.toThrow(/Setup required: Chainlink price RPC unreachable/);
  });
});
