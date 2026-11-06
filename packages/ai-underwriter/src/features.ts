// The wallet-history features sent to the sealed model. They come from the Robinhood-side
// underwriter (packages/robinhood/underwriter, readWalletHistory). The wallet address is never
// part of the features: the model sees numbers, not an identity.
import { createHash } from 'node:crypto'

export type CreditFeatures = {
  /** Days since the wallet's first activity on Robinhood Chain; null if unavailable. */
  accountAgeDays: number | null
  /** Nonce-based transaction count; null if unavailable. */
  txCount: number | null
  /** Stock Token holdings at the Chainlink price, whole USD; null if unavailable. */
  stockHoldingsUsd: number | null
  /** All priced holdings (Stock Tokens, ETH, WETH, USDG), whole USD; null if unavailable. */
  totalHoldingsUsd: number | null
  /** Non-zero holdings by symbol, whole USD, largest first. */
  holdings: { symbol: string; valueUsd: number }[]
  /** Past Noren pay-later record; null if unavailable. */
  repayments: { onTime: number; late: number; defaults: number; completed: number; clean: number } | null
}

type Big = bigint | string | number
type Factor = { status: 'available' | 'unavailable' }
/** Structural copy of WalletHistory from the Robinhood underwriter. bigint fields may arrive as strings over HTTP. */
export type WalletHistoryLike = {
  address?: string
  accountAge: Factor & { days: number }
  txCount: Factor & { count: number }
  holdings: Factor & { assets: { symbol: string; valueUsd8: Big }[]; stockValueUsd8: Big; totalValueUsd8: Big }
  /** The repayment record. The Robinhood underwriter names it robinhoodHistory; any `*History` key with this shape is accepted. */
  robinhoodHistory?: RepaymentFactor
  [key: string]: unknown
}
type RepaymentFactor = Factor & { onTime: number; late: number; defaults: number; completed: number; clean: number }

/** Finds the repayment record on a history object, whatever the producer named it. */
function repaymentRecord(history: WalletHistoryLike): RepaymentFactor | undefined {
  for (const [k, v] of Object.entries(history)) {
    if (k.endsWith('History') && v && typeof v === 'object' && 'onTime' in v && 'status' in v) return v as RepaymentFactor
  }
  return undefined
}

const usd8 = (v: Big) => Number(BigInt(v) / 1_000_000n) / 100
const wholeUsd = (v: Big) => Math.floor(usd8(v))
const count = (n: unknown, field: string) => {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error(`Invalid history: ${field} must be a non-negative integer`)
  return n
}

export function featuresFromHistory(history: WalletHistoryLike): CreditFeatures {
  const h = history.holdings
  const repay = repaymentRecord(history)
  const holdingsOk = h?.status === 'available'
  return validateFeatures({
    accountAgeDays: history.accountAge?.status === 'available' ? count(history.accountAge.days, 'accountAge.days') : null,
    txCount: history.txCount?.status === 'available' ? count(history.txCount.count, 'txCount.count') : null,
    stockHoldingsUsd: holdingsOk ? wholeUsd(h.stockValueUsd8) : null,
    totalHoldingsUsd: holdingsOk ? wholeUsd(h.totalValueUsd8) : null,
    holdings: (h?.assets ?? []).map(a => ({ symbol: String(a.symbol), valueUsd: wholeUsd(a.valueUsd8) })).filter(a => a.valueUsd > 0).sort((a, b) => b.valueUsd - a.valueUsd),
    repayments: repay?.status === 'available'
      ? { onTime: count(repay.onTime, 'onTime'), late: count(repay.late, 'late'), defaults: count(repay.defaults, 'defaults'), completed: count(repay.completed, 'completed'), clean: count(repay.clean, 'clean') }
      : null,
  })
}

const nullableCount = (v: unknown, field: string) => v === null ? null : count(v, field)
/** Validates features from any caller (HTTP body included). Throws on anything that is not a CreditFeatures. */
export function validateFeatures(f: unknown): CreditFeatures {
  if (!f || typeof f !== 'object') throw new Error('Invalid features: expected an object')
  const x = f as Record<string, unknown>
  const allowed = ['accountAgeDays', 'txCount', 'stockHoldingsUsd', 'totalHoldingsUsd', 'holdings', 'repayments']
  for (const k of Object.keys(x)) if (!allowed.includes(k)) throw new Error(`Invalid features: unexpected field ${k}`)
  if (!Array.isArray(x.holdings) || x.holdings.length > 20) throw new Error('Invalid features: holdings must be an array of at most 20 entries')
  const holdings = x.holdings.map((a, i) => {
    const r = a as Record<string, unknown>
    if (typeof r?.symbol !== 'string' || !/^[A-Z0-9.]{1,12}$/.test(r.symbol)) throw new Error(`Invalid features: holdings[${i}].symbol`)
    return { symbol: r.symbol, valueUsd: count(r.valueUsd, `holdings[${i}].valueUsd`) }
  })
  let repayments: CreditFeatures['repayments'] = null
  if (x.repayments !== null) {
    const r = x.repayments as Record<string, unknown> | undefined
    if (!r || typeof r !== 'object') throw new Error('Invalid features: repayments must be an object or null')
    repayments = { onTime: count(r.onTime, 'repayments.onTime'), late: count(r.late, 'repayments.late'), defaults: count(r.defaults, 'repayments.defaults'), completed: count(r.completed, 'repayments.completed'), clean: count(r.clean, 'repayments.clean') }
  }
  return {
    accountAgeDays: nullableCount(x.accountAgeDays, 'accountAgeDays'),
    txCount: nullableCount(x.txCount, 'txCount'),
    stockHoldingsUsd: nullableCount(x.stockHoldingsUsd, 'stockHoldingsUsd'),
    totalHoldingsUsd: nullableCount(x.totalHoldingsUsd, 'totalHoldingsUsd'),
    holdings,
    repayments,
  }
}

/** Stable JSON with sorted keys, so the same features always hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(typeof value === 'bigint' ? value.toString() : value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/** What Noren stores in place of the features: a SHA-256 commitment, so a decision can be matched to its inputs later without keeping them. */
export const featuresSha256 = (f: CreditFeatures) => createHash('sha256').update(canonicalJson(f)).digest('hex')
