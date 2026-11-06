// Credit policy caps that bound every 0G decision. The model proposes terms; this file decides
// whether those terms are allowed. Nothing here invents or adjusts a decision: a proposal that
// breaks a cap is refused, never clamped.
import type { CreditFeatures } from './features.ts'

export const MAX_TIER = 4

/** Highest credit limit (whole USDG) each tier may carry. Matches the deterministic scorer's ceiling (base x2). */
export const TIER_MAX_LIMIT_USDG = [0, 500, 2_000, 5_000, 10_000] as const

/** Lowest collateral ratio (basis points) each tier may use. Tier 0 has no line, so its entry is unused. */
export const TIER_MIN_COLLATERAL_BPS = [0, 15_000, 14_000, 13_000, 12_500] as const

/** NorenCredit.minCollateralRatioBps() on the deployed config (liquidation threshold 110% + 10 points). */
export const CONTRACT_MIN_COLLATERAL_BPS = 12_000

/** Sanity ceiling: a ratio above 300% is not a credit line anyone would use. */
export const MAX_COLLATERAL_BPS = 30_000

export const RATIONALE_MAX_CHARS = 400
export const MAX_RISK_FLAGS = 5
export const RISK_FLAG_MAX_CHARS = 60

export type CreditDecision = {
  tier: number
  limitUsdg: number
  collateralRatioBps: number
  rationale: string
  riskFlags: string[]
}

export type PolicyOptions = { contractMinCollateralBps?: number }

/** The tier ceiling the features allow, with the reason for each guard that applied. */
export function tierCeiling(features: CreditFeatures): { ceiling: number; guards: string[] } {
  let ceiling = MAX_TIER
  const guards: string[] = []
  const cap = (to: number, why: string) => { if (to < ceiling) ceiling = to; guards.push(why) }
  if (features.repayments && features.repayments.defaults > 0) cap(1, 'a past liquidation caps the tier at 1')
  if (features.accountAgeDays !== null && features.accountAgeDays < 7) cap(1, 'an account younger than 7 days caps the tier at 1')
  if (features.accountAgeDays === null) cap(2, 'unknown account age caps the tier at 2')
  if (features.stockHoldingsUsd === null || features.totalHoldingsUsd === null) cap(2, 'unknown holdings cap the tier at 2')
  return { ceiling, guards }
}

/** Throws a readable error if the decision breaks any cap. Returns the decision unchanged otherwise. */
export function enforcePolicy(decision: CreditDecision, features: CreditFeatures, opts: PolicyOptions = {}): CreditDecision {
  const floor = opts.contractMinCollateralBps ?? CONTRACT_MIN_COLLATERAL_BPS
  const { tier, limitUsdg, collateralRatioBps } = decision
  if (tier < 0 || tier > MAX_TIER) throw new PolicyError(`tier ${tier} is outside 0..${MAX_TIER}`)
  const { ceiling, guards } = tierCeiling(features)
  if (tier > ceiling) throw new PolicyError(`tier ${tier} exceeds the ceiling ${ceiling} (${guards.join('; ')})`)
  if (tier === 0) {
    if (limitUsdg !== 0 || collateralRatioBps !== 0) throw new PolicyError('tier 0 must have limit 0 and collateral ratio 0')
    return decision
  }
  if (limitUsdg <= 0) throw new PolicyError(`tier ${tier} needs a positive limit`)
  if (limitUsdg > TIER_MAX_LIMIT_USDG[tier]) throw new PolicyError(`limit ${limitUsdg} USDG exceeds the tier ${tier} cap of ${TIER_MAX_LIMIT_USDG[tier]} USDG`)
  if (collateralRatioBps < TIER_MIN_COLLATERAL_BPS[tier]) throw new PolicyError(`collateral ratio ${collateralRatioBps} bps is below the tier ${tier} floor of ${TIER_MIN_COLLATERAL_BPS[tier]} bps`)
  if (collateralRatioBps < floor) throw new PolicyError(`collateral ratio ${collateralRatioBps} bps is below the contract floor of ${floor} bps`)
  if (collateralRatioBps > MAX_COLLATERAL_BPS) throw new PolicyError(`collateral ratio ${collateralRatioBps} bps is above ${MAX_COLLATERAL_BPS} bps`)
  return decision
}

export class PolicyError extends Error {
  constructor(message: string) { super(`Policy cap: ${message}`); this.name = 'PolicyError' }
}

/** Human-readable policy table, sent to the model so it knows the caps it must stay inside. */
export function policyText(): string {
  const rows = [1, 2, 3, 4].map(t => `- tier ${t}: limit 1..${TIER_MAX_LIMIT_USDG[t]} USDG, collateral ratio ${TIER_MIN_COLLATERAL_BPS[t]}..${MAX_COLLATERAL_BPS} bps`)
  return [
    '- tier 0: decline. limitUsdg 0 and collateralRatioBps 0.',
    ...rows,
    '- a past liquidation (repayments.defaults > 0) caps the tier at 1',
    '- an account younger than 7 days caps the tier at 1',
    '- a null accountAgeDays, stockHoldingsUsd or totalHoldingsUsd means the data was unavailable; it caps the tier at 2',
  ].join('\n')
}
