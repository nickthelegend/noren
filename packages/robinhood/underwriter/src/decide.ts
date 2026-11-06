// Picks the credit terms that get signed.
// 1. The 0G credit check (sealed model on 0G Private Computer, bounded by policy caps) runs first.
// 2. Only when 0G is not configured ("Setup required") does the deterministic score decide, and
//    the decision says so.
// 3. History can only improve terms: a wallet holding Stock Tokens on the contract chain always
//    gets at least the collateral-only floor (tier 1, 150%, min(250 USDG, 50% of stock value)),
//    whatever 0G or the score concluded, because that line is fully secured. The floor sits inside
//    the 0G policy caps (tier 1: limit <= 500 USDG, ratio >= 15000 bps).
// A 0G refusal for any other reason (unverified TEE, policy cap broken, bad output) never becomes a
// history-based approval; only the floor can still apply.
import { attestationLogEntry, creditCheck, featuresFromHistory, type CreditCheckResult } from '@noren/ai-underwriter'
import type { WalletHistory } from './history.js'
import { collateralFloor, scoreWallet, type WalletScore } from './score.js'

export type Terms = { tier: number; limitUsdg: bigint; collateralRatioBps: number }
type Decided = Extract<CreditCheckResult, { status: 'approved' | 'declined' }>
type Refused = Extract<CreditCheckResult, { status: 'refused' }>

export type Decision = {
  /** Who set the terms. */
  source: '0g' | 'deterministic-score' | 'collateral-floor' | 'refused'
  sign: boolean
  terms: Terms | null
  note: string
  score: WalletScore
  zg: CreditCheckResult
  /** Present when 0G decided: what the signer logs next to the EIP-712 signature. */
  logEntry: ReturnType<typeof attestationLogEntry> | null
}

export async function decideTerms(history: WalletHistory): Promise<Decision> {
  const score = scoreWallet(history)
  const floor = collateralFloor(history)
  const zg = await creditCheck(featuresFromHistory(history))

  if (zg.status !== 'refused') {
    const d = zg as Decided
    const logEntry = attestationLogEntry(d)
    if (d.status === 'approved') {
      const terms = { ...d.terms }
      let note = '0G credit check approved'
      if (floor && floor.limitUsdg > terms.limitUsdg) {
        terms.limitUsdg = floor.limitUsdg
        note += '; limit raised to the collateral-only floor'
      }
      return { source: '0g', sign: true, terms, note, score, zg, logEntry }
    }
    if (floor) {
      return { source: 'collateral-floor', sign: true, terms: floor, note: '0G declined on history; the Stock Token collateral fully secures a tier-1 line', score, zg, logEntry }
    }
    return { source: '0g', sign: false, terms: null, note: '0G credit check declined and the wallet holds no Stock Tokens to secure a line', score, zg, logEntry }
  }

  const refused = zg as Refused
  if (refused.setupRequired) {
    const terms = score.tier > 0 ? { tier: score.tier, limitUsdg: score.limitUsdg, collateralRatioBps: score.collateralRatioBps } : null
    const basis = score.basis === 'collateral-floor' ? 'collateral-only floor' : 'deterministic score'
    return {
      source: score.basis === 'collateral-floor' ? 'collateral-floor' : 'deterministic-score',
      sign: terms !== null,
      terms,
      note: `0G credit check did not run (${refused.reason}); terms from the ${basis}${terms ? '' : ': declined'}`,
      score,
      zg,
      logEntry: null,
    }
  }
  if (floor) {
    return { source: 'collateral-floor', sign: true, terms: floor, note: `0G refused (${refused.reason}); only the fully secured collateral-only floor applies`, score, zg, logEntry: null }
  }
  return { source: 'refused', sign: false, terms: null, note: `0G credit check refused: ${refused.reason}`, score, zg, logEntry: null }
}
