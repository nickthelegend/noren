// Partial Dutch-auction liquidation through 1inch SwapVM, on a LOCAL FORK of Robinhood Chain mainnet.
// Every step sends a real transaction on the fork and prints its hash and the real ERC-20 deltas.
// Started by scripts/dutch-demo.sh, which forks mainnet and deploys Noren with the opcode-35 router.
// Anvil's published dev keys are used: fork only, no real money.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, parseAbi, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createNorenDutch,
  createNorenRobinhood,
  erc20PermitAbi,
  norenCreditAbi,
  STOCKS,
  USDG,
  formatUnitsTrim,
  formatDiscount,
  formatHealth,
  usd,
  type NorenAddresses,
} from '@noren/robinhood/sdk'
import { signAttestation } from '@noren/robinhood/underwriter'

const [deploymentPath, artifactPath] = process.argv.slice(2)
if (!deploymentPath || !artifactPath) throw new Error('usage: tsx dutch-demo.ts <deployment.json> <NorenDutchAuction artifact>')
const d = JSON.parse(readFileSync(deploymentPath, 'utf8')) as NorenAddresses & Record<string, any>
const rpc = d.rpcUrl as string
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc)) throw new Error('Refusing: the demo only runs against a local fork')

const key = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  customer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  merchant: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  maker: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  keeper: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const
type Who = keyof typeof key
const acct = Object.fromEntries(Object.entries(key).map(([k, v]) => [k, privateKeyToAccount(v as Hex)])) as Record<Who, ReturnType<typeof privateKeyToAccount>>
const pc = createPublicClient({ transport: http(rpc) })
const wallet = (who: Who) => createWalletClient({ account: acct[who], transport: http(rpc) })
const sdk = (who: Who) => createNorenRobinhood({ publicClient: pc, walletClient: wallet(who), addresses: d })
const dutch = (who: Who) => createNorenDutch({ publicClient: pc, walletClient: wallet(who), addresses: d })

const NVDA = STOCKS.NVDA as Address
const MULTIPLIER_ADMIN = '0x92905e8d0e2301BA143215B8D86D63fFD4188143' as Address // real Stock Token role holder, impersonated on the fork only
const bal = (t: Address, w: Address) => pc.readContract({ address: t, abi: erc20PermitAbi, functionName: 'balanceOf', args: [w] }) as Promise<bigint>
const nv = (v: bigint) => `${formatUnitsTrim(v, 18, 6)} NVDA`
const usdg = (v: bigint) => `${formatUnitsTrim(v, 6, 2)} USDG`
let step = 0
const title = (s: string) => console.log(`\n=== ${++step}. ${s}`)
const tx = (label: string, h: Hex) => console.log(`  fork tx  ${h}  ${label}`)
const line = (s: string) => console.log(`  ${s}`)
const rpcCall = (method: string, params: unknown[] = []) => pc.request({ method, params } as any) as Promise<any>
const warp = async (seconds: number) => {
  await rpcCall('evm_increaseTime', [seconds])
  await rpcCall('evm_mine')
}

const people: [string, Address][] = [
  ['borrower', acct.customer.address],
  ['maker', acct.maker.address],
  ['keeper', acct.keeper.address],
  ['vault', d.vault],
  ['plan (NorenCredit)', d.credit],
]
async function balances() {
  const out: Record<string, [bigint, bigint]> = {}
  for (const [n, w] of people) out[n] = [await bal(USDG, w), await bal(NVDA, w)]
  return out
}
function deltas(a: Record<string, [bigint, bigint]>, b: Record<string, [bigint, bigint]>) {
  for (const [n] of people) {
    const du = b[n][0] - a[n][0]
    const dn = b[n][1] - a[n][1]
    if (du !== 0n) line(`${n.padEnd(19)} ${du > 0n ? '+' : ''}${usdg(du)}`)
    if (dn !== 0n) line(`${n.padEnd(19)} ${dn > 0n ? '+' : ''}${nv(dn)}`)
  }
}
const planOf = async (planId: bigint) => (await pc.readContract({ address: d.credit, abi: norenCreditAbi, functionName: 'plan', args: [planId] })) as any

console.log('Noren partial Dutch-auction liquidation through 1inch SwapVM, on a local fork of Robinhood Chain mainnet (chain 4663)')
console.log(`forked from block ${d.forkBlock ?? '?'} | RPC ${rpc} | every hash below is a transaction on this fork, not on mainnet`)

