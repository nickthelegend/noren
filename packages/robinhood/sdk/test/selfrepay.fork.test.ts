import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNorenEarn, NATIVE_ETH, STOCKS, WETH } from '../src/index.js'
import { norenBorrowAbi } from '../src/abi.js'
import { loadForkDeployment } from '../src/node.js'

// Loans that pay themselves down, through the SDK on the warmed snapshot (real WETH, USDG, NVDA, Chainlink feeds and
// the official Aqua registry). Anvil published dev keys, local fork only: #1 customer (borrower), #3 trader (the demo
// maker's wallet, holds real USDG), #4 keeper.
const setup = 'Setup required: sh scripts/fork-snapshot.sh && sh scripts/serve-snapshot.sh (deployment with NorenBorrow.harvestToRepay)'
const rpc = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8720'
const customer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const trader = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')
const keeper = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')
const publicClient = createPublicClient({ transport: http(rpc) })
const wallet = (account: typeof customer) => createWalletClient({ account, transport: http(rpc) })
let deployment: ReturnType<typeof loadForkDeployment> & { borrow?: Hex; depositVaults?: { asset: Hex; vault: Hex }[]; deployBlock?: number }
let snapshot: Hex
beforeAll(async () => {
  try {
    deployment = loadForkDeployment() as typeof deployment
    deployment.rpcUrl = rpc
    if ((await publicClient.getChainId()) !== 4663 || !deployment.borrow) throw new Error(setup)
    // an older snapshot's NorenBorrow has no harvestToRepay: this read reverts there
    await publicClient.readContract({ address: deployment.borrow, abi: norenBorrowAbi, functionName: 'totalYieldRepaidUsdg' })
    snapshot = (await publicClient.request({ method: 'evm_snapshot' } as any)) as Hex
  } catch {
    throw new Error(setup)
  }
})
afterAll(async () => {
  if (snapshot) await publicClient.request({ method: 'evm_revert', params: [snapshot] } as any)
})
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(6)

describe('Noren SDK: loans that pay themselves down', () => {
  it('1 ETH + 1 NVDA locked, 500 USDG borrowed, real Aqua fills, keeper harvest repays exactly the yield', async () => {
    const c = createNorenEarn({ publicClient, walletClient: wallet(customer), addresses: deployment })
    await c.deposit({ asset: NATIVE_ETH, amount: 10n ** 18n })
    await c.deposit({ asset: STOCKS.NVDA, amount: 10n ** 18n })
    await c.lock({ asset: NATIVE_ETH })
    await c.lock({ asset: STOCKS.NVDA })
    await c.borrow({ amountUsdg: 500_000_000n })

    // no fills yet: nothing earned, and the SDK says so
    const p0 = await c.previewYieldRepay(customer.address)
    expect(p0.yieldUsdg).toBe(0n)
    expect(p0.message).toBe('No fills yet, so nothing earned yet')
    await expect(c.harvestToRepay()).rejects.toThrow(/nothing earned yet/)

    // real fills: a trader buys ETH and NVDA from the vaults' Aqua asks
    const t = createNorenEarn({ publicClient, walletClient: wallet(trader), addresses: deployment })
    const ethSale = await t.buyAsset({ asset: WETH, amountOut: 3n * 10n ** 17n })
    const nvdaSale = await t.buyAsset({ asset: STOCKS.NVDA, amountOut: 25n * 10n ** 16n })
    expect(ethSale.sale.maker.toLowerCase()).toBe(c.vaultFor(NATIVE_ETH).toLowerCase())
    expect(nvdaSale.sale.maker.toLowerCase()).toBe(c.vaultFor(STOCKS.NVDA).toLowerCase())
    const fees = ethSale.sale.feeUsdg + nvdaSale.sale.feeUsdg
    console.log('fork tx fills', ethSale.receipt.transactionHash, nvdaSale.receipt.transactionHash, 'fees', usd(ethSale.sale.feeUsdg), '+', usd(nvdaSale.sale.feeUsdg), 'USDG')

    const p1 = await c.previewYieldRepay(customer.address)
    expect(p1.fills).toBe(2)
    // the borrower may share the vaults with earlier demo deposits: its yield is at most the fees, pro rata
    expect(p1.yieldUsdg).toBeGreaterThan(0n)
    expect(p1.yieldUsdg).toBeLessThanOrEqual(fees)
    expect(p1.vaults.every((v) => v.path === 'usdg')).toBe(true) // the asks left the fees in the vault as USDG
    console.log(p1.message)

    // a keeper (not the borrower) harvests; the borrower's USDG balance does not move
    const k = createNorenEarn({ publicClient, walletClient: wallet(keeper), addresses: deployment })
    const r = await k.harvestToRepay(customer.address)
    expect(r.repaidUsdg).toBe(p1.yieldUsdg)
    expect(r.debtBeforeUsdg - r.debtAfterUsdg).toBe(r.repaidUsdg)
    expect(r.fills).toBe(2)
    console.log('fork tx harvestToRepay', r.hash, 'repaid', usd(r.repaidUsdg), 'USDG; debt', usd(r.debtBeforeUsdg), '->', usd(r.debtAfterUsdg))

    const paid = await c.loanPaidByYield(customer.address, { fromBlock: deployment.deployBlock ? BigInt(deployment.deployBlock) : undefined })
    expect(paid.totalUsdg).toBe(r.repaidUsdg)
    expect(paid.fromEventsUsdg).toBe(paid.totalUsdg)
    expect(paid.fills).toBe(2)
    expect(paid.harvests).toBe(1)
    expect(paid.debtWithoutEarningsUsdg).toBe(paid.debtNowUsdg + r.repaidUsdg)
    const p2 = await c.previewYieldRepay(customer.address)
    expect(p2.yieldUsdg).toBe(0n)
    expect((await c.health(customer.address)).locked.length).toBe(2)
  })
})
