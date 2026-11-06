import { it, expect } from 'vitest'
import { readWalletHistory } from '../src/history.js'
it('reads real Robinhood mainnet PoolManager history', async () => {
  const h = await readWalletHistory('0x8366a39CC670B4001A1121B8F6A443A643e40951')
  expect(h.txCount.status).toBe('available')
  expect(h.txCount.count).toBeGreaterThanOrEqual(0)
  expect(h.holdings.status, h.holdings.note).toBe('available')
  expect(h.holdings.stockValueUsd8).toBeGreaterThan(100_000n * 100_000_000n)
}, 120000)