title('Deploy NorenDutchAuction and register a Dutch maker strategy')
const opcode = await pc.readContract({ address: d.swapRouter!, abi: parseAbi(['function NOREN_DUTCH_DECAY_OPCODE() view returns (uint8)']), functionName: 'NOREN_DUTCH_DECAY_OPCODE' })
line(`Noren SwapVM router ${d.swapRouter}: NorenOraclePeg = opcode 34, NorenDutchDecay = opcode ${opcode} (redeployed on the fork)`)
const art = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: any; bytecode: { object: Hex } }
const schedule = { start: 50, cap: 800, duration: 3600, keeperShare: 2500, target: 11_000 }
const deployHash = await wallet('owner').deployContract({
  abi: art.abi,
  bytecode: art.bytecode.object,
  args: [acct.owner.address, d.credit, d.swapRouter, schedule.start, schedule.cap, schedule.duration, schedule.keeperShare, schedule.target],
  chain: null,
})
const deployed = await pc.waitForTransactionReceipt({ hash: deployHash })
d.dutchAuction = deployed.contractAddress as Address
tx(`deploy NorenDutchAuction ${d.dutchAuction}`, deployHash)
line(`discount ${schedule.start / 100}% at open -> ${schedule.cap / 100}% cap over ${schedule.duration / 60} min; keeper share ${schedule.keeperShare / 100}% of the discount; target health ${schedule.target / 10_000}`)
const setHash = await wallet('owner').writeContract({ address: d.credit, abi: norenCreditAbi, functionName: 'setDutchAuction', args: [d.dutchAuction], chain: null })
await pc.waitForTransactionReceipt({ hash: setHash })
tx('owner NorenCredit.setDutchAuction', setHash)
const shipped = await dutch('maker').shipDutchStrategy({ asset: NVDA, usdgAmount: 10_000_000_000n })
tx(`maker Aqua.ship Salt | NorenDutchDecay | NorenOraclePeg(bid 0, buy-only), 10,000 USDG virtual, strategy ${shipped.strategyHash}`, shipped.shipHash)
tx('maker NorenDutchAuction.register', shipped.registerHash)

title("Borrower opens a Pay-in-3 plan: 300 USDG against 2.2 NVDA")
const signed = await signAttestation({ borrower: acct.customer.address, terms: { tier: 3, limitUsdg: 2_500_000_000n, collateralRatioBps: 13_000 }, credit: d.credit, chainId: 4663, publicClient: pc as any })
if (signed.declined) throw new Error(signed.reason)
tx(`applyAttestation (EIP-712, tier 3)`, (await sdk('customer').applyAttestation(signed)).transactionHash)
const inv = toHex(crypto.getRandomValues(new Uint8Array(32)))
const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400)
tx('merchant createInvoice 300 USDG', (await sdk('merchant').createInvoice({ invoiceId: inv, amountUsdg: 300_000_000n, expiry })).transactionHash)
const plan = await sdk('customer').openPlan({ invoiceId: inv, merchant: acct.merchant.address, collateral: NVDA, collateralAmount: 22n * 10n ** 17n })
tx(`openPlan #${plan.planId}`, plan.hash)
const planId = plan.planId
let st = await dutch('keeper').auctionStatus(planId)
line(`NVDA ${usd(st.priceUsd8)} | collateral ${nv(st.collateralAmount)} | debt ${usdg(st.outstandingUsdg)} | health ${formatHealth(st.healthWad)}`)

title("NVDA's value falls and the position goes unhealthy")
const multiplierAbi = parseAbi(['function uiMultiplier() view returns (uint256)', 'function updateMultiplier(uint256)'])
const m = (await pc.readContract({ address: NVDA, abi: multiplierAbi, functionName: 'uiMultiplier' })) as bigint
const newM = (m * 96n * 10n ** 16n) / st.healthWad // health 0.96
await rpcCall('anvil_impersonateAccount', [MULTIPLIER_ADMIN])
await rpcCall('anvil_setBalance', [MULTIPLIER_ADMIN, '0x8AC7230489E80000'])
const dropHash = await createWalletClient({ account: MULTIPLIER_ADMIN, transport: http(rpc) }).writeContract({ address: NVDA, abi: multiplierAbi, functionName: 'updateMultiplier', args: [newM], chain: null })
await pc.waitForTransactionReceipt({ hash: dropHash })
await rpcCall('anvil_stopImpersonatingAccount', [MULTIPLIER_ADMIN])
tx(`NVDA.updateMultiplier ${formatUnitsTrim(m, 18, 6)} -> ${formatUnitsTrim(newM, 18, 6)} (real Stock Token admin path, impersonated on the fork: stands in for a ${formatUnitsTrim(((m - newM) * 100n * 10n ** 18n) / m, 18, 1)}% price fall)`, dropHash)
st = await dutch('keeper').auctionStatus(planId)
line(`collateral now worth ${usd((st.collateralAmount * st.priceUsd8 * newM) / 10n ** 36n)} vs debt ${usdg(st.outstandingUsdg)} | health ${formatHealth(st.healthWad)} | ${st.message}`)

