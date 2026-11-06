// Wallet history for the Noren underwriter. Every factor says where it came from:
// - account age and transaction count: Robinhood Chain MAINNET (the wallet's real history)
// - Stock Token / ETH / USDG holdings and Noren repayments: the chain NorenCredit lives on (the
//   configured contract RPC: the local fork in dev, mainnet in production), because that is where
//   the collateral will be locked.
// Nothing is invented: a source that fails is reported as unavailable with the reason.
import { createPublicClient, http, padHex, parseAbiItem, toHex, type Address, type PublicClient } from 'viem'
import { aggregatorV3Abi, erc20PermitAbi, norenCreditAbi, stockTokenAbi } from '../../sdk/src/abi.js'
import { FEEDS, ROBINHOOD_RPC, STOCKS, USDG, WETH } from '../../sdk/src/addresses.js'
import { loadForkDeployment } from '../../sdk/src/node.js'

export type FactorData = { status: 'available' | 'unavailable'; source: string; note: string }
export type AssetHolding = { symbol: string; raw: bigint; shares: bigint; priceUsd8: bigint; valueUsd8: bigint; feedUpdatedAt: bigint }
export type WalletHistory = {
  address: Address
  accountAge: FactorData & { days: number }
  txCount: FactorData & { count: number }
  holdings: FactorData & { assets: AssetHolding[]; stockValueUsd8: bigint; totalValueUsd8: bigint }
  repaymentHistory: FactorData & {
    onTime: number
    late: number
    defaults: number
    completed: number
    clean: number
    events: { name: string; blockNumber: bigint; late?: boolean }[]
  }
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const LOG_WINDOW = 10_000_000n // this RPC allows 10M-block ranges for one address + one topic
const AGE_CACHE_MS = 10 * 60_000
/** Upper bound on the first-activity scan so /attest stays responsive; past it the age is reported unknown. */
const AGE_SCAN_BUDGET_MS = Number(process.env.NOREN_RH_AGE_SCAN_MS ?? 30_000)

const clientFor = (url: string): PublicClient =>
  createPublicClient({ transport: http(url, { fetchOptions: { headers: { 'user-agent': 'curl/8.7.1' } }, retryCount: 4, retryDelay: 1_500 }) })
const why = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e))
const isLoopback = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)
const chainLabel = (url: string) => (isLoopback(url) ? 'local-fork' : 'robinhood-mainnet')
const ageCache = new Map<string, { until: number; value: WalletHistory['accountAge'] }>()

/** Optional: Blockscout PRO with an API key. The public explorer API sits behind a Cloudflare challenge (403). */
async function blockscoutFirstBlock(address: Address): Promise<bigint | undefined> {
  const key = process.env.BLOCKSCOUT_API_KEY
  if (!key) return undefined
  const res = await fetch(`https://api.blockscout.com/4663/api/v2/addresses/${address}?apikey=${encodeURIComponent(key)}`)
  if (!res.ok) throw new Error(`Blockscout PRO HTTP ${res.status}`)
  const data = (await res.json()) as { creation_block_number?: number | string }
  return data.creation_block_number === undefined ? undefined : BigInt(data.creation_block_number)
}

/**
 * First activity on mainnet. Historical state is pruned on the public RPC (only ~10 minutes is
 * kept), so a nonce/balance binary search over old blocks is impossible; instead the earliest
 * inbound USDG/WETH/Stock Token Transfer log of the address is found with eth_getLogs (a lower bound
 * on age). A wallet with nonce 0 and no token balance has no activity to date.
 */
