// Noren on Robinhood Chain: typed helpers for checkout (pay with stocks through 1inch Aqua makers),
// Pay in 3, the Arc credit line, Aqua maker strategies and liquidations through SwapVM.
import {
  decodeEventLog,
  encodeAbiParameters,
  defineChain,
  hashDomain,
  parseSignature,
  zeroAddress,
  type Abi,
  type Address,
  type ContractFunctionReturnType,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem'
import { aquaAbi, erc20PermitAbi, norenAssetOracleAbi, norenCreditAbi, norenGatewayAbi, norenLiquidityAbi, norenVaultAbi, stockTokenAbi, v4QuoterAbi } from './abi.js'
import {
  AQUA,
  V4_QUOTER,
  defaultPegTerms,
  formatUnitsTrim,
  liquidationPriceUsd8,
  planLiquidationMessage,
  symbolOf,
  usd,
  type PegTerms,
  type StrategyRecord,
} from './aqua.js'
import { NATIVE_ETH, type NorenAddresses } from './addresses.js'

export * from './addresses.js'
export * from './abi.js'
export * from './aqua.js'

export type Attestation = {
  borrower: Address
  tier: number
  limitUsdg: bigint
  collateralRatioBps: number
  nonce: bigint
  expiry: bigint
}
export type Plan = ContractFunctionReturnType<typeof norenCreditAbi, 'view', 'plan'>
export type Line = ContractFunctionReturnType<typeof norenCreditAbi, 'view', 'line'>

const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const
const ROUND_UP = 1 // OpenZeppelin Math.Rounding.Ceil
/** Pay in 3: NorenCredit.INSTALLMENTS and MISSED_TO_DEFAULT. */
export const INSTALLMENTS = 3
export const MISSED_TO_DEFAULT = 2

export type PaymentMethod = 'native' | 'permit' | 'approve'

export function createNorenRobinhood({
  publicClient,
  walletClient,
  addresses,
}: {
  publicClient: PublicClient
  walletClient?: WalletClient
  addresses: NorenAddresses
}) {
  // The ABIs are fully typed; these two dispatchers keep call sites short while
  // accepting wallet clients that carry their account instead of the call.
  const pc = publicClient as any
  const wc = walletClient as any

  const account = (): Address => {
    const a = wc?.account?.address as Address | undefined
    if (!a) throw new Error('Setup required: a walletClient with an account')
    return a
  }

  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<any> =>
    pc.readContract({ address, abi, functionName, args })

  const write = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], value?: bigint): Promise<Hex> => {
    const chain =
      wc.chain ??
      defineChain({
        id: await pc.getChainId(),
        name: 'Robinhood Chain',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [addresses.rpcUrl ?? 'http://127.0.0.1:8720'] } },
      })
    account() // throws Setup required when no account is attached
    // pass the Account object so local (private-key) accounts sign client-side
    return wc.writeContract({ address, abi, functionName, args, account: wc.account, chain, ...(value === undefined ? {} : { value }) })
  }

  const confirm = async (hash: Hex): Promise<TransactionReceipt> => {
    const r = (await pc.waitForTransactionReceipt({ hash })) as TransactionReceipt
    if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
    return r
  }

  const eventArgs = (r: TransactionReceipt, abi: Abi, eventName: string): any => {
    for (const log of r.logs) {
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics }) as { eventName: string; args: unknown }
        if (decoded.eventName === eventName) return decoded.args
      } catch {
        // a log from another contract (token Transfer, Approval, ...)
      }
    }
    throw new Error(`Expected ${eventName} event missing from ${r.transactionHash}`)
  }

  const approve = async (asset: Address, spender: Address, amount: bigint) => {
    const allowed = (await read(asset, erc20PermitAbi, 'allowance', [account(), spender])) as bigint
    if (allowed >= amount) return
    await confirm(await write(asset, erc20PermitAbi, 'approve', [spender, amount]))
  }

  /** EIP-2612 permit signature, or undefined when the token's domain cannot be matched. */
  const signPermit = async (asset: Address, spender: Address, value: bigint) => {
    const [name, separator, nonce, chainId] = (await Promise.all([
      read(asset, erc20PermitAbi, 'name'),
      read(asset, erc20PermitAbi, 'DOMAIN_SEPARATOR'),
      read(asset, erc20PermitAbi, 'nonces', [account()]),
      pc.getChainId(),
    ])) as [string, Hex, bigint, number]
    // USDG and Robinhood Stock Tokens both use version "1" (probed); verify against the chain.
    const version = ['1', '2'].find(
      (v) =>
        hashDomain({ domain: { name, version: v, chainId: BigInt(chainId), verifyingContract: asset }, types: { EIP712Domain: EIP712_DOMAIN } }).toLowerCase() ===
        separator.toLowerCase(),
    )
    if (!version) return undefined
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const signature = (await wc.signTypedData({
      account: wc.account,
      domain: { name, version, chainId, verifyingContract: asset },
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: { owner: account(), spender, value, nonce, deadline },
    })) as Hex
    const { v, r, s } = parseSignature(signature)
    return { deadline, v: Number(v), r, s }
  }

  // ---------------------------------------------------------------- checkout

  /** Amount of `asset` that pays the invoice now and the route: an Aqua maker strategy, the vault, or plain USDG. */
  const quote = async ({ merchant, invoiceId, asset }: { merchant: Address; invoiceId: Hex; asset: Address }) => {
    const [assetIn, priceUsd8, marketClosed, strategyHash] = (await read(addresses.gateway, norenGatewayAbi, 'quoteRoute', [
      merchant,
      invoiceId,
      asset,
    ])) as [bigint, bigint, boolean, Hex]
    const viaMaker = BigInt(strategyHash) !== 0n
    const route = asset.toLowerCase() === addresses.usdg.toLowerCase() ? 'usdg' : viaMaker ? 'aqua-maker' : 'vault'
    return { assetIn, priceUsd8, marketClosed, route: route as 'usdg' | 'aqua-maker' | 'vault', strategyHash: viaMaker ? strategyHash : null }
  }

  const createInvoice = async ({ invoiceId, amountUsdg, expiry }: { invoiceId: Hex; amountUsdg: bigint; expiry: bigint | number }) =>
    confirm(await write(addresses.gateway, norenGatewayAbi, 'createInvoice', [invoiceId, amountUsdg, BigInt(expiry)]))

  /** Pay an invoice with USDG, a Stock Token (EIP-2612 permit, approve fallback) or native ETH. */
  const pay = async ({ merchant, invoiceId, asset, slippageBps = 50 }: { merchant: Address; invoiceId: Hex; asset: Address; slippageBps?: number }) => {
    const q = await quote({ merchant, invoiceId, asset })
    const max = (q.assetIn * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n
    let hash: Hex
    let paymentMethod: PaymentMethod
    if (asset === NATIVE_ETH) {
      paymentMethod = 'native'
      hash = await write(addresses.gateway, norenGatewayAbi, 'pay', [invoiceId, merchant, asset, max], max)
    } else {
      const p = await signPermit(asset, addresses.gateway, max)
      if (p) {
        paymentMethod = 'permit'
        hash = await write(addresses.gateway, norenGatewayAbi, 'payWithPermit', [invoiceId, merchant, asset, max, p.deadline, p.v, p.r, p.s])
      } else {
        paymentMethod = 'approve'
        await approve(asset, addresses.gateway, max)
        hash = await write(addresses.gateway, norenGatewayAbi, 'pay', [invoiceId, merchant, asset, max])
      }
    }
    const receipt = await confirm(hash)
    const invoicePaid = eventArgs(receipt, norenGatewayAbi, 'InvoicePaid')
    let makerFill: { strategyHash: Hex; maker: Address; assetIn: bigint; usdgOut: bigint; feeUsdg: bigint } | null = null
    try {
      makerFill = eventArgs(receipt, norenLiquidityAbi, 'MakerFill')
    } catch {
      // vault or USDG route
    }
    return { hash, paymentMethod, quote: q, invoicePaid, makerFill }
  }

  // ---------------------------------------------------------------- credit

  const applyAttestation = async ({ attestation, signature }: { attestation: Attestation; signature: Hex }) =>
    confirm(await write(addresses.credit, norenCreditAbi, 'applyAttestation', [attestation, signature]))

  const creditTerms = async (borrower: Address) => {
    const [tier, limitUsdg, ratioBps, availableUsdg] = (await read(addresses.credit, norenCreditAbi, 'creditTerms', [borrower])) as [
      number,
      bigint,
      number,
      bigint,
    ]
    return { tier: Number(tier), limitUsdg, ratioBps: Number(ratioBps), availableUsdg }
  }

  /** Pay in 3. collateral = NATIVE_ETH locks ETH (sent as value, held as WETH). */
  const openPlan = async ({ invoiceId, merchant, collateral, collateralAmount }: { invoiceId: Hex; merchant: Address; collateral: Address; collateralAmount: bigint }) => {
    const native = collateral === NATIVE_ETH
    if (!native) await approve(collateral, addresses.credit, collateralAmount)
    const hash = await write(addresses.credit, norenCreditAbi, 'openPlan', [invoiceId, merchant, collateral, collateralAmount], native ? collateralAmount : undefined)
    const args = eventArgs(await confirm(hash), norenCreditAbi, 'PlanOpened')
    return { hash, planId: args.planId as bigint, principalUsdg: args.principalUsdg as bigint }
  }

  const repay = async ({ planId, count }: { planId: bigint; count: number }) => {
    const plan = (await read(addresses.credit, norenCreditAbi, 'plan', [planId])) as Plan
    let amount = 0n
    for (let n = Number(plan.paid) + 1; n <= Number(plan.paid) + count; n++) {
      amount += (await read(addresses.credit, norenCreditAbi, 'installmentAmount', [planId, n])) as bigint
    }
    const p = await signPermit(addresses.usdg, addresses.credit, amount)
    let hash: Hex
    if (p) {
      hash = await write(addresses.credit, norenCreditAbi, 'repayWithPermit', [planId, count, amount, p.deadline, p.v, p.r, p.s])
    } else {
      await approve(addresses.usdg, addresses.credit, amount)
      hash = await write(addresses.credit, norenCreditAbi, 'repay', [planId, count])
    }
    await confirm(hash)
    return { hash, amountUsdg: amount, paymentMethod: (p ? 'permit' : 'approve') as PaymentMethod }
  }

  /** Lock collateral for a USDC line on Arc; the CRE bridge carries CreditLineOpened to Arc. */
  const openCreditLine = async ({
    collateral,
    collateralAmount,
    limitUsdc6,
    expiry,
  }: {
    collateral: Address
    collateralAmount: bigint
    limitUsdc6: bigint
    expiry: bigint | number
  }) => {
    const native = collateral === NATIVE_ETH
    if (!native) await approve(collateral, addresses.credit, collateralAmount)
    const hash = await write(
      addresses.credit,
      norenCreditAbi,
      'openCreditLine',
      [collateral, collateralAmount, limitUsdc6, BigInt(expiry)],
      native ? collateralAmount : undefined,
    )
    const args = eventArgs(await confirm(hash), norenCreditAbi, 'CreditLineOpened')
    return { hash, lineId: args.lineId as Hex, collateralValueUsd8: args.collateralValueUsd8 as bigint }
  }

  /** First call stops the line; collateral returns once an Arc report after the close shows it repaid. */
  const closeCreditLine = async (lineId: Hex) => confirm(await write(addresses.credit, norenCreditAbi, 'closeCreditLine', [lineId]))

  const liquidatePlan = async (planId: bigint) => {
    const plan = (await read(addresses.credit, norenCreditAbi, 'plan', [planId])) as Plan
    await approve(addresses.usdg, addresses.credit, plan.principal - plan.repaid)
    return confirm(await write(addresses.credit, norenCreditAbi, 'liquidatePlan', [planId]))
  }

  const liquidateLine = async (lineId: Hex) => {
    const outstanding = (await read(addresses.credit, norenCreditAbi, 'lineOutstanding', [lineId])) as bigint
    const usdg = (await read(addresses.oracle, norenAssetOracleAbi, 'usd8ToUsdg', [outstanding * 100n, ROUND_UP])) as bigint
    await approve(addresses.usdg, addresses.credit, usdg)
    return confirm(await write(addresses.credit, norenCreditAbi, 'liquidateLine', [lineId]))
  }

  const readPositions = async (borrower: Address) => {
    const [terms, h, planIds, lineIds] = await Promise.all([
      creditTerms(borrower),
      read(addresses.credit, norenCreditAbi, 'history', [borrower]) as Promise<[number, number, number, number, number]>,
      read(addresses.credit, norenCreditAbi, 'plansOf', [borrower]) as Promise<bigint[]>,
      read(addresses.credit, norenCreditAbi, 'linesOf', [borrower]) as Promise<Hex[]>,
    ])
    const history = { onTime: Number(h[0]), late: Number(h[1]), completed: Number(h[2]), clean: Number(h[3]), defaults: Number(h[4]) }
    const plans = await Promise.all(
      planIds.map(async (planId) => {
        const [plan, [overdue, undercollateralised]] = (await Promise.all([
          read(addresses.credit, norenCreditAbi, 'plan', [planId]),
          read(addresses.credit, norenCreditAbi, 'planLiquidatable', [planId]),
        ])) as [Plan, [boolean, boolean]]
        const next = Number(plan.paid) + 1
        const open = next <= INSTALLMENTS && Number(plan.status) === 1
        return {
          planId,
          plan,
          nextDue: open ? ((await read(addresses.credit, norenCreditAbi, 'dueAt', [planId, next])) as bigint) : null,
          nextAmount: open ? ((await read(addresses.credit, norenCreditAbi, 'installmentAmount', [planId, next])) as bigint) : 0n,
          liquidatable: { overdue, undercollateralised },
          liquidation: open ? await liquidationInfo(planId) : null,
        }
      }),
    )
    const lines = await Promise.all(
      lineIds.map(async (lineId) => {
        const [line, outstanding, [pastDue, undercollateralised]] = (await Promise.all([
          read(addresses.credit, norenCreditAbi, 'line', [lineId]),
          read(addresses.credit, norenCreditAbi, 'lineOutstanding', [lineId]),
          read(addresses.credit, norenCreditAbi, 'lineLiquidatable', [lineId]),
        ])) as [Line, bigint, [boolean, boolean]]
        return { lineId, line, outstanding, liquidatable: { pastDue, undercollateralised } }
      }),
    )
    const claimable: Record<string, bigint> = {}
    const assets = new Set<Address>([...plans.map((x) => x.plan.collateral), ...lines.map((x) => x.line.collateral)])
    for (const asset of assets) claimable[asset] = (await read(addresses.credit, norenCreditAbi, 'claimable', [borrower, asset])) as bigint
    return { terms, history, plans, lines, claimable }
  }

  // ---------------------------------------------------------------- Pay in 3 and liquidation (Aqua)

  const creditParams = async () => {
    const p = (await read(addresses.credit, norenCreditAbi, 'params')) as readonly [number, number, number, number, number, number, number]
    return {
      installmentInterval: Number(p[0]),
      gracePeriod: Number(p[1]),
      liquidationThresholdBps: Number(p[2]),
      liquidationBonusBps: Number(p[3]),
      merchantFeeBps: Number(p[4]),
    }
  }

  const collateralFacts = async (asset: Address, amount: bigint) => {
    const [decimals, multiplier, price] = (await Promise.all([
      read(asset, erc20PermitAbi, 'decimals'),
      read(addresses.oracle, norenAssetOracleAbi, 'multiplier', [asset]),
      read(addresses.oracle, norenAssetOracleAbi, 'price', [asset]),
    ])) as [number, bigint, { usd8: bigint; marketClosed: boolean }]
    const shares = (amount * multiplier) / 10n ** 18n // shares (or ETH) with the token's decimals
    return { decimals: Number(decimals), multiplier, priceUsd8: price.usd8, marketClosed: price.marketClosed, shares }
  }

  /**
   * Pay-in-3 schedule and liquidation terms in the app's words: "Your 10 NVDA liquidates if
   * NVDA < $X or if you miss two payments". X uses the outstanding debt, the live Stock Token
   * uiMultiplier, the USDG/USD feed and NorenCredit's liquidation threshold, the same inputs as
   * NorenCredit.planLiquidatable.
   */
  const liquidationInfo = async (planId: bigint) => {
    const [plan, prm, missed, [overdue, undercollateralised]] = (await Promise.all([
      read(addresses.credit, norenCreditAbi, 'plan', [planId]),
      creditParams(),
      read(addresses.credit, norenCreditAbi, 'missedInstallments', [planId]),
      read(addresses.credit, norenCreditAbi, 'planLiquidatable', [planId]),
    ])) as [Plan, Awaited<ReturnType<typeof creditParams>>, number, [boolean, boolean]]
    const outstanding = plan.principal - plan.repaid
    const debtUsd8 = (await read(addresses.oracle, norenAssetOracleAbi, 'usdgToUsd8', [outstanding, ROUND_UP])) as bigint
    const c = await collateralFacts(plan.collateral, plan.collateralAmount)
    const liqPx = liquidationPriceUsd8({
      debtUsd8,
      thresholdBps: prm.liquidationThresholdBps,
      amount: plan.collateralAmount,
      multiplier: c.multiplier,
      decimals: c.decimals,
    })
    const schedule = await Promise.all(
      Array.from({ length: INSTALLMENTS }, async (_, i) => {
        const n = i + 1
        const [dueAt, amountUsdg] = (await Promise.all([
          read(addresses.credit, norenCreditAbi, 'dueAt', [planId, n]),
          read(addresses.credit, norenCreditAbi, 'installmentAmount', [planId, n]),
        ])) as [bigint, bigint]
        return { installment: n, dueAt, amountUsdg, paid: n <= Number(plan.paid), defaultsAfter: dueAt + BigInt(prm.gracePeriod) }
      }),
    )
    const remaining = Number(plan.status) === 1 ? INSTALLMENTS - Number(plan.paid) : 0
    const symbol = symbolOf(plan.collateral)
    const sharesText = formatUnitsTrim(c.shares, c.decimals, 4)
    return {
      planId,
      collateral: plan.collateral,
      symbol,
      shares: c.shares,
      sharesText,
      outstandingUsdg: outstanding,
      priceUsd8: c.priceUsd8,
      liquidationPriceUsd8: liqPx,
      bufferBps: c.priceUsd8 === 0n ? 0 : Number(((c.priceUsd8 - liqPx) * 10_000n) / c.priceUsd8),
      missedPayments: Number(missed),
      missedToDefault: MISSED_TO_DEFAULT,
      liquidatable: { overdue, undercollateralised },
      schedule,
      message: planLiquidationMessage({ sharesText, symbol, liquidationPriceUsd8: liqPx, remainingInstallments: remaining, missed: Number(missed) }),
    }
  }

  /** Arc credit line: the collateral price below which the line becomes liquidatable for its current Arc debt. */
  const lineLiquidationInfo = async (lineId: Hex) => {
    const [line, outstanding, prm] = (await Promise.all([
      read(addresses.credit, norenCreditAbi, 'line', [lineId]),
      read(addresses.credit, norenCreditAbi, 'lineOutstanding', [lineId]),
      creditParams(),
    ])) as [Line, bigint, Awaited<ReturnType<typeof creditParams>>]
    const c = await collateralFacts(line.collateral, line.collateralAmount)
    const debtUsd8 = outstanding * 100n // USDC valued at $1.00, as NorenCredit does
    const liqPx = liquidationPriceUsd8({ debtUsd8, thresholdBps: prm.liquidationThresholdBps, amount: line.collateralAmount, multiplier: c.multiplier, decimals: c.decimals })
    const symbol = symbolOf(line.collateral)
    const sharesText = formatUnitsTrim(c.shares, c.decimals, 4)
    return {
      lineId,
      symbol,
      sharesText,
      outstandingUsdc6: outstanding,
      priceUsd8: c.priceUsd8,
      liquidationPriceUsd8: liqPx,
      message:
        outstanding === 0n
          ? `Nothing drawn on Arc: your ${sharesText} ${symbol} cannot be liquidated`
          : `Your ${sharesText} ${symbol} liquidates if ${symbol} < ${usd(liqPx)} or if the Arc balance is unpaid ${Math.round(prm.gracePeriod / 3600)} h after the line expires`,
    }
  }

  const needLiquidity = (): Address => {
    if (!addresses.liquidity || !addresses.swapRouter) throw new Error('Setup required: addresses.liquidity and addresses.swapRouter (NorenLiquidity deployment)')
    return addresses.liquidity
  }

  /** Liquidate through Aqua makers: the caller pays nothing and keeps the bonus in collateral. */
  const liquidatePlanViaAqua = async (planId: bigint) => {
    needLiquidity()
    const r = await confirm(await write(addresses.credit, norenCreditAbi, 'liquidatePlanViaAqua', [planId]))
    return { receipt: r, liquidated: eventArgs(r, norenCreditAbi, 'PlanLiquidated'), sale: eventArgs(r, norenCreditAbi, 'CollateralSoldToMakers') }
  }

  const liquidateLineViaAqua = async (lineId: Hex) => {
    needLiquidity()
    const r = await confirm(await write(addresses.credit, norenCreditAbi, 'liquidateLineViaAqua', [lineId]))
    return { receipt: r, liquidated: eventArgs(r, norenCreditAbi, 'CreditLineLiquidated'), sale: eventArgs(r, norenCreditAbi, 'CollateralSoldToMakers') }
  }

  // ---------------------------------------------------------------- Aqua makers

  /** The canonical NorenOraclePeg Aqua order for `maker` and its strategy hash. */
  const buildMakerStrategy = async ({ maker, asset, terms }: { maker: Address; asset: Address; terms?: Partial<PegTerms> }) => {
    const t = defaultPegTerms(asset, terms)
    const [order, strategyHash] = (await read(needLiquidity(), norenLiquidityAbi, 'buildOrder', [maker, asset, t])) as [
      { maker: Address; traits: bigint; data: Hex },
      Hex,
    ]
    return { order, strategyHash, terms: t }
  }

  /**
   * Maker flow: approve Aqua once (USDG, and the asset so inventory can be resold), ship the strategy
   * with `usdgAmount` of virtual USDG (tokens stay in the maker's wallet) and register it with Noren.
   */
  const shipMakerStrategy = async ({ asset, usdgAmount, assetAmount = 0n, terms }: { asset: Address; usdgAmount: bigint; assetAmount?: bigint; terms?: Partial<PegTerms> }) => {
    const liquidity = needLiquidity()
    const aqua = addresses.aqua ?? AQUA
    const { order, strategyHash, terms: t } = await buildMakerStrategy({ maker: account(), asset, terms })
    const max = 2n ** 256n - 1n
    await approve(addresses.usdg, aqua, max)
    await approve(asset, aqua, max)
    const strategy = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], [order])
    const shipHash = await write(aqua, aquaAbi, 'ship', [addresses.swapRouter, strategy, [addresses.usdg, asset], [usdgAmount, assetAmount]])
    await confirm(shipHash)
    const registerHash = await write(liquidity, norenLiquidityAbi, 'register', [asset, t])
    await confirm(registerHash)
    return { strategyHash, shipHash, registerHash }
  }

  /** Withdraw a strategy's virtual balances on Aqua (no token moves) and drop it from Noren routing. */
  const dockMakerStrategy = async (strategyHash: Hex) => {
    const liquidity = needLiquidity()
    const s = (await read(liquidity, norenLiquidityAbi, 'strategy', [strategyHash])) as StrategyRecord
    const dockHash = await write(addresses.aqua ?? AQUA, aquaAbi, 'dock', [addresses.swapRouter, strategyHash, [addresses.usdg, s.asset]])
    await confirm(dockHash)
    const removeHash = await write(liquidity, norenLiquidityAbi, 'remove', [strategyHash])
    await confirm(removeHash)
    return { dockHash, removeHash }
  }

  /**
   * A maker's final positions: per strategy the Aqua virtual balances, fills, volume and spread fees
   * booked at the Chainlink price, plus the wallet balances that back them and the inventory value.
   */
  const makerPositions = async (maker: Address) => {
    const liquidity = needLiquidity()
    const hashes = (await read(liquidity, norenLiquidityAbi, 'strategiesOf', [maker])) as Hex[]
    const feesUsdg = (await read(liquidity, norenLiquidityAbi, 'makerFeesUsdg', [maker])) as bigint
    const walletUsdg = (await read(addresses.usdg, erc20PermitAbi, 'balanceOf', [maker])) as bigint
    const strategies = await Promise.all(
      hashes.map(async (strategyHash) => {
        const [s, [usdgBalance, assetBalance]] = (await Promise.all([
          read(liquidity, norenLiquidityAbi, 'strategy', [strategyHash]),
          read(liquidity, norenLiquidityAbi, 'balances', [strategyHash]),
        ])) as [StrategyRecord, [bigint, bigint]]
        const walletAsset = (await read(s.asset, erc20PermitAbi, 'balanceOf', [maker])) as bigint
        let inventoryUsd8: bigint | null = null
        try {
          inventoryUsd8 = (await read(addresses.oracle, norenAssetOracleAbi, 'valueUsd8', [s.asset, walletAsset])) as bigint
        } catch {
          // stale feed: shown as unknown rather than guessed
        }
        return {
          strategyHash,
          asset: s.asset,
          symbol: symbolOf(s.asset),
          active: s.active,
          bidSpreadBps: Number(s.bidSpreadBps),
          askSpreadBps: Number(s.askSpreadBps),
          fills: Number(s.fills),
          volumeUsdg: s.volumeUsdg,
          feesUsdg: s.feesUsdg,
          aquaUsdg: usdgBalance,
          aquaAsset: assetBalance,
          walletAsset,
          inventoryUsd8,
        }
      }),
    )
    return { maker, walletUsdg, feesUsdg, strategies }
  }

  /**
   * Best execution for selling `amountIn` of `asset`: the best Aqua maker quote (Chainlink-pegged)
   * next to the live Uniswap v4 pool (fee 0.3%, tick spacing 60, no hooks) and the Chainlink value.
   * Uniswap is quoted only; Noren routes to the maker. A v4 quote that cannot be read is null with a reason.
   */
  const bestExecution = async ({ asset, amountIn }: { asset: Address; amountIn: bigint }) => {
    const liquidity = needLiquidity()
    const [[strategyHash, makerUsdg], valueUsd8] = (await Promise.all([
      read(liquidity, norenLiquidityAbi, 'bestQuoteForAsset', [asset, amountIn]),
      read(addresses.oracle, norenAssetOracleAbi, 'valueUsd8', [asset, amountIn]),
    ])) as [[Hex, bigint], bigint]
    const chainlinkUsdg = (await read(addresses.oracle, norenAssetOracleAbi, 'usd8ToUsdg', [valueUsd8, 0])) as bigint
    let uniswapV4Usdg: bigint | null = null
    let uniswapV4Error: string | null = null
    try {
      const [c0, c1] = BigInt(addresses.usdg) < BigInt(asset) ? [addresses.usdg, asset] : [asset, addresses.usdg]
      const { result } = await pc.simulateContract({
        address: V4_QUOTER,
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: { currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: zeroAddress }, zeroForOne: c0 === asset, exactAmount: amountIn, hookData: '0x' }],
      })
      uniswapV4Usdg = (result as [bigint, bigint])[0]
    } catch (e) {
      uniswapV4Error = (e as Error).message.split('\n')[0]
    }
    const maker = BigInt(strategyHash) === 0n ? null : { strategyHash, usdgOut: makerUsdg }
    const winner = maker && (uniswapV4Usdg === null || makerUsdg >= uniswapV4Usdg) ? 'aqua-maker' : uniswapV4Usdg !== null ? 'uniswap-v4' : 'none'
    const bps = (x: bigint | null) => (x === null || chainlinkUsdg === 0n ? null : Number(((chainlinkUsdg - x) * 10_000n) / chainlinkUsdg))
    return { asset, amountIn, chainlinkUsdg, maker, makerDiscountBps: bps(maker ? makerUsdg : null), uniswapV4Usdg, uniswapV4DiscountBps: bps(uniswapV4Usdg), uniswapV4Error, winner }
  }

  // ---------------------------------------------------------------- vault

  const vaultDeposit = async (assets: bigint) => {
    await approve(addresses.usdg, addresses.vault, assets)
    return confirm(await write(addresses.vault, norenVaultAbi, 'deposit', [assets, account()]))
  }

  const vaultRedeem = async (shares: bigint) => confirm(await write(addresses.vault, norenVaultAbi, 'redeem', [shares, account(), account()]))

  const vaultStats = async () => {
    const names = ['totalAssets', 'idleUsdg', 'receivablesUsdg', 'inventoryUsdg', 'totalSupply'] as const
    const [totalAssets, idleUsdg, receivablesUsdg, inventoryUsdg, totalSupply] = (await Promise.all(
      names.map((n) => read(addresses.vault, norenVaultAbi, n)),
    )) as bigint[]
    // shares have 12 decimals (USDG 6 + 6 virtual-share offset); price in USDG (6 decimals) per 1e12 shares
    const sharePriceUsdg = totalSupply === 0n ? 1_000_000n : (totalAssets * 10n ** 12n) / totalSupply
    return { totalAssets, idleUsdg, receivablesUsdg, inventoryUsdg, totalSupply, sharePriceUsdg }
  }

  return {
    quote,
    createInvoice,
    pay,
    applyAttestation,
    creditTerms,
    openPlan,
    repay,
    openCreditLine,
    closeCreditLine,
    liquidatePlan,
    liquidateLine,
    liquidatePlanViaAqua,
    liquidateLineViaAqua,
    liquidationInfo,
    lineLiquidationInfo,
    buildMakerStrategy,
    shipMakerStrategy,
    dockMakerStrategy,
    makerPositions,
    bestExecution,
    readPositions,
    vaultDeposit,
    vaultRedeem,
    vaultStats,
  }
}

export { zeroAddress }
