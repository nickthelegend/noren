import { createPublicClient, defineChain, http, parseAbi, type Address } from 'viem';

export const DEFAULT_PRICE_RPC = 'https://arc-rpc.publicnode.com';
export const ARC_MAINNET_CHAIN_ID = 5042;
export const USDC_USD_FEED = '0x84EA90AC252Dc437031461836DB5164219147905' as Address;
export const feedAbi = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80,int256,uint256,uint256,uint80)',
]);

export const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2, feed: null },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2, feed: '0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D' },
  { code: 'GBP', name: 'British Pound', symbol: '£', decimals: 2, feed: '0x3E0a1296e6CBF0a8fa54F2b4909643214EfCeE4D' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0, feed: '0xF9Fc1C20C82d774A3787845E73E41BCbF7F38F25' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimals: 2, feed: '0x5024DF70A748e5f1E720AAe8EEfc590430d71573' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimals: 2, feed: '0xaF452c2EA72b6E08AB64a67133a13C4ED35343eb' },
  { code: 'MXN', name: 'Mexican Peso', symbol: 'MX$', decimals: 2, feed: '0x302eaa6cd6f7AdDdc973fAC2Bb8fa32e9Ce19f21' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', decimals: 2, feed: '0x3406DB72AC5136b89eba6808CFcaD83aF523B3C2' },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', decimals: 0, feed: '0x07040A33A0204596e927595D0994C5D841d7d61D' },
] as const satisfies readonly { code: string; name: string; symbol: string; decimals: number; feed: Address | null }[];

export type CurrencyCode = typeof CURRENCIES[number]['code'];
export type PricePoint = { feed: Address | null; answer: bigint; decimals: number; roundId: bigint; updatedAt: bigint };
export type UsdcQuote = { currency: CurrencyCode; fiatAmount: bigint; usdcAmount: bigint; fiatUsd: PricePoint; usdcUsd: PricePoint; rate: string; quotedAt: number; chain: 'arc-mainnet'; chainId: 5042 };

const arcMainnet = defineChain({ id: ARC_MAINNET_CHAIN_ID, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [DEFAULT_PRICE_RPC] } } });

export async function quoteUsdc({ currency, fiatAmount, rpcUrl = DEFAULT_PRICE_RPC, maxAgeSeconds = 86400 + 3600 }: { currency: string; fiatAmount: bigint; rpcUrl?: string; maxAgeSeconds?: number }): Promise<UsdcQuote> {
  const unit = CURRENCIES.find(c => c.code === currency.toUpperCase());
  if (!unit) throw new Error(`Unsupported currency: ${currency}`);
  if (typeof fiatAmount !== 'bigint' || fiatAmount <= 0n) throw new Error('fiatAmount must be a positive integer in minor units');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('maxAgeSeconds must be a non-negative integer');
  const client: any = createPublicClient({ chain: arcMainnet, transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  let usdcUsd: PricePoint, fiatUsd: PricePoint;
  try {
    if (await client.getChainId() !== ARC_MAINNET_CHAIN_ID) throw new Error('wrong chain ID; expected Arc mainnet 5042');
    const read = async (feed: Address): Promise<PricePoint> => {
      const [decimals, round] = await Promise.all([
        client.readContract({ address: feed, abi: feedAbi, functionName: 'decimals' }),
        client.readContract({ address: feed, abi: feedAbi, functionName: 'latestRoundData' }),
      ]);
      return { feed, answer: BigInt(round[1]), decimals: Number(decimals), roundId: BigInt(round[0]), updatedAt: BigInt(round[3]) };
    };
    [usdcUsd, fiatUsd] = await Promise.all([
      read(USDC_USD_FEED),
      unit.feed ? read(unit.feed) : Promise.resolve({ feed: null, answer: 1n, decimals: 0, roundId: 0n, updatedAt: BigInt(Math.floor(Date.now() / 1000)) }),
    ]);
  } catch (error: any) {
    throw new Error(`Setup required: Chainlink price RPC unreachable at ${rpcUrl}: ${error?.shortMessage ?? error?.message ?? error}`);
  }
  const quotedAt = Math.floor(Date.now() / 1000);
  const validate = (point: PricePoint, pair: string) => {
    if (point.answer <= 0n) throw new Error(`InvalidPrice: ${pair} answer must be positive`);
    if (point.updatedAt === 0n) throw new Error(`InvalidPrice: ${pair} round is incomplete`);
    const age = BigInt(quotedAt) - point.updatedAt;
    if (age < 0n || age > BigInt(maxAgeSeconds)) throw new Error(`StalePrice: ${pair} updated ${age} s ago`);
  };
  validate(fiatUsd, `${unit.code}/USD`);
  validate(usdcUsd, 'USDC/USD');
  const numerator = fiatAmount * fiatUsd.answer * 1_000_000n * 10n ** BigInt(usdcUsd.decimals);
  const denominator = usdcUsd.answer * 10n ** BigInt(unit.decimals + fiatUsd.decimals);
  const usdcAmount = (numerator + denominator - 1n) / denominator;
  const rateNumerator = fiatUsd.answer * 10n ** BigInt(usdcUsd.decimals);
  const rateDenominator = usdcUsd.answer * 10n ** BigInt(fiatUsd.decimals);
  const rateScaled = rateNumerator * 10n ** 12n / rateDenominator;
  const rate = `${rateScaled / 10n ** 12n}.${(rateScaled % 10n ** 12n).toString().padStart(12, '0')}`.replace(/\.?0+$/, '');
  return { currency: unit.code, fiatAmount, usdcAmount, fiatUsd, usdcUsd, rate, quotedAt, chain: 'arc-mainnet', chainId: ARC_MAINNET_CHAIN_ID };
}
