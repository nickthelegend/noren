// Live credit check on 0G Private Computer. Needs ZG_PC_API_KEY (an sk- key with trust mode Private).
// Without the key this test is SKIPPED under its "Setup required" title in `pnpm test`, and FAILS
// under `pnpm test:live` (ZG_LIVE_REQUIRED=1). A skip is never counted as a pass.
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env.ts'
import { attestationLogEntry, creditCheck, featuresSha256, type CreditFeatures } from '../src/index.ts'

loadEnv()
const key = process.env.ZG_PC_API_KEY
const required = process.env.ZG_LIVE_REQUIRED === '1'
const SETUP = 'Setup required: ZG_PC_API_KEY (sign up at https://pc.0g.ai, create a private-mode API key, put it in the gitignored .env as ZG_PC_API_KEY)'
// An applicant profile (input data, not a stand-in for 0G): 14 months old, active, holds NVDA and TSLA tokens, clean record.
const applicant: CreditFeatures = { accountAgeDays: 420, txCount: 310, stockHoldingsUsd: 18_250, totalHoldingsUsd: 21_400, holdings: [{ symbol: 'NVDA', valueUsd: 12_000 }, { symbol: 'TSLA', valueUsd: 6_250 }, { symbol: 'USDG', valueUsd: 3_150 }], repayments: { onTime: 8, late: 0, defaults: 0, completed: 2, clean: 2 } }

describe('live credit check on 0G Private Computer', () => {
  if (!key && !required) { it.skip(SETUP, () => {}); return }
  it('returns a bounded decision with a 0G request ID and a verified TEE signature', async () => {
    if (!key) throw new Error(SETUP)
    const r = await creditCheck(applicant)
    console.log(JSON.stringify(r, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2))
    if (r.status === 'refused') throw new Error(`Refused: ${r.reason}`)
    expect(r.evidence.requestId).toMatch(/\S{8,}/)
    expect(r.evidence.trustMode).toBe('private')
    expect(r.evidence.teeVerified === true || (r.evidence.independent as { status: string }).status === 'verified').toBe(true)
    expect(r.evidence.independent.status).not.toBe('failed')
    expect(r.featuresSha256).toBe(featuresSha256(applicant))
    console.log('attestation log entry', attestationLogEntry(r))
  })
})
