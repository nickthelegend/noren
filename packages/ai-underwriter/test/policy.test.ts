// Offline tests: schema, policy caps, features, the exact 0G request, refusal paths, storage, HTTP.
// Nothing here stands in for 0G: no request leaves the machine, and no test fakes a 0G response.
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  buildChatRequest, buildMessages, creditCheck, createCreditServer, CONTRACT_MIN_COLLATERAL_BPS, decisionDigest, decisionJsonSchema,
  DEFAULT_MODEL, enforcePolicy, featuresFromHistory, featuresSha256, parseDecision, resolveConfig, SetupRequiredError, tierCeiling,
  TIER_MAX_LIMIT_USDG, TIER_MIN_COLLATERAL_BPS, toAttestationTerms, TRUST_MODE_HEADER, validateDecision, validateFeatures,
  type CreditDecision, type CreditFeatures,
} from '../src/index.ts'

const strong: CreditFeatures = { accountAgeDays: 400, txCount: 320, stockHoldingsUsd: 18_250, totalHoldingsUsd: 21_400, holdings: [{ symbol: 'NVDA', valueUsd: 12_000 }, { symbol: 'TSLA', valueUsd: 6_250 }], repayments: { onTime: 8, late: 0, defaults: 0, completed: 2, clean: 2 } }
const ok: CreditDecision = { tier: 4, limitUsdg: 8_000, collateralRatioBps: 12_500, rationale: 'Long history and large Stock Token holdings. Every past installment was on time.', riskFlags: [] }
const BORROWER = '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3'

