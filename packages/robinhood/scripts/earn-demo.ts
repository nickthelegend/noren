// Deposit-and-earn, borrow and reputation demo on the warmed Robinhood mainnet snapshot (local fork,
// chain 4663; real WETH, USDG, NVDA, Chainlink feeds, official 1inch Aqua). Every line with a hash
// is a FORK transaction. The chain is reverted at the end (evm_snapshot / evm_revert).
//   NOREN_RH_RPC=http://127.0.0.1:8772 pnpm exec tsx scripts/earn-demo.ts
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNorenEarn, createNorenRobinhood, recordVerifiedHuman, NATIVE_ETH, STOCKS, WETH } from '../sdk/src/index.js'
import { norenBorrowAbi } from '../sdk/src/abi.js'
import { loadForkDeployment, loadWorldAttesterKey } from '../sdk/src/node.js'
import { signAttestation } from '../underwriter/src/attest.js'

const rpc = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8720'
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc)) throw new Error('Refusing: the demo only targets a local fork')
const pc = createPublicClient({ transport: http(rpc) })
if ((await pc.getChainId()) !== 4663) throw new Error('Setup required: serve the snapshot (sh scripts/serve-snapshot.sh)')
const d = { ...(loadForkDeployment() as any), rpcUrl: rpc }
if (!d.borrow) throw new Error('Setup required: rebuild the snapshot with NorenBorrow (sh scripts/fork-snapshot.sh)')
// Anvil published dev keys (fork only): #0 owner, #1 customer, #2 merchant, #3 trader, #4 keeper.
const keys = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  customer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  merchant: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  trader: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  keeper: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const
const acct = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v as Hex)])) as Record<keyof typeof keys, ReturnType<typeof privateKeyToAccount>>
const wallet = (k: keyof typeof keys) => createWalletClient({ account: acct[k], transport: http(rpc) })
const earn = (k: keyof typeof keys) => createNorenEarn({ publicClient: pc, walletClient: wallet(k), addresses: d })
const rh = (k: keyof typeof keys) => createNorenRobinhood({ publicClient: pc, walletClient: wallet(k), addresses: d })
const usd6 = (v: bigint) => `${(Number(v) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const units = (v: bigint, dec = 18) => (Number(v) / 10 ** dec).toLocaleString('en-US', { maximumFractionDigits: 6 })
const title = (s: string) => console.log(`\n== ${s}`)
const line = (s: string) => console.log(`   ${s}`)
const tx = (label: string, h: Hex) => console.log(`   fork tx ${h}  ${label}`)
const warp = async (s: number) => {
  await pc.request({ method: 'evm_increaseTime', params: [s] } as any)
  await pc.request({ method: 'evm_mine', params: [] } as any)
}
const snap = (await pc.request({ method: 'evm_snapshot' } as any)) as Hex
const c = earn('customer')
const limit = async (label: string) => {
  const l = await c.creditLimit(acct.customer.address)
  line(`${label.padEnd(30)} credit limit ${usd6(l.totalUsd6).padStart(9)}  = deposits x ${l.ltvBps / 100}% (${usd6(l.securedUsdg)} USDG) + World ID starter ${usd6(l.starterUsdc6)} USDC; Pay-in-3 multiplier ${l.limitMultiplierBps / 10_000}x`)
  return l
}

try {
  console.log(`Noren earn and borrow demo on ${rpc} (Robinhood mainnet snapshot, block ${d.forkedFromBlock ?? '?'}; fork transactions only)`)
  title('Contracts')
  line(`NorenBorrow ${d.borrow} | NorenReputation ${d.reputation} | lender pool NorenVault ${d.vault}`)
  for (const v of await c.vaults()) line(`${v.name} (${v.symbol}) ${v.vault}`)

  title('1. Deposit 1 ETH and 2 NVDA; receipt shares back the vaults\' Aqua maker strategies')
  const e = await c.deposit({ asset: NATIVE_ETH, amount: 10n ** 18n })
  tx(`depositETH 1 ETH -> ${units(e.shares, 24)} nETH`, e.hash)
  const n = await c.deposit({ asset: STOCKS.NVDA, amount: 2n * 10n ** 18n })
  tx(`deposit 2 NVDA -> ${units(n.shares, 24)} nNVDA`, n.hash)
  const l0 = await limit('Deposit only')

  title('2. Real maker fills earn the spread')
  const sale = await earn('trader').buyAsset({ asset: WETH, amountOut: 3n * 10n ** 17n })
  tx(`trader buys 0.3 ETH from nETH at Chainlink + 40 bps: ${usd6(sale.sale.usdgIn)} USDG, fee ${usd6(sale.sale.feeUsdg)}`, sale.receipt.transactionHash)
  const inv = toHex(crypto.getRandomValues(new Uint8Array(32)))
  await rh('merchant').createInvoice({ invoiceId: inv, amountUsdg: 400_000_000n, expiry: BigInt(Math.floor(Date.now() / 1000) + 86400) })
  const paid = await rh('customer').pay({ merchant: acct.merchant.address, invoiceId: inv, asset: NATIVE_ETH })
  const fill = paid.makerFill
  tx(`a shopper pays a 400 USDG invoice with ETH; maker ${fill?.maker === undefined ? '?' : fill.maker.toLowerCase() === e.vault.toLowerCase() ? 'nETH vault' : fill.maker} buys it at Chainlink - 25 bps, fee ${usd6(fill?.feeUsdg ?? 0n)}`, paid.hash)
  await warp(3600)
  const st = await c.vaultStats(NATIVE_ETH)
  line(`nETH: ${units(st.assetBalance)} WETH + ${usd6(st.usdgBalance)} USDG; ${units(st.assetsPerShare)} ETH per nETH; fees ${usd6(st.feesUsdg)} USDG over ${st.fills} fills`)
  line(st.apyLabel + (st.realisedApyBps === null ? '' : ` = ${(Number(st.realisedApyBps) / 100).toFixed(1)}% simple annualised`))
  const ys = await c.vaultStats(STOCKS.NVDA)
  line(`nNVDA: ${ys.apyLabel}`)

  title('3. World ID: the server records the verified human (one nullifier per account)')
  const human = await recordVerifiedHuman({ publicClient: pc, addresses: d, key: loadWorldAttesterKey(), account: acct.customer.address, nullifier: BigInt(keccak256(toHex('demo-human'))) % 2n ** 254n })
  tx(`NorenReputation.verifyHuman (signed by ${human.signed.signer})`, human.tx.hash)
  const l1 = await limit('Plus World ID')

  title('4. On-time repayments: Pay in 3 paid on time, and a loan repaid')
  const signed = await signAttestation({ borrower: acct.customer.address, terms: { tier: 2, limitUsdg: 1_000_000_000n, collateralRatioBps: 13_000 }, credit: d.credit, chainId: 4663, publicClient: pc })
  if (signed.declined) throw new Error(signed.reason)
  await rh('customer').applyAttestation(signed)
  const inv2 = toHex(crypto.getRandomValues(new Uint8Array(32)))
  await rh('merchant').createInvoice({ invoiceId: inv2, amountUsdg: 300_000_000n, expiry: BigInt(Math.floor(Date.now() / 1000) + 86400) })
  const plan = await rh('customer').openPlan({ invoiceId: inv2, merchant: acct.merchant.address, collateral: NATIVE_ETH, collateralAmount: 3n * 10n ** 17n })
  tx(`Pay in 3 opened for 300 USDG (0.3 ETH collateral)`, plan.hash)
  const rp = await rh('customer').repay({ planId: plan.planId, count: 3 })
  tx(`three installments paid on time (${usd6(rp.amountUsdg)} USDG)`, rp.hash)
  const l2 = await limit('Plus on-time Pay in 3')
  // The loan milestone needs a loan open >= 1 day; on this fork the owner sets 15 minutes (like the
  // 15-minute Pay-in-3 demo interval) because the frozen USDG/USD feed would go stale after a day.
  const ownerTx = await wallet('owner').writeContract({ address: d.borrow, abi: norenBorrowAbi, functionName: 'setParams', args: [8500, 500, 500, 10_000_000n, 900], chain: null })
  await pc.waitForTransactionReceipt({ hash: ownerTx })
  tx('owner: loan milestone minimum age 15 min (fork demo setting)', ownerTx)
  await c.lock({ asset: NATIVE_ETH })
  const b = await c.borrow({ amountUsdg: 200_000_000n })
  tx(`borrow 200 USDG against locked nETH`, b.receipt.transactionHash)
  await warp(16 * 60)
  const r = await c.repay({ amountUsdg: 'all' })
  tx(`loan repaid in full (${usd6(r.repaid.amountUsdg)} USDG incl. ${units(r.repaid.interestUsdg, 6)} USDG interest to the lender pool)`, r.receipt.transactionHash)
  const l3 = await limit('Plus a repaid loan')
  const rep = await c.reputation(acct.customer.address)
  line(`reputation ${rep.points} points, tier ${rep.tier}; milestones: ${(await c.milestones(acct.customer.address)).filter((m) => m.achieved).map((m) => m.label).join(', ')}`)
  line(`credit limit ${usd6(l0.totalUsd6)} -> ${usd6(l1.totalUsd6)} -> ${usd6(l2.totalUsd6)} -> ${usd6(l3.totalUsd6)} (+${((Number(l3.totalUsd6 - l0.totalUsd6) / Number(l0.totalUsd6)) * 100).toFixed(1)}%)`)

  title('5. Borrow at the top tier: 80% of the deposit\'s Chainlink value, never more')
  const h = await c.health(acct.customer.address)
  line(`LTV ${h.ltvBps / 100}%: locked collateral $${usd6(h.collateralRiskUsd8 / 100n)}, borrow limit ${usd6(h.borrowLimitUsdg)} USDG`)
  try {
    await c.borrow({ amountUsdg: h.borrowLimitUsdg + 1n })
  } catch (err) {
    line(`limit + 1 wei refused: ${(err as Error).message.split('\n')[0]}`)
  }
  const top = await c.borrow({ amountUsdg: h.borrowLimitUsdg })
  tx(`borrow ${usd6(h.borrowLimitUsdg)} USDG (80%)`, top.receipt.transactionHash)
  const h2 = await c.health(acct.customer.address)
  const lp = await c.liquidationPrice(acct.customer.address, NATIVE_ETH)
  line(`health factor ${h2.healthFactor.toFixed(4)} (liquidation at 1.0, 85% LTV); ${lp.message}`)
  const rAll = await c.repay({ amountUsdg: 'all' })
  tx('repaid', rAll.receipt.transactionHash)

  title('6. Liquidity in use and the in-kind exit')
  await c.unlock({ asset: NATIVE_ETH })
  try {
    await c.withdraw({ asset: NATIVE_ETH })
  } catch (err) {
    line((err as Error).message)
  }
  const out = await c.withdraw({ asset: NATIVE_ETH, inKind: true })
  tx(`redeemInKind: ${units(out.assets)} ETH + ${usd6(out.usdg)} USDG`, out.receipt.transactionHash)

  title('7. Liquidation through Aqua makers (NVDA price drop via the real uiMultiplier role, impersonated on the fork)')
  const k = earn('keeper')
  await c.lock({ asset: STOCKS.NVDA })
  const hn = await c.health(acct.customer.address)
  const bn = await c.borrow({ amountUsdg: hn.borrowLimitUsdg })
  tx(`borrow ${usd6(hn.borrowLimitUsdg)} USDG against 2 NVDA`, bn.receipt.transactionHash)
  const admin = '0x92905e8d0e2301BA143215B8D86D63fFD4188143'
  const m0 = (await pc.readContract({ address: STOCKS.NVDA, abi: [{ type: 'function', name: 'uiMultiplier', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'uiMultiplier' })) as bigint
  await pc.request({ method: 'anvil_impersonateAccount', params: [admin] } as any)
  await pc.request({ method: 'anvil_setBalance', params: [admin, '0x56BC75E2D63100000'] } as any)
  const cut = await createWalletClient({ account: admin, transport: http(rpc) }).writeContract({ address: STOCKS.NVDA, abi: [{ type: 'function', name: 'updateMultiplier', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }], functionName: 'updateMultiplier', args: [(m0 * 92n) / 100n], chain: null })
  await pc.waitForTransactionReceipt({ hash: cut })
  tx('NVDA uiMultiplier -8% (stands in for a price drop past the 94.1% liquidation point)', cut)
  line(`health factor now ${(await c.health(acct.customer.address)).healthFactor.toFixed(4)}`)
  const liq = await k.liquidateLoanViaAqua({ borrower: acct.customer.address, asset: STOCKS.NVDA })
  tx(`keeper liquidateViaAqua: lender pool repaid ${usd6(liq.liquidated.repaidUsdg)} USDG, ${units(liq.liquidated.assetSold)} NVDA sold to makers, keeper bonus ${units(liq.liquidated.bonus)} NVDA, bad debt ${usd6(liq.liquidated.badDebtUsdg)}`, liq.receipt.transactionHash)
  const after = await c.reputation(acct.customer.address)
  line(`reputation after the liquidation: ${after.points} points, tier ${after.tier}, LTV ${after.ltvBps / 100}%`)
} finally {
  await pc.request({ method: 'evm_revert', params: [snap] } as any)
  console.log('\n(fork reverted to its snapshot)')
}