title('For comparison: the old full liquidation (run, measured, then reverted with evm_revert)')
const snap = await rpcCall('evm_snapshot')
const full = await sdk('keeper').liquidatePlanViaAqua(planId)
tx('liquidatePlanViaAqua (whole debt + 5% keeper bonus, peg maker bid 50 bps)', full.receipt.transactionHash)
const fullReturned = full.sale.returned as bigint
line(`sold ${nv(full.sale.sold)} + keeper bonus ${nv(full.sale.bonus)}; borrower gets back ${nv(fullReturned)} and owes 0`)
await rpcCall('evm_revert', [snap])
line('fork state reverted to before the full liquidation')

title('Anyone opens the Dutch auction')
const opened = await dutch('keeper').openAuction(planId)
tx(`openAuction #${planId} (keeper)`, opened.receipt.transactionHash)
st = await dutch('keeper').auctionStatus(planId)
line(st.message)

title('The discount climbs (fork time travel)')
for (const minutes of [0, 10, 20]) {
  if (minutes) await warp(600)
  st = await dutch('keeper').auctionStatus(planId)
  const p = await dutch('keeper').previewPartialLiquidation({ planId })
  line(
    `t+${String(minutes).padStart(2)} min  discount ${formatDiscount(st.discountWad).padEnd(6)} (maker ${formatDiscount(st.makerDiscountWad)}, keeper ${formatDiscount(st.keeperDiscountWad)})  ` +
      `fill: repay ${usdg(p.repayUsdg)} by selling ${nv(p.collateralSold)} + keeper ${nv(p.keeperBonus)} -> health ${formatHealth(p.healthAfterWad)}`,
  )
}

title('Keeper fills: only enough collateral to restore health to 1.10')
const before = await balances()
const filled = await dutch('keeper').fillPartialLiquidation({ planId })
tx('NorenDutchAuction.fill -> NorenCredit.auctionSeize -> SwapVM.swap (NorenDutchDecay + NorenOraclePeg) -> Aqua.pull/push', filled.receipt.transactionHash)
deltas(before, await balances())
const f = filled.filled
line(`discount ${formatDiscount(f.discountWad)}: maker paid ${usdg(f.repaidUsdg)} for ${nv(f.collateralSold)} (to the lender pool); keeper bonus ${nv(f.keeperBonus)}; keeper paid nothing`)

title('Health restored; the auction closed; the rest stays with the borrower')
st = await dutch('keeper').auctionStatus(planId)
const pl = await planOf(planId)
line(`health ${formatHealth(st.healthWad)} (target ${formatHealth(st.targetHealthWad)}) | auction open: ${st.open} | plan status ${['None', 'Active', 'Repaid', 'Liquidated'][pl.status]}`)
line(`plan: ${nv(pl.collateralAmount)} still locked for the borrower, ${usdg(pl.principal - pl.repaid)} left to repay, installments paid ${pl.paid}/3`)
const valueLeft = (pl.collateralAmount * st.priceUsd8 * newM) / 10n ** 36n // USD 8 decimals
const equityDutch = valueLeft - (pl.principal - pl.repaid) * 100n
const equityFull = (fullReturned * st.priceUsd8 * newM) / 10n ** 36n
line(`borrower kept ${nv(pl.collateralAmount)} vs ${nv(fullReturned)} under full liquidation`)
line(`borrower equity (collateral value - debt): ${usd(equityDutch)} with the Dutch fill vs ${usd(equityFull)} after full liquidation`)
console.log('\nDone. Fork only: no mainnet transaction was sent.')
