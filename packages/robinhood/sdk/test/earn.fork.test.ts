import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNorenEarn, recordVerifiedHuman, signVerifiedHuman, NATIVE_ETH, STOCKS, USDG, WETH } from '../src/index.js'
import { erc20PermitAbi } from '../src/abi.js'
import { loadForkDeployment } from '../src/node.js'

// Anvil published dev keys, local fork only: #1 customer, #2 merchant, #3 trader (the demo Aqua maker's wallet).
const setup = 'Setup required: sh scripts/fork-snapshot.sh && sh scripts/serve-snapshot.sh (deployment with NorenBorrow)'
const rpc = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8720'
const customer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const merchant = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const trader = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6') // #3, holds real USDG
const publicClient = createPublicClient({ transport: http(rpc) })
const wallet = (account: typeof customer) => createWalletClient({ account, transport: http(rpc) })
let deployment: ReturnType<typeof loadForkDeployment> & { borrow?: Hex; reputation?: Hex; depositVaults?: { asset: Hex; vault: Hex }[] }
let snapshot: Hex
beforeAll(async () => {
  try {
    deployment = loadForkDeployment() as typeof deployment
    deployment.rpcUrl = rpc
    if ((await publicClient.getChainId()) !== 4663 || !deployment.borrow || !(await publicClient.getBytecode({ address: deployment.borrow }))) throw new Error(setup)
    snapshot = (await publicClient.request({ method: 'evm_snapshot' } as any)) as Hex
  } catch {
    throw new Error(setup)
  }
})
afterAll(async () => {
  if (snapshot) await publicClient.request({ method: 'evm_revert', params: [snapshot] } as any)
})
const bal = (token: Hex, who: Hex) => publicClient.readContract({ address: token, abi: erc20PermitAbi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>
const fmt = (v: bigint, d = 6) => (Number(v) / 10 ** d).toFixed(2)

describe('Noren SDK: deposit and earn, borrow, reputation, World ID', () => {
  it('deposit -> real maker fills -> realised yield -> World ID -> borrow -> repay -> exits', async () => {
    const c = createNorenEarn({ publicClient, walletClient: wallet(customer), addresses: deployment })
    const vaults = await c.vaults()
    expect(vaults.map((v) => v.symbol)).toEqual(['nETH', 'nNVDA', 'nTSLA', 'nAAPL'])
    expect(vaults[0].name).toBe('Noren ETH deposit')

    const dep = await c.deposit({ asset: NATIVE_ETH, amount: 10n ** 18n })
    expect(dep.shares).toBeGreaterThan(0n)
    expect(await bal(WETH, dep.vault)).toBe(10n ** 18n)
    const nv = await c.deposit({ asset: STOCKS.NVDA, amount: 2n * 10n ** 18n })
    expect(nv.assets).toBe(2n * 10n ** 18n)
    console.log('fork tx deposit 1 ETH', dep.hash, '| deposit 2 NVDA', nv.hash)

    // credit limit with the deposits only
    const l0 = await c.creditLimit(customer.address)
    expect(l0.ltvBps).toBe(6600)
    expect(l0.starterUsdc6).toBe(0n)

    // a real ask-side fill from the nETH vault's Aqua strategy (a trader with USDG buys 0.2 ETH)
    const m = createNorenEarn({ publicClient, walletClient: wallet(trader), addresses: deployment })
    const bought = await m.buyAsset({ asset: WETH, amountOut: 2n * 10n ** 17n })
    expect(bought.sale.maker.toLowerCase()).toBe(dep.vault.toLowerCase())
    expect(bought.sale.feeUsdg).toBeGreaterThan(0n)
    console.log('fork tx buyFromMakers 0.2 ETH', bought.receipt.transactionHash, 'fee', fmt(bought.sale.feeUsdg), 'USDG')

    await publicClient.request({ method: 'evm_increaseTime', params: [3600] } as any)
    await publicClient.request({ method: 'evm_mine', params: [] } as any)
    const stats = await c.vaultStats(NATIVE_ETH)
    expect(stats.fills).toBe(1n)
    expect(stats.feesUsdg).toBe(bought.sale.feeUsdg)
    expect(stats.realisedApyBps).not.toBeNull()
    expect(stats.apyLabel).toMatch(/^Realised: .* Not a forecast\.$/)
    expect(stats.assetsPerShare).toBeGreaterThan(10n ** 18n) // ETH per 1 nETH rose above 1 from the fee
    console.log(stats.apyLabel, 'APY bps', stats.realisedApyBps)
    const py = await c.previewYield({ asset: NATIVE_ETH, amount: 10n ** 18n, days: 30 })
    expect(py.projectedAssetGain).not.toBeNull()

    // withdrawing everything in ETH while 0.2 ETH is sold: readable error, then in kind works (later)
    await expect(c.withdraw({ asset: NATIVE_ETH })).rejects.toThrow(/^Liquidity in use: /)

    // World ID: the handler records the verified human; LTV, milestone and limit change at once
    const human = await recordVerifiedHuman({ publicClient, addresses: deployment, account: customer.address, nullifier: BigInt(keccak256(toHex('customer-human'))) % 2n ** 254n })
    expect(human.after.ltvBps).toBe(7000)
    expect(human.after.starterUsdc6).toBe(25_000_000n)
    expect(human.after.totalUsd6).toBeGreaterThan(human.before.totalUsd6)
    expect(human.milestones.find((x) => x.key === 'verifiedHuman')!.achieved).toBe(true)
    console.log('fork tx verifyHuman', human.tx.hash, 'limit', fmt(human.before.totalUsd6), '->', fmt(human.after.totalUsd6))
    // replay / second wallet: refused before any transaction
    await expect(signVerifiedHuman({ publicClient, reputation: deployment.reputation!, account: merchant.address, nullifier: human.signed.nullifierHash })).rejects.toThrow(/^Already used/)

    // borrow against the locked nETH shares (they keep earning)
    await c.lock({ asset: NATIVE_ETH })
    const h0 = await c.health(customer.address)
    expect(h0.ltvBps).toBe(7000)
    const amount = h0.borrowLimitUsdg / 2n
    const usdgBefore = await bal(USDG, customer.address)
    const b = await c.borrow({ amountUsdg: amount })
    expect((await bal(USDG, customer.address)) - usdgBefore).toBe(amount)
    await expect(c.borrow({ amountUsdg: h0.borrowLimitUsdg })).rejects.toThrow(/^Over the borrow limit/)
    const h1 = await c.health(customer.address)
    expect(h1.healthFactor).toBeGreaterThan(1.9)
    const lp = await c.liquidationPrice(customer.address, NATIVE_ETH)
    expect(lp.liquidationPriceUsd8).toBeLessThan(lp.priceUsd8)
    expect(lp.message).toMatch(/^Your 0\.8 ETH deposit is liquidated if ETH < \$[\d,]+\.\d{2} \(now \$[\d,]+\.\d{2}\)$/)
    console.log('fork tx borrow', b.receipt.transactionHash, fmt(amount), 'USDG |', lp.message)

    const r = await c.repay({ amountUsdg: 'all' })
    expect(r.repaid.debtUsdg).toBe(0n)
    expect((await c.health(customer.address)).debtUsdg).toBe(0n)
    await c.unlock({ asset: NATIVE_ETH })
    const out = await c.withdraw({ asset: NATIVE_ETH, inKind: true })
    expect(out.assets).toBeGreaterThan(0n)
    expect(out.usdg).toBeGreaterThan(0n)
    console.log('fork tx repay', r.receipt.transactionHash, '| redeemInKind', out.receipt.transactionHash, fmt(out.assets, 18), 'ETH +', fmt(out.usdg), 'USDG')
    const rep = await c.reputation(customer.address)
    expect(rep.verifiedHuman).toBe(true)
    expect(rep.nextTier?.tier).toBe(2)
  })
})