describe('decision schema', () => {
  it('accepts a well-formed decision', () => expect(validateDecision(ok)).toEqual(ok))
  it('rejects extra and missing fields', () => {
    expect(() => validateDecision({ ...ok, approve: true })).toThrow(/unexpected field "approve"/)
    const { rationale: _r, ...rest } = ok
    expect(() => validateDecision(rest)).toThrow(/missing field "rationale"/)
  })
  it('rejects wrong types and out-of-range numbers', () => {
    expect(() => validateDecision({ ...ok, tier: 2.5 })).toThrow(/tier/)
    expect(() => validateDecision({ ...ok, tier: 5 })).toThrow(/tier/)
    expect(() => validateDecision({ ...ok, tier: '4' })).toThrow(/tier/)
    expect(() => validateDecision({ ...ok, limitUsdg: 10_001 })).toThrow(/limitUsdg/)
    expect(() => validateDecision({ ...ok, collateralRatioBps: -1 })).toThrow(/collateralRatioBps/)
    expect(() => validateDecision({ ...ok, riskFlags: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow(/riskFlags/)
  })
  it('rejects a rationale that leaks an address or is empty', () => {
    expect(() => validateDecision({ ...ok, rationale: `Wallet ${BORROWER} is fine.` })).toThrow(/address/)
    expect(() => validateDecision({ ...ok, rationale: '  ' })).toThrow(/rationale/)
  })
  it('parses plain JSON, a fenced block and a leading think block, and refuses prose', () => {
    expect(parseDecision(JSON.stringify(ok))).toEqual(ok)
    expect(parseDecision('```json\n' + JSON.stringify(ok) + '\n```')).toEqual(ok)
    expect(parseDecision('<think>weighing factors</think>\n' + JSON.stringify(ok))).toEqual(ok)
    expect(() => parseDecision('Sure! ' + JSON.stringify(ok))).toThrow(/single JSON object/)
    expect(() => parseDecision('{"tier": 4,')).toThrow(/single JSON object|invalid JSON/)
  })
  it('sends a strict JSON schema with every field required', () => {
    expect(decisionJsonSchema.strict).toBe(true)
    expect(decisionJsonSchema.schema.additionalProperties).toBe(false)
    expect([...decisionJsonSchema.schema.required].sort()).toEqual(Object.keys(decisionJsonSchema.schema.properties).sort())
  })
})

describe('policy caps (refuse, never clamp)', () => {
  it('passes a decision inside every cap, unchanged', () => expect(enforcePolicy(ok, strong)).toBe(ok))
  it('refuses a limit above the tier cap', () => {
    for (const tier of [1, 2, 3, 4]) expect(() => enforcePolicy({ ...ok, tier, collateralRatioBps: TIER_MIN_COLLATERAL_BPS[tier], limitUsdg: TIER_MAX_LIMIT_USDG[tier] + 1 }, strong)).toThrow(/exceeds the tier .* cap/)
  })
  it('refuses a collateral ratio below the tier floor or the contract floor', () => {
    expect(() => enforcePolicy({ ...ok, tier: 2, limitUsdg: 1_000, collateralRatioBps: 13_000 }, strong)).toThrow(/below the tier 2 floor/)
    expect(() => enforcePolicy(ok, strong, { contractMinCollateralBps: 13_000 })).toThrow(/contract floor/)
    expect(CONTRACT_MIN_COLLATERAL_BPS).toBe(12_000)
  })
  it('tier 0 means no line at all', () => {
    expect(enforcePolicy({ ...ok, tier: 0, limitUsdg: 0, collateralRatioBps: 0 }, strong).tier).toBe(0)
    expect(() => enforcePolicy({ ...ok, tier: 0, limitUsdg: 100, collateralRatioBps: 0 }, strong)).toThrow(/tier 0/)
    expect(() => enforcePolicy({ ...ok, tier: 1, limitUsdg: 0, collateralRatioBps: 15_000 }, strong)).toThrow(/positive limit/)
  })
  it('a past liquidation, a new account or missing data caps the tier', () => {
    const liquidated = { ...strong, repayments: { ...strong.repayments!, defaults: 1 } }
    expect(tierCeiling(liquidated).ceiling).toBe(1)
    expect(() => enforcePolicy({ ...ok, tier: 2, limitUsdg: 1_000, collateralRatioBps: 14_000 }, liquidated)).toThrow(/ceiling 1/)
    expect(tierCeiling({ ...strong, accountAgeDays: 3 }).ceiling).toBe(1)
    expect(tierCeiling({ ...strong, stockHoldingsUsd: null, totalHoldingsUsd: null }).ceiling).toBe(2)
    expect(tierCeiling({ ...strong, accountAgeDays: null }).ceiling).toBe(2)
    expect(tierCeiling(strong)).toEqual({ ceiling: 4, guards: [] })
  })
})

describe('features from the Robinhood underwriter history', () => {
  const history = {
    address: BORROWER,
    accountAge: { status: 'available' as const, source: 'blockscout', note: '', days: 212 },
    txCount: { status: 'available' as const, source: 'rpc', note: '', count: 57 },
    holdings: { status: 'available' as const, source: 'rpc', note: '', stockValueUsd8: 1_855_600_000_000n, totalValueUsd8: '2_000_000_000_000'.replaceAll('_', ''), assets: [
      { symbol: 'NVDA', valueUsd8: 1_855_600_000_000n }, { symbol: 'USDG', valueUsd8: '144400000000' }, { symbol: 'ETH', valueUsd8: 0n },
    ] },
    robinhoodHistory: { status: 'available' as const, source: 'logs', note: '', onTime: 4, late: 1, defaults: 0, completed: 1, clean: 0, events: [] },
  }
  it('maps bigint and string USD8 values to whole dollars and drops zero holdings', () => {
    const f = featuresFromHistory(history)
    expect(f).toEqual({ accountAgeDays: 212, txCount: 57, stockHoldingsUsd: 18_556, totalHoldingsUsd: 20_000, holdings: [{ symbol: 'NVDA', valueUsd: 18_556 }, { symbol: 'USDG', valueUsd: 1_444 }], repayments: { onTime: 4, late: 1, defaults: 0, completed: 1, clean: 0 } })
  })
  it('never carries the wallet address', () => expect(JSON.stringify(featuresFromHistory(history))).not.toMatch(/0x[0-9a-fA-F]{40}/))
  it('turns unavailable factors into null, not zero', () => {
    const f = featuresFromHistory({ ...history, accountAge: { ...history.accountAge, status: 'unavailable', days: 0 }, holdings: { ...history.holdings, status: 'unavailable' }, robinhoodHistory: { ...history.robinhoodHistory, status: 'unavailable' } })
    expect(f.accountAgeDays).toBeNull(); expect(f.stockHoldingsUsd).toBeNull(); expect(f.repayments).toBeNull()
  })
  it('rejects features with unknown fields (such as an address) or bad values', () => {
    expect(() => validateFeatures({ ...strong, address: BORROWER })).toThrow(/unexpected field address/)
    expect(() => validateFeatures({ ...strong, txCount: -1 })).toThrow(/txCount/)
    expect(() => validateFeatures({ ...strong, holdings: [{ symbol: 'nvda<script>', valueUsd: 1 }] })).toThrow(/symbol/)
  })
  it('hashes features canonically (key order does not matter)', () => {
    const reordered = JSON.parse(JSON.stringify({ repayments: strong.repayments, holdings: strong.holdings, totalHoldingsUsd: strong.totalHoldingsUsd, stockHoldingsUsd: strong.stockHoldingsUsd, txCount: strong.txCount, accountAgeDays: strong.accountAgeDays }))
    expect(featuresSha256(reordered)).toBe(featuresSha256(strong))
    expect(featuresSha256({ ...strong, txCount: 321 })).not.toBe(featuresSha256(strong))
  })
})

describe('the request sent to 0G Private Computer', () => {
  const cfg = resolveConfig({ apiKey: 'sk-test-not-a-real-key', network: 'mainnet', model: DEFAULT_MODEL })
  const req = buildChatRequest(buildMessages(strong), cfg, decisionJsonSchema)
  it('targets the mainnet Router and 0GM-1.0', () => { expect(req.url).toBe('https://router-api.0g.ai/v1/chat/completions'); expect(req.body.model).toBe('0gm-1.0-35b-a3b') })
  it('always pins the private (TeeML) tier and asks the Router to verify the TEE signature', () => {
    expect(req.headers[TRUST_MODE_HEADER]).toBe('private')
    expect(req.body.verify_tee).toBe(true)
  })
  it('asks for schema-constrained JSON at temperature 0', () => {
    expect(req.body.response_format).toEqual({ type: 'json_schema', json_schema: decisionJsonSchema })
    expect(req.body.temperature).toBe(0)
  })
  it('puts the policy caps in the prompt and no address anywhere', () => {
    const text = JSON.stringify(req.body.messages)
    expect(text).toContain('tier 4: limit 1..10000 USDG, collateral ratio 12500..30000 bps')
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/)
  })
  it('requires an sk- key', () => {
    expect(() => buildChatRequest([], resolveConfig({ apiKey: '' }), decisionJsonSchema)).toThrow(SetupRequiredError)
    expect(() => buildChatRequest([], resolveConfig({ apiKey: 'mk-management' }), decisionJsonSchema)).toThrow(/sk- API key/)
  })
})

describe('refusal without a key (no fallback decision)', () => {
  it('refuses with Setup required and returns no terms', async () => {
    const r = await creditCheck(strong, { apiKey: '' })
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.setupRequired).toBe(true)
    expect(r.reason).toMatch(/^Setup required: ZG_PC_API_KEY/)
    expect(r).not.toHaveProperty('terms')
    expect(r).not.toHaveProperty('decision')
  })
})

describe('decision digest and attestation terms', () => {
  const ev = { requestId: '0852f405-6c56-40c2-a800-e6fd70785065', provider: '0xf4FB8d2bD856e672b5f9848b0eD235A20079B250', chatId: 'chat-1', model: DEFAULT_MODEL }
  it('converts the limit to USDG 6-decimal base units', () => expect(toAttestationTerms(ok)).toEqual({ tier: 4, limitUsdg: 8_000_000_000n, collateralRatioBps: 12_500 }))
  it('binds the 0G request ID into the digest', () => {
    const h = featuresSha256(strong)
    expect(decisionDigest(ok, ev, h)).toBe(decisionDigest(ok, { ...ev }, h))
    expect(decisionDigest(ok, { ...ev, requestId: 'other' }, h)).not.toBe(decisionDigest(ok, ev, h))
    expect(decisionDigest({ ...ok, limitUsdg: 7_999 }, ev, h)).not.toBe(decisionDigest(ok, ev, h))
  })
})

describe('HTTP endpoint (port block 8740-8749)', () => {
  it('reports Setup required, refuses with 503, validates input and stores no features', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noren-ai-'))
    const decisionsPath = join(dir, 'decisions.jsonl')
    const server = createCreditServer({ decisionsPath, robinhoodUnderwriterUrl: 'http://127.0.0.1:1', check: { apiKey: '' } })
    await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(8741, '127.0.0.1', res) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const health = await (await fetch(`${base}/health`)).json()
      expect(health).toMatchObject({ ok: true, model: DEFAULT_MODEL, trustMode: 'private' })
      expect(health.setup).toMatch(/^Setup required: ZG_PC_API_KEY/)
      const r = await fetch(`${base}/v1/credit-check`, { method: 'POST', body: JSON.stringify({ features: strong }) })
      expect(r.status).toBe(503)
      expect((await r.json()).reason).toMatch(/Setup required/)
      const bad = await fetch(`${base}/v1/credit-check`, { method: 'POST', body: JSON.stringify({ features: { ...strong, address: BORROWER } }) })
      expect(bad.status).toBe(400)
      const wallet = await fetch(`${base}/v1/credit-check/wallet`, { method: 'POST', body: JSON.stringify({ address: 'nope' }) })
      expect(wallet.status).toBe(400)
      const stored = await readFile(decisionsPath, 'utf8')
      expect(stored.trim().split('\n')).toHaveLength(1)
      expect(stored).not.toMatch(/holdings|NVDA|accountAgeDays|18250/)
      expect(JSON.parse(stored)).toMatchObject({ status: 'refused', featuresSha256: featuresSha256(strong) })
      const list = await (await fetch(`${base}/v1/decisions`)).json()
      expect(list.decisions).toHaveLength(1)
    } finally {
      await new Promise(res => server.close(res))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
