// Noren x 1inch Aqua + SwapVM final demo on a LOCAL FORK of Robinhood Chain mainnet (chain 4663).
// Every step sends a real transaction on the fork and prints its hash and the real ERC-20 deltas.
// Started by scripts/aqua-demo.sh, which forks mainnet, deploys Noren and seeds one maker.
// Anvil's published dev keys are used: fork only, no real money.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, http, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createNorenRobinhood,
  erc20PermitAbi,
  norenGatewayAbi,
  norenLiquidityAbi,
  OFFICIAL_SWAPVM_ROUTER,
  AQUA,
  STOCKS,
  USDG,
  WETH,
  NATIVE_ETH,
  formatUnitsTrim,
  usd,
  type NorenAddresses,
} from '@noren/robinhood/sdk'
import { signAttestation } from '@noren/robinhood/underwriter'

const [deploymentPath, broadcastDir] = process.argv.slice(2)
if (!deploymentPath) throw new Error('usage: tsx aqua-demo.ts <deployment.json> <contracts/broadcast dir>')
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
const acct = Object.fromEntries(Object.entries(key).map(([k, v]) => [k, privateKeyToAccount(v as Hex)])) as Record<keyof typeof key, ReturnType<typeof privateKeyToAccount>>
const pc = createPublicClient({ transport: http(rpc) })
const sdk = (who: keyof typeof key) => createNorenRobinhood({ publicClient: pc, walletClient: createWalletClient({ account: acct[who], transport: http(rpc) }), addresses: d })

const NVDA = STOCKS.NVDA as Address
const bal = (t: Address, w: Address) => pc.readContract({ address: t, abi: erc20PermitAbi, functionName: 'balanceOf', args: [w] }) as Promise<bigint>
const fmt = (v: bigint, dec: number) => formatUnitsTrim(v, dec, dec === 6 ? 2 : 6)
const usdg = (v: bigint) => `${fmt(v, 6)} USDG`
const delta = (v: bigint, dec: number, sym: string) => `${v >= 0n ? '+' : ''}${fmt(v, dec)} ${sym}`
let step = 0
const title = (s: string) => console.log(`\n=== ${++step}. ${s}`)
const tx = (label: string, h: Hex) => console.log(`  fork tx  ${h}  ${label}`)
const line = (s: string) => console.log(`  ${s}`)

async function snapshotBalances(tokens: [Address, number, string][], people: [string, Address][]) {
  const out: Record<string, bigint> = {}
  for (const [name, who] of people) for (const [t, , sym] of tokens) out[`${name}:${sym}`] = await bal(t, who)
  return out
}
function printDeltas(before: Record<string, bigint>, after: Record<string, bigint>, tokens: [Address, number, string][]) {
  for (const k of Object.keys(after)) {
    const diff = after[k] - before[k]
    if (diff === 0n) continue
    const sym = k.split(':')[1]
    const dec = tokens.find((t) => t[2] === sym)![1]
    line(`${k.split(':')[0].padEnd(9)} ${delta(diff, dec, sym)}`)
  }
}

const broadcast = (script: string) => {
  try {
    const j = JSON.parse(readFileSync(`${broadcastDir}/${script}/4663/run-latest.json`, 'utf8')) as {
      transactions: { hash: Hex; transactionType: string; contractName?: string | null; function?: string | null; contractAddress?: string }[]
    }
    return j.transactions
  } catch {
    return []
  }
}

console.log('Noren x 1inch Aqua + SwapVM on a local fork of Robinhood Chain mainnet (chain 4663)')
console.log(`forked from block ${d.forkBlock ?? '?'} | RPC ${rpc} | every hash below is a transaction on this fork, not on mainnet`)

title('Official 1inch contracts on the fork (real addresses, real bytecode)')
const domain = (await pc.readContract({
  address: OFFICIAL_SWAPVM_ROUTER,
  abi: [{ type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes1' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256[]' }] }],
  functionName: 'eip712Domain',
})) as readonly unknown[]
line(`Aqua registry          ${AQUA}  (${((await pc.getBytecode({ address: AQUA })) ?? '0x').length / 2 - 1} bytes)`)
line(`SwapVM router (1inch)  ${OFFICIAL_SWAPVM_ROUTER}  "${domain[1]}" ${domain[2]}`)
line(`Noren SwapVM router    ${d.swapRouter}  AquaSwapVMRouter v1.0.2 + NorenOraclePeg (opcode 34), redeployed on the fork`)
line(`NorenLiquidity         ${d.liquidity}`)
for (const t of broadcast('Deploy.s.sol')) {
  if (t.transactionType === 'CREATE2') tx(`CREATE2 ${t.contractName ?? 'NorenAquaSwapVMRouter (swapvm-ext artifact)'} ${t.contractAddress}`, t.hash)
  else if (t.function?.startsWith('setLiquidity')) tx(`${t.contractName}.${t.function}`, t.hash)
}

