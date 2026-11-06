// Transparent deterministic score. Every factor carries its value, points, source and status.
// History can only improve terms. A wallet that holds Stock Tokens on the chain where the line
// would be locked always gets at least the collateral-only floor (tier 1, 150% collateral,
// limit = min(250 USDG, 50% of the stock's Chainlink value)), because such a line is fully secured.
import type { WalletHistory } from './history.js'

export type ScoreFactor = {
  id: string
  label: string
  value: number | string
  points: number
  maxPoints: number
  source: string
  status: 'available' | 'unavailable'
  note: string
}
export type WalletScore = {
  score: number
  tier: number
  limitUsdg: bigint
  collateralRatioBps: number
  /** 'history' when the score alone set the terms, 'collateral-floor' when the floor did. */
  basis: 'history' | 'collateral-floor' | 'declined'
  factors: ScoreFactor[]
}

export const TIER_BASE_LIMIT_USDG = [0, 250, 1_000, 2_500, 5_000] as const
export const TIER_COLLATERAL_BPS = [0, 15_000, 14_000, 13_000, 12_500] as const
export const FLOOR_LIMIT_USDG = 250
export const FLOOR_STOCK_SHARE = 0.5

/** Collateral-only terms for a wallet with Stock Tokens; null when it holds none (or holdings are unknown). */
export function collateralFloor(history: WalletHistory): { tier: 1; limitUsdg: bigint; collateralRatioBps: 15_000 } | null {
  if (history.holdings.status !== 'available' || history.holdings.stockValueUsd8 === 0n) return null
  // 50% of the stock value in USDG base units (6 decimals); USD8 -> USD6 is /100.
  const half6 = (history.holdings.stockValueUsd8 * 50n) / 100n / 100n
  const cap6 = BigInt(FLOOR_LIMIT_USDG) * 1_000_000n
  const limit = half6 < cap6 ? half6 : cap6
  if (limit < 1_000_000n) return null // under 1 USDG of credit is not a line
  return { tier: 1, limitUsdg: (limit / 1_000_000n) * 1_000_000n, collateralRatioBps: 15_000 }
}

/** A Reclaim (zkTLS) proof the Noren server verified for this wallet: an off-chain fact, no raw values. */
export type OffchainProof = { provider: string; proofId: string }
export const OFFCHAIN_PROOF_POINTS = 10

export function scoreWallet(history: WalletHistory, extras: { offchain?: OffchainProof | null } = {}): WalletScore {
  const factors: ScoreFactor[] = []
  const add = (id: string, label: string, value: number | string, points: number, maxPoints: number, data: { source: string; status: 'available' | 'unavailable'; note: string }) =>
    factors.push({ id, label, value, points: data.status === 'available' ? Math.round(points * 10) / 10 : 0, maxPoints, ...data })

  const d = history.accountAge.days
  add('accountAge', 'Account age (days)', history.accountAge.status === 'available' ? d : 'unknown', d < 7 ? 0 : Math.min(25, ((d - 7) * 25) / 173), 25, history.accountAge)
  const n = history.txCount.count
  add('txCount', 'Transactions on Robinhood mainnet', history.txCount.status === 'available' ? n : 'unknown', Math.min(20, (Math.log1p(n) / Math.log1p(500)) * 20), 20, history.txCount)
  const stockUsd = Number(history.holdings.stockValueUsd8) / 1e8
  const totalUsd = Number(history.holdings.totalValueUsd8) / 1e8
  add('stockHoldings', 'Stock Token holdings (USD)', Math.floor(stockUsd), Math.min(25, (stockUsd / 10_000) * 25), 25, history.holdings)
  add('totalHoldings', 'Total holdings incl. ETH and USDG (USD)', Math.floor(totalUsd), Math.min(10, (totalUsd / 25_000) * 10), 10, history.holdings)
  const prior = history.repaymentHistory
  const repayment = prior.defaults > 0 ? 0 : Math.max(0, Math.min(20, 10 + prior.onTime * 2.5 - prior.late * 5))
  add('repayments', 'Noren repayment record', `${prior.onTime} on time, ${prior.late} late, ${prior.defaults} liquidations`, repayment, 20, prior)
  const proof = extras.offchain
  add('offchainProof', 'Off-chain fact proved with Reclaim (zkTLS)', proof ? proof.provider : 'not proved', OFFCHAIN_PROOF_POINTS, OFFCHAIN_PROOF_POINTS, proof
    ? { source: `reclaim:${proof.proofId.slice(0, 18)}`, status: 'available', note: `Verified by the Noren server with the Reclaim SDK (${proof.provider})` }
    : { source: 'reclaim', status: 'unavailable', note: 'Not proved yet: Credit → Raise your limit → Prove with Reclaim' })

  const score = Math.max(0, Math.min(100, Math.round(factors.reduce((sum, f) => sum + f.points, 0))))
  let tier = score < 30 ? 0 : score < 50 ? 1 : score < 65 ? 2 : score < 80 ? 3 : 4
  if (prior.status === 'available' && prior.defaults > 0) tier = Math.min(tier, 1)
  const base = TIER_BASE_LIMIT_USDG[tier]
  const extra = history.holdings.status === 'available' ? Math.floor(stockUsd * 0.1) : 0
  let limitUsdg = BigInt(tier === 0 ? 0 : Math.min(base * 2, base + extra)) * 1_000_000n
  let collateralRatioBps: number = TIER_COLLATERAL_BPS[tier]
  let basis: WalletScore['basis'] = tier === 0 ? 'declined' : 'history'

  const floor = collateralFloor(history)
  if (floor && (tier === 0 || floor.limitUsdg > limitUsdg)) {
    if (tier === 0) {
      tier = 1
      collateralRatioBps = floor.collateralRatioBps
      basis = 'collateral-floor'
    }
    if (floor.limitUsdg > limitUsdg) limitUsdg = floor.limitUsdg
  }
  return { score, tier, limitUsdg, collateralRatioBps, basis, factors }
}