async function accountAge(address: Address, mainnet: PublicClient, nonce: number | null, hasBalances: boolean): Promise<WalletHistory['accountAge']> {
  const cached = ageCache.get(address.toLowerCase())
  if (cached && cached.until > Date.now()) return cached.value
  let result: WalletHistory['accountAge']
  try {
    let first = await blockscoutFirstBlock(address).catch(() => undefined)
    let source = 'blockscout-pro'
    if (first === undefined) {
      source = 'robinhood-mainnet:eth_getLogs(Transfer)'
      if (nonce === 0 && !hasBalances) {
        result = { status: 'unavailable', source, note: 'No activity on Robinhood mainnet yet (nonce 0, no token balance): age unknown', days: 0 }
        ageCache.set(address.toLowerCase(), { until: Date.now() + AGE_CACHE_MS, value: result })
        return result
      }
      const latest = await mainnet.getBlockNumber()
      const deadline = Date.now() + AGE_SCAN_BUDGET_MS
      const topic = padHex(address, { size: 32 })
      const tokens = [USDG, WETH, ...Object.values(STOCKS)]
      for (let from = 0n; from <= latest && first === undefined; from += LOG_WINDOW) {
        const to = from + LOG_WINDOW - 1n < latest ? from + LOG_WINDOW - 1n : latest
        // An address must receive a token before it can send one (mints are Transfers to it too),
        // so the earliest inbound Transfer is its earliest token activity.
        const queries = tokens.map((token) => ({ token, topics: [TRANSFER, null, topic] }))
        for (let i = 0; i < queries.length; i += 3) {
          const found = await Promise.all(queries.slice(i, i + 3).map(({ token, topics }) => earliestLog(mainnet, token, topics, from, to, deadline)))
          for (const b of found) if (b !== undefined && (first === undefined || b < first)) first = b
        }
      }
    }
    if (first === undefined) {
      result = { status: 'unavailable', source, note: 'No USDG, WETH or Stock Token transfer found on mainnet: age unknown', days: 0 }
    } else {
      const [a, b] = await Promise.all([mainnet.getBlock({ blockNumber: first }), mainnet.getBlock()])
      const note = source === 'blockscout-pro' ? `first activity at block ${first}` : `earliest token transfer at block ${first} (lower bound)`
      result = { status: 'available', source, note, days: Math.max(0, Number((b.timestamp - a.timestamp) / 86_400n)) }
    }
  } catch (e) {
    result = { status: 'unavailable', source: 'robinhood-mainnet:eth_getLogs(Transfer)', note: `age unknown: ${why(e)}`, days: 0 }
  }
  ageCache.set(address.toLowerCase(), { until: Date.now() + AGE_CACHE_MS, value: result })
  return result
}

class ScanBudgetError extends Error {
  constructor() {
    super(`first-activity scan stopped after ${AGE_SCAN_BUDGET_MS / 1000} s (busy address)`)
  }
}

/** Earliest matching log block in [from, to]. The RPC caps a response at 10,000 logs, so an
 *  overflowing range is bisected, lower half first (only the earliest block matters). */
async function earliestLog(client: PublicClient, token: Address, topics: (string | null)[], from: bigint, to: bigint, deadline: number, depth = 0): Promise<bigint | undefined> {
  if (Date.now() > deadline) throw new ScanBudgetError()
  try {
    const logs = (await client.request({ method: 'eth_getLogs', params: [{ address: token, fromBlock: toHex(from), toBlock: toHex(to), topics }] } as never)) as { blockNumber: string }[]
    let min: bigint | undefined
    for (const log of logs) {
      const b = BigInt(log.blockNumber)
      if (min === undefined || b < min) min = b
    }
    return min
  } catch (e) {
    if (e instanceof ScanBudgetError || !/exceeds limit|Missing or invalid parameters/i.test(why(e)) || depth > 24 || to <= from) throw e
    const mid = from + (to - from) / 2n
    return (await earliestLog(client, token, topics, from, mid, deadline, depth + 1)) ?? (await earliestLog(client, token, topics, mid + 1n, to, deadline, depth + 1))
  }
}

/** Balances on `client`'s chain valued with Chainlink (decimals read live, Stock Tokens x uiMultiplier). */
async function holdings(address: Address, client: PublicClient, label: string): Promise<WalletHistory['holdings']> {
  const assets: AssetHolding[] = []
  const failures: string[] = []
  const list: { symbol: string; token?: Address; feed: Address; stock: boolean }[] = [
    ...Object.entries(STOCKS).map(([symbol, token]) => ({ symbol, token, feed: FEEDS[symbol as keyof typeof STOCKS], stock: true })),
    { symbol: 'WETH', token: WETH, feed: FEEDS.ETH, stock: false },
    { symbol: 'USDG', token: USDG, feed: FEEDS.USDG, stock: false },
    { symbol: 'ETH', feed: FEEDS.ETH, stock: false },
  ]
  for (const { symbol, token, feed, stock } of list) {
    try {
      const raw = token ? await client.readContract({ address: token, abi: erc20PermitAbi, functionName: 'balanceOf', args: [address] }) : await client.getBalance({ address })
      if (raw === 0n) continue
      const decimals = token ? Number(await client.readContract({ address: token, abi: erc20PermitAbi, functionName: 'decimals' })) : 18
      const mult = stock && token ? await client.readContract({ address: token, abi: stockTokenAbi, functionName: 'uiMultiplier' }) : 10n ** 18n
      const [dec, round] = await Promise.all([
        client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: 'decimals' }),
        client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' }),
      ])
      if (round[1] <= 0n || round[3] <= 0n) throw new Error('invalid feed answer or timestamp')
      const priceUsd8 = dec >= 8 ? round[1] / 10n ** BigInt(dec - 8) : round[1] * 10n ** BigInt(8 - dec)
      const valueUsd8 = (raw * mult * priceUsd8) / (10n ** 18n * 10n ** BigInt(decimals))
      assets.push({ symbol, raw, shares: (raw * mult) / 10n ** 18n, priceUsd8, valueUsd8, feedUpdatedAt: round[3] })
    } catch (e) {
      failures.push(`${symbol}: ${why(e)}`)
    }
  }
  return {
    status: failures.length ? 'unavailable' : 'available',
    source: `${label}:balanceOf+Chainlink`,
    note: failures.join('; '),
    assets,
    stockValueUsd8: assets.filter((x) => x.symbol in STOCKS).reduce((a, x) => a + x.valueUsd8, 0n),
    totalValueUsd8: assets.reduce((a, x) => a + x.valueUsd8, 0n),
  }
}