title('Maker ships Chainlink-pegged strategies (USDG stays in the maker wallet)')
line(`maker ${acct.maker.address} (a merchant with idle USDG), funded by fork tx ${d.seedTxs?.makerUsdg}`)
for (const t of broadcast('SeedMakers.s.sol')) tx(`${t.contractName ?? (t.contractAddress?.toLowerCase() === AQUA.toLowerCase() ? 'Aqua' : t.contractAddress?.toLowerCase() === d.liquidity?.toLowerCase() ? 'NorenLiquidity' : `token ${t.contractAddress}`)}.${t.function?.split('(')[0] ?? 'call'}`, t.hash)
const p0 = await sdk('maker').makerPositions(acct.maker.address)
line(`wallet ${usdg(p0.walletUsdg)}; Aqua virtual balances per strategy:`)
for (const s of p0.strategies) line(`  ${s.symbol.padEnd(5)} bid ${s.bidSpreadBps} bps / ask ${s.askSpreadBps} bps  ${usdg(s.aquaUsdg)}  ${s.strategyHash}`)

title('Pay with stocks: a 250 USDG invoice paid in NVDA, converted by the maker through SwapVM')
const inv1 = toHex(crypto.getRandomValues(new Uint8Array(32)))
const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400)
const created = await sdk('merchant').createInvoice({ invoiceId: inv1, amountUsdg: 250_000_000n, expiry })
tx('merchant createInvoice 250 USDG', created.transactionHash)
const q = await sdk('customer').quote({ merchant: acct.merchant.address, invoiceId: inv1, asset: NVDA })
line(`quote: ${fmt(q.assetIn, 18)} NVDA at Chainlink ${usd(q.priceUsd8)}/share, route ${q.route} ${q.strategyHash ?? ''}${q.marketClosed ? ' (US market closed: wider spread)' : ''}`)
const T: [Address, number, string][] = [
  [USDG, 6, 'USDG'],
  [NVDA, 18, 'NVDA'],
  [WETH, 18, 'WETH'],
]
const people: [string, Address][] = [
  ['customer', acct.customer.address],
  ['merchant', acct.merchant.address],
  ['maker', acct.maker.address],
  ['vault', d.vault],
  ['keeper', acct.keeper.address],
]
let before = await snapshotBalances(T, people)
const paid = await sdk('customer').pay({ merchant: acct.merchant.address, invoiceId: inv1, asset: NVDA })
tx(`customer pay (${paid.paymentMethod}) -> NorenGateway -> NorenLiquidity -> SwapVM.swap -> Aqua.pull/push`, paid.hash)
printDeltas(before, await snapshotBalances(T, people), T)
line(`maker fee booked at Chainlink: ${usdg(paid.makerFill!.feeUsdg)} (oracle value of the NVDA minus the USDG it paid)`)

title('Pay with ETH: 100 USDG invoice, native ETH wrapped and sold to the WETH maker')
const inv2 = toHex(crypto.getRandomValues(new Uint8Array(32)))
tx('merchant createInvoice 100 USDG', (await sdk('merchant').createInvoice({ invoiceId: inv2, amountUsdg: 100_000_000n, expiry })).transactionHash)
before = await snapshotBalances(T, people)
const ethPaid = await sdk('customer').pay({ merchant: acct.merchant.address, invoiceId: inv2, asset: NATIVE_ETH })
tx(`customer pay ${fmt(ethPaid.quote.assetIn, 18)} ETH (route ${ethPaid.quote.route})`, ethPaid.hash)
printDeltas(before, await snapshotBalances(T, people), T)

title('Best execution: Aqua maker (Chainlink-pegged) vs the live Uniswap v4 NVDA/USDG pool')
for (const amt of [10n ** 18n, 50n * 10n ** 18n]) {
  const b = await sdk('customer').bestExecution({ asset: NVDA, amountIn: amt })
  line(
    `${fmt(amt, 18).padStart(3)} NVDA sold: Chainlink ${usdg(b.chainlinkUsdg)} | Aqua maker ${b.maker ? usdg(b.maker.usdgOut) : 'none'} (-${b.makerDiscountBps} bps) | Uniswap v4 ${b.uniswapV4Usdg === null ? `unavailable: ${b.uniswapV4Error}` : `${usdg(b.uniswapV4Usdg)} (-${b.uniswapV4DiscountBps} bps)`} -> ${b.winner}`,
  )
}

line('Noren routes conversions to Aqua makers only (Uniswap is quoted, never traded): the maker price is Chainlink - spread at any size, the pool price moves with size.')

