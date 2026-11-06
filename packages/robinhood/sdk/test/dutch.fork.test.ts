import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createPublicClient, createWalletClient, http, parseAbi, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNorenDutch, createNorenRobinhood, STOCKS, USDG } from '../src/index.js'
import { erc20PermitAbi, norenCreditAbi } from '../src/abi.js'
import { loadForkDeployment } from '../src/node.js'
import { signAttestation } from '../../underwriter/src/attest.js'

// Partial Dutch-auction liquidation through the SDK on the warmed Robinhood mainnet snapshot (real
// NVDA, USDG, Chainlink feeds and the official Aqua registry; Noren deployed from this branch, so the
// router carries NorenDutchDecay at opcode 35). Anvil published dev keys, local fork only:
// #0 owner, #1 customer, #2 merchant, #3 Aqua maker, #4 keeper. Every change is reverted afterwards.
const setup =
  'Setup required: sh scripts/fork-snapshot.sh && sh scripts/serve-snapshot.sh, built from a branch whose router has NorenDutchDecay (opcode 35), then forge build in contracts/'
const rpc = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8720'
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const customer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const merchant = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const maker = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')
const keeper = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')
const publicClient = createPublicClient({ transport: http(rpc) })
const wallet = (account: typeof customer) => createWalletClient({ account, transport: http(rpc) })
const artifactPath = fileURLToPath(new URL('../../contracts/out/NorenDutchAuction.sol/NorenDutchAuction.json', import.meta.url))
const bal = (token: Address, who: Address) => publicClient.readContract({ address: token, abi: erc20PermitAbi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>
const warp = async (seconds: number) => {
  await publicClient.request({ method: 'evm_increaseTime', params: [seconds] } as any)
  await publicClient.request({ method: 'evm_mine', params: [] } as any)
}

let deployment: ReturnType<typeof loadForkDeployment>
let snapshot: Hex
beforeAll(async () => {
  try {
    deployment = loadForkDeployment()
    if ((await publicClient.getChainId()) !== 4663 || !deployment.swapRouter || !(await publicClient.getBytecode({ address: deployment.swapRouter }))) throw new Error(setup)
    await publicClient.readContract({ address: deployment.swapRouter, abi: parseAbi(['function NOREN_DUTCH_DECAY_OPCODE() view returns (uint8)']), functionName: 'NOREN_DUTCH_DECAY_OPCODE' })
    snapshot = (await publicClient.request({ method: 'evm_snapshot' } as any)) as Hex
  } catch {
    throw new Error(setup)
  }
  // NorenCredit.setDutchAuction is set-once (audit RH-C): a snapshot built by deploy-fork.sh already wired one, so use it.
  // Otherwise deploy NorenDutchAuction (0.5% -> 8% over 1 h, keeper 25% of the discount, target health 1.10) and set it.
  const wired = (await publicClient.readContract({ address: deployment.credit, abi: parseAbi(['function dutchAuction() view returns (address)']), functionName: 'dutchAuction' })) as Address
  if (BigInt(wired) !== 0n) deployment.dutchAuction = wired
  else {
    const art = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: any; bytecode: { object: Hex } }
    const hash = await wallet(owner).deployContract({
      abi: art.abi,
      bytecode: art.bytecode.object,
      args: [owner.address, deployment.credit, deployment.swapRouter, 50, 800, 3600, 2500, 11_000],
      chain: null,
    })
    deployment.dutchAuction = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address
    const set = await wallet(owner).writeContract({ address: deployment.credit, abi: norenCreditAbi, functionName: 'setDutchAuction', args: [deployment.dutchAuction], chain: null })
    await publicClient.waitForTransactionReceipt({ hash: set })
  }
  // 15-minute installments so two missed payments fit inside the feeds' maximum age.
  const prm = (await publicClient.readContract({ address: deployment.credit, abi: norenCreditAbi, functionName: 'params' })) as readonly any[]
  const sp = await wallet(owner).writeContract({
    address: deployment.credit,
    abi: norenCreditAbi,
    functionName: 'setParams',
    args: [{ installmentInterval: 900, gracePeriod: 900, liquidationThresholdBps: prm[2], liquidationBonusBps: prm[3], merchantFeeBps: prm[4], maxLineDuration: prm[5], reportSkew: prm[6] }],
    chain: null,
  })
  await publicClient.waitForTransactionReceipt({ hash: sp })
})
afterAll(async () => {
  if (snapshot) await publicClient.request({ method: 'evm_revert', params: [snapshot] } as any)
})

describe('Noren SDK: partial Dutch-auction liquidation through SwapVM', () => {
  it('maker ships a Dutch strategy; a plan with two missed installments is cured by one partial fill', async () => {
    const mk = createNorenDutch({ publicClient, walletClient: wallet(maker), addresses: deployment })
    const shipped = await mk.shipDutchStrategy({ asset: STOCKS.NVDA, usdgAmount: 5_000_000_000n, salt: 11n })
    expect(shipped.strategyHash).toMatch(/^0x[0-9a-f]{64}$/)

    const m = createNorenRobinhood({ publicClient, walletClient: wallet(merchant), addresses: deployment })
    const c = createNorenRobinhood({ publicClient, walletClient: wallet(customer), addresses: deployment })
    const signed = await signAttestation({ borrower: customer.address, terms: { tier: 3, limitUsdg: 2_500_000_000n, collateralRatioBps: 13000 }, credit: deployment.credit, chainId: 4663, publicClient })
    if (signed.declined) throw new Error(signed.reason)
    await c.applyAttestation(signed)
    const id = toHex(crypto.getRandomValues(new Uint8Array(32)))
    await m.createInvoice({ invoiceId: id, amountUsdg: 300_000_000n, expiry: BigInt(Math.floor(Date.now() / 1000) + 86400) })
    const plan = await c.openPlan({ invoiceId: id, merchant: merchant.address, collateral: STOCKS.NVDA, collateralAmount: 3n * 10n ** 18n })

    const k = createNorenDutch({ publicClient, walletClient: wallet(keeper), addresses: deployment })
    const healthy = await k.auctionStatus(plan.planId)
    expect(healthy.open).toBe(false)
    expect(healthy.liquidatable).toBe(false)
    await expect(k.openAuction(plan.planId)).rejects.toThrow(/NotLiquidatable/)

    const info = await c.liquidationInfo(plan.planId)
    const now = BigInt((await publicClient.getBlock()).timestamp)
    await warp(Number(info.schedule[1].defaultsAfter - now + 5n)) // installments 1 and 2 missed
    const late = await k.auctionStatus(plan.planId)
    expect(late.overdue).toBe(true)
    expect(late.liquidatable).toBe(true)
    expect(late.message).toMatch(/anyone can open an auction/)

    await k.openAuction(plan.planId)
    await warp(600)
    const open = await k.auctionStatus(plan.planId)
    expect(open.open).toBe(true)
    expect(open.discountWad).toBeGreaterThan(5n * 10n ** 15n) // above the 0.5% start after 10 minutes
    expect(open.discountWad).toBeLessThan(8n * 10n ** 16n)
    console.log(open.message)

    const preview = await k.previewPartialLiquidation({ planId: plan.planId })
    expect(preview.repayUsdg).toBe(200_000_000n) // exactly the two missed installments
    expect(preview.sellAll).toBe(false)
    const vaultBefore = await bal(USDG, deployment.vault)
    const keeperBefore = await bal(STOCKS.NVDA, keeper.address)
    const res = await k.fillPartialLiquidation({ planId: plan.planId })
    expect(res.filled.repaidUsdg).toBe(200_000_000n)
    expect(res.auctionClosed).toBe(true)
    expect((await bal(USDG, deployment.vault)) - vaultBefore).toBe(200_000_000n)
    expect((await bal(STOCKS.NVDA, keeper.address)) - keeperBefore).toBe(res.filled.keeperBonus)

    const p = (await publicClient.readContract({ address: deployment.credit, abi: norenCreditAbi, functionName: 'plan', args: [plan.planId] })) as any
    expect(p.status).toBe(1) // still Active
    expect(p.paid).toBe(2)
    expect(p.collateralAmount).toBe(3n * 10n ** 18n - res.filled.collateralSold - res.filled.keeperBonus)
    const after = await k.auctionStatus(plan.planId)
    expect(after.open).toBe(false)
    expect(after.liquidatable).toBe(false)
    await expect(k.fillPartialLiquidation({ planId: plan.planId })).rejects.toThrow(/AuctionNotOpen/)
    console.log(`fill ${res.receipt.transactionHash}: sold ${res.filled.collateralSold} NVDA wei, keeper ${res.filled.keeperBonus}, plan keeps ${p.collateralAmount}`)
  })
})