/** Noren repayment events and history() on the chain NorenCredit is deployed to. */
async function readRepayments(address: Address, client: PublicClient, label: string, credit?: Address, deployBlock?: number): Promise<WalletHistory['repaymentHistory']> {
  const empty = { onTime: 0, late: 0, defaults: 0, completed: 0, clean: 0, events: [] as WalletHistory['repaymentHistory']['events'] }
  if (!credit) return { ...empty, status: 'unavailable', source: 'noren-credit', note: 'Setup required: NOREN_RH_CREDIT' }
  try {
    const events: WalletHistory['repaymentHistory']['events'] = []
    const definitions = [
      'event InstallmentPaid(uint256 indexed planId,address indexed borrower,uint8 installment,uint256 amountUsdg,bool late)',
      'event PlanRepaid(uint256 indexed planId,address indexed borrower,bool clean)',
      'event PlanLiquidated(uint256 indexed planId,address indexed borrower,address indexed liquidator,uint256 paidUsdg,uint256 seized,uint256 badDebtUsdg)',
      'event CreditLineLiquidated(bytes32 indexed lineId,address indexed borrower,address indexed liquidator,uint256 paidUsdg,uint256 seized,uint256 badDebtUsdg)',
    ]
    for (const definition of definitions) {
      const ev = parseAbiItem(definition) as any
      const logs = (await client.getLogs({ address: credit, event: ev, args: { borrower: address }, fromBlock: BigInt(deployBlock ?? 0) } as any)) as any[]
      for (const log of logs) events.push({ name: ev.name, blockNumber: log.blockNumber, ...(ev.name === 'InstallmentPaid' ? { late: Boolean(log.args.late) } : {}) })
    }
    const h = await client.readContract({ address: credit, abi: norenCreditAbi, functionName: 'history', args: [address] })
    return { status: 'available', source: `${label}:NorenCredit events+history()`, note: '', events, onTime: Number(h[0]), late: Number(h[1]), completed: Number(h[2]), clean: Number(h[3]), defaults: Number(h[4]) }
  } catch (e) {
    return { ...empty, status: 'unavailable', source: `${label}:NorenCredit`, note: why(e) }
  }
}

export async function readWalletHistory(
  address: Address,
  opts: { mainnetRpc?: string; contractRpc?: string; credit?: Address; deployBlock?: number } = {},
): Promise<WalletHistory> {
  let deployment: ReturnType<typeof loadForkDeployment> | undefined
  try {
    deployment = loadForkDeployment()
  } catch {}
  const mainnetUrl = opts.mainnetRpc ?? process.env.ROBINHOOD_RPC ?? ROBINHOOD_RPC
  const contractUrl = opts.contractRpc ?? process.env.NOREN_RH_RPC ?? deployment?.rpcUrl ?? 'http://127.0.0.1:8720'
  const mainnet = clientFor(mainnetUrl)
  const contract = clientFor(contractUrl)
  const label = chainLabel(contractUrl)
  const credit = opts.credit ?? (process.env.NOREN_RH_CREDIT as Address | undefined) ?? deployment?.credit

  const txCount: WalletHistory['txCount'] = await mainnet
    .getTransactionCount({ address })
    .then((count) => ({ status: 'available' as const, source: 'robinhood-mainnet:eth_getTransactionCount', note: '', count }))
    .catch((e) => ({ status: 'unavailable' as const, source: 'robinhood-mainnet:eth_getTransactionCount', note: `unknown: ${why(e)}`, count: 0 }))
  const [held, repaymentHistory] = await Promise.all([holdings(address, contract, label), readRepayments(address, contract, label, credit, opts.deployBlock ?? deployment?.deployBlock)])
  // Mainnet balances decide whether a log scan for first activity is worth running.
  const mainnetHeld = label === 'robinhood-mainnet' ? held : await holdings(address, mainnet, 'robinhood-mainnet')
  const age = await accountAge(address, mainnet, txCount.status === 'available' ? txCount.count : null, mainnetHeld.assets.length > 0)
  return { address, txCount, accountAge: age, holdings: held, repaymentHistory }
}
