import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createPublicClient, createWalletClient, http, zeroAddress, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNorenRobinhood, STOCKS, USDG } from '../src/index.js'
import { erc20PermitAbi } from '../src/abi.js'
import { loadForkDeployment } from '../src/node.js'
import { signAttestation } from '../../underwriter/src/attest.js'
const setup = 'Setup required: sh scripts/fork.sh && sh scripts/deploy-fork.sh'
const rpc = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8720'
const customer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const merchant = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const publicClient = createPublicClient({ transport: http(rpc) })
const wallet = (account: typeof customer) => createWalletClient({ account, transport: http(rpc) })
let deployment: ReturnType<typeof loadForkDeployment>, snapshot: Hex
beforeAll(async () => {
  try { deployment = loadForkDeployment(); if (await publicClient.getChainId() !== 4663 || !(await publicClient.getBytecode({ address: deployment.credit }))) throw new Error(setup); snapshot = await publicClient.request({ method: 'evm_snapshot' } as any) as Hex }
  catch { throw new Error(setup) }
})
afterAll(async () => { if (snapshot) await publicClient.request({ method: 'evm_revert', params: [snapshot] } as any) })
const invoiceId = () => toHex(crypto.getRandomValues(new Uint8Array(32)))
const expiry = () => BigInt(Math.floor(Date.now() / 1000) + 86400)
describe('Noren SDK on fork', () => {
  it('creates invoices; pays USDG, NVDA, and ETH; opens and uses credit', async () => {
    const m = createNorenRobinhood({ publicClient, walletClient: wallet(merchant), addresses: deployment })
    const c = createNorenRobinhood({ publicClient, walletClient: wallet(customer), addresses: deployment })
    const a = invoiceId(), b = invoiceId(), d = invoiceId(), planInvoice = invoiceId()
    for (const id of [a,b,d,planInvoice]) await m.createInvoice({ invoiceId: id, amountUsdg: 10_000_000n, expiry: expiry() })
    const usdNonce = await publicClient.readContract({ address: USDG, abi: erc20PermitAbi, functionName: 'nonces', args: [customer.address] })
    const usd = await c.pay({ merchant: merchant.address, invoiceId: a, asset: USDG })
    expect(usd.paymentMethod).toBe('permit')
    expect(usd.invoicePaid.payer.toLowerCase()).toBe(customer.address.toLowerCase())
    expect(await publicClient.readContract({ address: USDG, abi: erc20PermitAbi, functionName: 'nonces', args: [customer.address] })).toBe(usdNonce + 1n)
    const nvda = await c.pay({ merchant: merchant.address, invoiceId: b, asset: STOCKS.NVDA })
    expect(nvda.paymentMethod).toBe('permit')
    expect(nvda.invoicePaid.asset.toLowerCase()).toBe(STOCKS.NVDA.toLowerCase())
    const eth = await c.pay({ merchant: merchant.address, invoiceId: d, asset: zeroAddress })
    expect(eth.invoicePaid.asset.toLowerCase()).toBe(deployment.weth.toLowerCase())
    const score = { tier: 3, limitUsdg: 2_500_000_000n, collateralRatioBps: 13000 }
    const signed = await signAttestation({ borrower: customer.address, terms: score, credit: deployment.credit, chainId: 4663, publicClient })
    expect(signed.declined).toBe(false)
    if (signed.declined) throw new Error(signed.reason)
    await c.applyAttestation(signed)
    expect((await c.creditTerms(customer.address)).tier).toBe(3)
    const opened = await c.openPlan({ invoiceId: planInvoice, merchant: merchant.address, collateral: STOCKS.NVDA, collateralAmount: 2n * 10n ** 18n })
    expect(opened.planId).toBeGreaterThan(0n)
    await c.repay({ planId: opened.planId, count: 1 })
    const line = await c.openCreditLine({ collateral: STOCKS.TSLA, collateralAmount: 2n * 10n ** 18n, limitUsdc6: 20_000_000n, expiry: expiry() })
    expect(line.lineId).toMatch(/^0x[0-9a-f]{64}$/)
    const positions = await c.readPositions(customer.address)
    expect(positions.plans.find(x => x.planId === opened.planId)?.plan.paid).toBe(1)
    expect(positions.lines.find(x => x.lineId === line.lineId)).toBeDefined()
  })
})
