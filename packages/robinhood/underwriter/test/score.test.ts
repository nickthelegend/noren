import { describe, it, expect } from 'vitest'
import { scoreWallet } from '../src/score.js'
import type { WalletHistory } from '../src/history.js'
const available = { status: 'available' as const, source: 'test input', note: '' }
const make = (overrides: Partial<WalletHistory> = {}): WalletHistory => ({
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  accountAge: { ...available, days: 180 }, txCount: { ...available, count: 500 },
  holdings: { ...available, assets: [], stockValueUsd8: 1_000_000_000_000n, totalValueUsd8: 2_500_000_000_000n },
  repaymentHistory: { ...available, onTime: 4, late: 0, defaults: 0, completed: 1, clean: 1, events: [] }, ...overrides,
})
describe('scoreWallet', () => {
  it('awards all points at thresholds and caps credit limit', () => { const s = scoreWallet(make()); expect(s.score).toBe(100); expect(s.tier).toBe(4); expect(s.limitUsdg).toBe(6_000_000_000n); expect(s.collateralRatioBps).toBe(12500) })
  it('crosses each score tier threshold', () => {
    const base = make({ accountAge: { ...available, days: 7 }, txCount: { ...available, count: 0 }, holdings: { ...available, assets: [], stockValueUsd8: 0n, totalValueUsd8: 0n }, repaymentHistory: { ...available, onTime: 0, late: 0, defaults: 0, completed: 0, clean: 0, events: [] } })
    expect(scoreWallet(base).tier).toBe(0)
    const withTx = { ...base, txCount: { ...available, count: 500 } }
    expect(scoreWallet(withTx).tier).toBe(1)
    const withAge = { ...withTx, accountAge: { ...available, days: 145 } }
    expect(scoreWallet(withAge).tier).toBe(2)
    const withStock = { ...withAge, holdings: { ...available, assets: [], stockValueUsd8: 5300n * 100_000_000n, totalValueUsd8: 5300n * 100_000_000n } }
    expect(scoreWallet(withStock).tier).toBe(3)
    const top = { ...withTx, accountAge: { ...available, days: 180 }, holdings: { ...available, assets: [], stockValueUsd8: 8500n * 100_000_000n, totalValueUsd8: 8500n * 100_000_000n } }
    expect(scoreWallet(top).tier).toBe(4)
  })
  it('caps tier after liquidation', () => { const s = scoreWallet(make({ repaymentHistory: { ...available, onTime: 20, late: 0, defaults: 1, completed: 1, clean: 0, events: [] } })); expect(s.tier).toBe(1); expect(s.factors.find(f => f.id === 'repayments')?.points).toBe(0) })
  it('gives unavailable factors zero points and a reason', () => { const h = make({ holdings: { status: 'unavailable', source: 'rpc', note: 'feed unavailable', assets: [], stockValueUsd8: 0n, totalValueUsd8: 0n } }); const s = scoreWallet(h); expect(s.factors.filter(f => f.id.includes('Holdings')).every(f => f.points === 0 && f.note.includes('feed unavailable'))).toBe(true) })
})

describe('collateral-only floor', () => {
  const unknownAge = { status: 'unavailable' as const, source: 'robinhood-mainnet:eth_getLogs(Transfer)', note: 'No activity on Robinhood mainnet yet', days: 0 }
  const fresh = (stockUsd: bigint) =>
    make({
      accountAge: unknownAge,
      txCount: { ...available, count: 0 },
      holdings: { ...available, assets: [], stockValueUsd8: stockUsd * 100_000_000n, totalValueUsd8: stockUsd * 100_000_000n },
      repaymentHistory: { ...available, onTime: 0, late: 0, defaults: 0, completed: 0, clean: 0, events: [] },
    })

  it('gives a fresh wallet holding one TSLA a fully secured tier-1 line', () => {
    const s = scoreWallet(fresh(347n))
    expect(s.score).toBeLessThan(30) // history alone would decline
    expect(s.basis).toBe('collateral-floor')
    expect(s.tier).toBe(1)
    expect(s.collateralRatioBps).toBe(15000)
    expect(s.limitUsdg).toBe(173_000_000n) // 50% of $347, whole USDG
    // fully secured: limit x 150% stays within the stock's value
    expect((s.limitUsdg * 15000n) / 10000n).toBeLessThanOrEqual(347_000_000n)
  })

  it('caps the floor limit at 250 USDG', () => {
    const s = scoreWallet(fresh(10_000n))
    expect(s.tier).toBeGreaterThanOrEqual(1)
    expect(s.limitUsdg).toBeGreaterThanOrEqual(250_000_000n)
    expect(scoreWallet(fresh(1_000n)).limitUsdg).toBe(250_000_000n)
  })

  it('declines a fresh wallet without Stock Tokens and shows every factor', () => {
    const s = scoreWallet(fresh(0n))
    expect(s.tier).toBe(0)
    expect(s.basis).toBe('declined')
    expect(s.limitUsdg).toBe(0n)
    expect(s.factors.map((f) => f.id)).toEqual(['accountAge', 'txCount', 'stockHoldings', 'totalHoldings', 'repayments', 'offchainProof'])
    const age = s.factors.find((f) => f.id === 'accountAge')!
    expect(age.value).toBe('unknown')
    expect(age.points).toBe(0)
    expect(age.source).toContain('robinhood-mainnet')
  })

  it('never lowers terms that history already earned', () => {
    const s = scoreWallet(make())
    expect(s.basis).toBe('history')
    expect(s.tier).toBe(4)
    expect(s.collateralRatioBps).toBe(12500)
  })

  it('does not apply the floor when holdings are unknown', () => {
    const h = fresh(0n)
    const s = scoreWallet({ ...h, holdings: { status: 'unavailable', source: 'local-fork:balanceOf+Chainlink', note: 'TSLA: feed unavailable', assets: [], stockValueUsd8: 0n, totalValueUsd8: 0n } })
    expect(s.tier).toBe(0)
  })
})

describe('Reclaim off-chain proof factor', () => {
  const mid = make({ accountAge: { ...available, days: 7 }, txCount: { ...available, count: 22 }, holdings: { ...available, assets: [], stockValueUsd8: 0n, totalValueUsd8: 0n }, repaymentHistory: { ...available, onTime: 0, late: 0, defaults: 0, completed: 0, clean: 0, events: [] } })
  it('scores 0 and says how to prove it when no proof is stored', () => {
    const f = scoreWallet(mid).factors.find((x) => x.id === 'offchainProof')!
    expect(f).toMatchObject({ points: 0, maxPoints: 10, status: 'unavailable', value: 'not proved' })
    expect(f.note).toMatch(/Raise your limit/)
  })
  it('adds 10 points for a verified proof and can move the tier and limit', () => {
    const before = scoreWallet(mid), after = scoreWallet(mid, { offchain: { provider: 'Binance KYC', proofId: '0x' + '12'.repeat(32) } })
    expect(after.score - before.score).toBe(10)
    expect(after.factors.find((x) => x.id === 'offchainProof')).toMatchObject({ points: 10, status: 'available', value: 'Binance KYC' })
    expect(before.tier).toBe(0)
    expect(after.tier).toBe(1)
    expect(after.limitUsdg).toBe(250_000_000n)
  })
  it('never lifts the score above 100', () => { expect(scoreWallet(make(), { offchain: { provider: 'p', proofId: '0x1' } }).score).toBe(100) })
})
