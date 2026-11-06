// Noren liquidity on 1inch Aqua + SwapVM: constants and pure helpers shared by the SDK methods.
import type { Address, Hex } from 'viem'
import { STOCKS, USDG, WETH } from './addresses.js'

/** Official 1inch deployments on Robinhood Chain (github.com/1inch/aqua deployments.md). */
export const AQUA = '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a' as Address
/** Official AquaSwapVMRouter v1.0.2. Noren's flows use its own build with NorenOraclePeg added (addresses.swapRouter). */
export const OFFICIAL_SWAPVM_ROUTER = '0x111111338c5091E8440b67B168bAe16a668AC0De' as Address
/** Uniswap v4 V4Quoter on Robinhood Chain (best-execution comparison only). */
export const V4_QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94' as Address
/** NorenLiquidity.PegTerms.askSpreadBps value for a buy-only strategy. */
export const ONE_SIDED = 0xffff

export type PegTerms = {
  bidSpreadBps: number
  askSpreadBps: number
  closedExtraBps: number
  minPriceUsd8: bigint
  maxPriceUsd8: bigint
  salt: bigint
}

export const defaultPegTerms = (asset: Address, overrides: Partial<PegTerms> = {}): PegTerms => ({
  bidSpreadBps: asset.toLowerCase() === WETH.toLowerCase() ? 30 : 50,
  askSpreadBps: asset.toLowerCase() === WETH.toLowerCase() ? 50 : 80,
  closedExtraBps: asset.toLowerCase() === WETH.toLowerCase() ? 0 : 300,
  minPriceUsd8: 0n,
  maxPriceUsd8: 0n,
  salt: 0n,
  ...overrides,
})

/** Ticker for a Robinhood asset address ("ETH" for WETH, "USDG" for USDG). */
export function symbolOf(asset: Address): string {
  const a = asset.toLowerCase()
  if (a === WETH.toLowerCase()) return 'ETH'
  if (a === USDG.toLowerCase()) return 'USDG'
  for (const [sym, addr] of Object.entries(STOCKS)) if (addr.toLowerCase() === a) return sym
  return asset
}

/**
 * Price (USD, 8 decimals, per share or per ETH) below which collateral is worth less than
 * `thresholdBps` of the debt, i.e. the price that makes the position liquidatable.
 * value = amount * multiplier / 1e18 * price / 10^decimals, so
 * price* = debtUsd8 * thresholdBps / 10_000 * 1e18 * 10^decimals / (amount * multiplier), rounded up.
 */
export function liquidationPriceUsd8({
  debtUsd8,
  thresholdBps,
  amount,
  multiplier,
  decimals,
}: {
  debtUsd8: bigint
  thresholdBps: bigint | number
  amount: bigint
  multiplier: bigint
  decimals: number
}): bigint {
  if (amount === 0n || multiplier === 0n) return 0n
  const num = debtUsd8 * BigInt(thresholdBps) * 10n ** 18n * 10n ** BigInt(decimals)
  const den = 10_000n * amount * multiplier
  return (num + den - 1n) / den
}

/** Fixed-point bigint to a trimmed decimal string. */
export function formatUnitsTrim(value: bigint, decimals: number, maxFraction = 4): string {
  const neg = value < 0n
  const v = neg ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`
}

export const usd = (usd8: bigint) => `$${formatUnitsTrim(usd8, 8, 2)}`

/** The sentence the Noren app shows next to a Pay-in-3 plan. */
export function planLiquidationMessage({
  sharesText,
  symbol,
  liquidationPriceUsd8,
  remainingInstallments,
  missed,
}: {
  sharesText: string
  symbol: string
  liquidationPriceUsd8: bigint
  remainingInstallments: number
  missed: number
}): string {
  const price = `your ${sharesText} ${symbol} liquidates if ${symbol} < ${usd(liquidationPriceUsd8)}`
  if (remainingInstallments === 0) return `Plan repaid: your ${sharesText} ${symbol} has been returned`
  if (missed >= 1 || remainingInstallments === 1) return `${capital(price)} or if you miss ${remainingInstallments === 1 ? 'the final payment' : 'one more payment'}`
  return `${capital(price)} or if you miss two payments`
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export type StrategyRecord = {
  maker: Address
  asset: Address
  active: boolean
  bidSpreadBps: number
  askSpreadBps: number
  registeredAt: bigint
  fills: number
  volumeUsdg: bigint
  feesUsdg: bigint
  data: Hex
}
