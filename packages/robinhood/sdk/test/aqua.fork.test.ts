import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createPublicClient, createWalletClient, http, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNorenRobinhood, STOCKS, USDG, INSTALLMENTS } from '../src/index.js'
import { erc20PermitAbi, norenCreditAbi } from '../src/abi.js'
import { loadForkDeployment } from '../src/node.js'
import { signAttestation } from '../../underwriter/src/attest.js'

// Anvil published dev keys, local fork only: #1 customer, #2 merchant, #3 Aqua maker, #4 keeper.
const setup = 'Setup required: sh scripts/fork-snapshot.sh && sh scripts/serve-snapshot.sh (deployment with NorenLiquidity)'
const rpc = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8720'
const customer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const merchant = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const maker = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')
const keeper = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')
const publicClient = createPublicClient({ transport: http(rpc) })
const wallet = (account: typeof customer) => createWalletClient({ account, transport: http(rpc) })
let deployment: ReturnType<typeof loadForkDeployment>, snapshot: Hex
beforeAll(async () => {
  try {
    deployment = loadForkDeployment()
    if ((await publicClient.getChainId()) !== 4663 || !deployment.liquidity || !(await publicClient.getBytecode({ address: deployment.liquidity }))) throw new Error(setup)
    snapshot = (await publicClient.request({ method: 'evm_snapshot' } as any)) as Hex
  } catch {
    throw new Error(setup)
  }
})
afterAll(async () => {
  if (snapshot) await publicClient.request({ method: 'evm_revert', params: [snapshot] } as any)
})
const invoiceId = () => toHex(crypto.getRandomValues(new Uint8Array(32)))
const expiry = () => BigInt(Math.floor(Date.now() / 1000) + 86400)
const bal = (token: Hex, who: Hex) => publicClient.readContract({ address: token, abi: erc20PermitAbi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>

describe('Noren SDK: Aqua makers, pay with stocks, Pay in 3, liquidation through SwapVM', () => {
  it('routes a stock payment to the seeded maker and books its fee', async () => {
    const m = createNorenRobinhood({ publicClient, walletClient: wallet(merchant), addresses: deployment })
    const c = createNorenRobinhood({ publicClient, walletClient: wallet(customer), addresses: deployment })
    const id = invoiceId()
    await m.createInvoice({ invoiceId: id, amountUsdg: 50_000_000n, expiry: expiry() })
    const q = await c.quote({ merchant: merchant.address, invoiceId: id, asset: STOCKS.NVDA })
    expect(q.route).toBe('aqua-maker')
    const before = await c.makerPositions(maker.address)
    const merchantBefore = await bal(USDG, merchant.address)
    const paid = await c.pay({ merchant: merchant.address, invoiceId: id, asset: STOCKS.NVDA })
    expect(paid.makerFill?.maker.toLowerCase()).toBe(maker.address.toLowerCase())
    expect(paid.makerFill?.usdgOut).toBe(50_000_000n)
    expect((await bal(USDG, merchant.address)) - merchantBefore).toBe(50_000_000n)
    const after = await c.makerPositions(maker.address)
    expect(after.feesUsdg).toBeGreaterThan(before.feesUsdg)
    const nvda = after.strategies.find((s) => s.symbol === 'NVDA')!
    expect(nvda.fills).toBeGreaterThan(0)
    expect(nvda.walletAsset).toBeGreaterThanOrEqual(nvda.aquaAsset)
  })

  it('a new maker ships, quotes and docks a strategy', async () => {
    const mk = createNorenRobinhood({ publicClient, walletClient: wallet(maker), addresses: deployment })
    const shipped = await mk.shipMakerStrategy({ asset: STOCKS.TSLA, usdgAmount: 1_000_000_000n, terms: { bidSpreadBps: 40, salt: 7n } })
    expect(shipped.strategyHash).toMatch(/^0x[0-9a-f]{64}$/)
    const pos = await mk.makerPositions(maker.address)
    const s = pos.strategies.find((x) => x.strategyHash === shipped.strategyHash)!
    expect(s.aquaUsdg).toBe(1_000_000_000n)
    expect(s.bidSpreadBps).toBe(40)
    const docked = await mk.dockMakerStrategy(shipped.strategyHash)
    expect(docked.removeHash).toMatch(/^0x/)
    const after = (await mk.makerPositions(maker.address)).strategies.find((x) => x.strategyHash === shipped.strategyHash)!
    expect(after.active).toBe(false)
    expect(after.aquaUsdg).toBe(0n)
  })

  it('compares the maker quote with Uniswap v4 for best execution', async () => {
    const c = createNorenRobinhood({ publicClient, addresses: deployment })
    const best = await c.bestExecution({ asset: STOCKS.NVDA, amountIn: 10n ** 18n })
    expect(best.maker).not.toBeNull()
    expect(best.chainlinkUsdg).toBeGreaterThan(best.maker!.usdgOut)
    // The snapshot only holds warmed v4 pool state; an unreadable quote is reported, never invented.
    if (best.uniswapV4Usdg === null) expect(best.uniswapV4Error).toBeTruthy()
    console.log('best execution 1 NVDA', best)
  })

  it('Pay in 3: schedule, "liquidates if NVDA < $X or if you miss two payments", then a keeper liquidates through makers', async () => {
    const m = createNorenRobinhood({ publicClient, walletClient: wallet(merchant), addresses: deployment })
    const c = createNorenRobinhood({ publicClient, walletClient: wallet(customer), addresses: deployment })
    const k = createNorenRobinhood({ publicClient, walletClient: wallet(keeper), addresses: deployment })
    expect(Number(await publicClient.readContract({ address: deployment.credit, abi: norenCreditAbi, functionName: 'INSTALLMENTS' }))).toBe(INSTALLMENTS)
    // Shorten the schedule to 15-minute installments on this fork (owner = Anvil key #0; evm_revert
    // restores it) so two missed payments fit inside the feeds' maximum age.
    const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
    const prm = (await publicClient.readContract({ address: deployment.credit, abi: norenCreditAbi, functionName: 'params' })) as readonly any[]
    const setParams = await wallet(owner).writeContract({
      address: deployment.credit,
      abi: norenCreditAbi,
      functionName: 'setParams',
      args: [{ installmentInterval: 900, gracePeriod: 900, liquidationThresholdBps: prm[2], liquidationBonusBps: prm[3], merchantFeeBps: prm[4], maxLineDuration: prm[5], reportSkew: prm[6] }],
      chain: null,
    })
    await publicClient.waitForTransactionReceipt({ hash: setParams })
    const signed = await signAttestation({ borrower: customer.address, terms: { tier: 3, limitUsdg: 2_500_000_000n, collateralRatioBps: 13000 }, credit: deployment.credit, chainId: 4663, publicClient })
    if (signed.declined) throw new Error(signed.reason)
    await c.applyAttestation(signed)
    const id = invoiceId()
    await m.createInvoice({ invoiceId: id, amountUsdg: 300_000_000n, expiry: expiry() })
    const opened = await c.openPlan({ invoiceId: id, merchant: merchant.address, collateral: STOCKS.NVDA, collateralAmount: 3n * 10n ** 18n })
    const info = await c.liquidationInfo(opened.planId)
    expect(info.schedule).toHaveLength(3)
    expect(info.schedule.reduce((a, s) => a + s.amountUsdg, 0n)).toBe(300_000_000n)
    expect(info.liquidationPriceUsd8).toBeGreaterThan(0n)
    expect(info.liquidationPriceUsd8).toBeLessThan(info.priceUsd8)
    expect(info.message).toMatch(/^Your 3(\.\d+)? NVDA liquidates if NVDA < \$\d+(\.\d+)? or if you miss two payments$/)
    console.log(info.message)

    // miss installments 1 and 2 (interval and grace are 15 minutes on the demo fork)
    const due2 = info.schedule[1].defaultsAfter
    const now = BigInt((await publicClient.getBlock()).timestamp)
    await publicClient.request({ method: 'evm_increaseTime', params: [Number(due2 - now + 5n)] } as any)
    await publicClient.request({ method: 'evm_mine', params: [] } as any)
    const late = await c.liquidationInfo(opened.planId)
    expect(late.missedPayments).toBe(2)
    expect(late.liquidatable.overdue).toBe(true)

    const vaultBefore = await bal(USDG, deployment.vault)
    const keeperBefore = await bal(STOCKS.NVDA, keeper.address)
    const res = await k.liquidatePlanViaAqua(opened.planId)
    expect(res.liquidated.paidUsdg).toBe(300_000_000n)
    expect((await bal(USDG, deployment.vault)) - vaultBefore).toBe(300_000_000n)
    expect((await bal(STOCKS.NVDA, keeper.address)) - keeperBefore).toBe(res.sale.bonus)
    expect(res.sale.returned).toBeGreaterThan(0n)
  })
})