title('Pay later becomes Pay in 3: 300 USDG against 3 NVDA')
const signed = await signAttestation({ borrower: acct.customer.address, terms: { tier: 3, limitUsdg: 2_500_000_000n, collateralRatioBps: 13_000 }, credit: d.credit, chainId: 4663, publicClient: pc as any })
if (signed.declined) throw new Error(signed.reason)
tx(`applyAttestation (EIP-712, tier 3, signer ${signed.signer})`, (await sdk('customer').applyAttestation(signed)).transactionHash)
const inv3 = toHex(crypto.getRandomValues(new Uint8Array(32)))
tx('merchant createInvoice 300 USDG', (await sdk('merchant').createInvoice({ invoiceId: inv3, amountUsdg: 300_000_000n, expiry })).transactionHash)
before = await snapshotBalances(T, people)
const plan = await sdk('customer').openPlan({ invoiceId: inv3, merchant: acct.merchant.address, collateral: NVDA, collateralAmount: 3n * 10n ** 18n })
tx(`openPlan #${plan.planId}: vault pays the merchant upfront minus the 3% merchant fee`, plan.hash)
printDeltas(before, await snapshotBalances(T, people), T)
let info = await sdk('customer').liquidationInfo(plan.planId)
for (const s of info.schedule) line(`installment ${s.installment}: ${usdg(s.amountUsdg)} due ${new Date(Number(s.dueAt) * 1000).toISOString()}`)
line(`app: "${info.message}"  (NVDA now ${usd(info.priceUsd8)}, buffer ${(info.bufferBps / 100).toFixed(1)}%)`)
const r1 = await sdk('customer').repay({ planId: plan.planId, count: 1 })
tx(`repay installment 1 (${usdg(r1.amountUsdg)}, ${r1.paymentMethod})`, r1.hash)
info = await sdk('customer').liquidationInfo(plan.planId)
line(`app: "${info.message}"`)

title('The customer misses installments 2 and 3 (fork time travel past the grace period)')
const target = info.schedule[2].defaultsAfter + 5n
const now = BigInt((await pc.getBlock()).timestamp)
await pc.request({ method: 'evm_increaseTime', params: [Number(target - now)] } as any)
await pc.request({ method: 'evm_mine', params: [] } as any)
info = await sdk('keeper').liquidationInfo(plan.planId)
line(`missed payments: ${info.missedPayments}, liquidatable: overdue=${info.liquidatable.overdue} undercollateralised=${info.liquidatable.undercollateralised}`)

title('Keeper liquidates through SwapVM: collateral sold to the maker, vault repaid, remainder returned')
before = await snapshotBalances(T, people)
const liq = await sdk('keeper').liquidatePlanViaAqua(plan.planId)
tx('liquidatePlanViaAqua (keeper pays nothing)', liq.receipt.transactionHash)
printDeltas(before, await snapshotBalances(T, people), T)
line(`sold ${fmt(liq.sale.sold, 18)} NVDA for ${usdg(liq.sale.proceedsUsdg)} -> vault; keeper bonus ${fmt(liq.sale.bonus, 18)} NVDA; returned to borrower ${fmt(liq.sale.returned, 18)} NVDA; bad debt ${usdg(liq.liquidated.badDebtUsdg)}`)
for (const log of liq.receipt.logs) {
  try {
    const e = decodeEventLog({ abi: norenLiquidityAbi, data: log.data, topics: log.topics }) as any
    if (e.eventName === 'MakerFill') line(`MakerFill: maker ${e.args.maker} bought ${fmt(e.args.assetIn, 18)} NVDA for ${usdg(e.args.usdgOut)}, fee ${usdg(e.args.feeUsdg)}`)
  } catch {}
}

title('No maker liquidity: clear fallback and error')
const inv4 = toHex(crypto.getRandomValues(new Uint8Array(32)))
tx('merchant createInvoice 50 USDG', (await sdk('merchant').createInvoice({ invoiceId: inv4, amountUsdg: 50_000_000n, expiry })).transactionHash)
const spy = await sdk('customer').quote({ merchant: acct.merchant.address, invoiceId: inv4, asset: STOCKS.SPY as Address })
line(`SPY has no maker strategy: route ${spy.route} (vault buys it at Chainlink + spread), ${fmt(spy.assetIn, 18)} SPY`)
const owner = createWalletClient({ account: acct.owner, transport: http(rpc) })
const off = await owner.writeContract({ address: d.gateway, abi: norenGatewayAbi, functionName: 'setLiquidity', args: [d.liquidity!, false], chain: null })
await pc.waitForTransactionReceipt({ hash: off })
tx('owner setLiquidity(vaultFallback = false)', off)
try {
  await sdk('customer').quote({ merchant: acct.merchant.address, invoiceId: inv4, asset: STOCKS.SPY as Address })
  line('unexpected: quote succeeded')
} catch (e) {
  const m = (e as Error).message.match(/NoMakerLiquidity\([^)]*\)|reverted with the following reason:[^\n]*|Error: [^\n]*/)
  line(`quote reverts: ${m ? m[0] : (e as Error).message.split('\n')[0]}`)
}

title('Final maker position and fees')
const pf = await sdk('maker').makerPositions(acct.maker.address)
line(`maker wallet ${usdg(pf.walletUsdg)}; total spread fees booked ${usdg(pf.feesUsdg)}`)
for (const s of pf.strategies.filter((x) => x.fills > 0))
  line(`  ${s.symbol.padEnd(5)} fills ${s.fills}  volume ${usdg(s.volumeUsdg)}  fees ${usdg(s.feesUsdg)}  Aqua: ${usdg(s.aquaUsdg)} + ${fmt(s.aquaAsset, 18)} ${s.symbol}  inventory ${s.inventoryUsd8 === null ? 'n/a' : usd(s.inventoryUsd8)}`)
console.log('\nDone. Fork only: no mainnet transaction was sent.')
