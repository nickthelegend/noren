// Noren on Robinhood Chain: typed helpers for checkout, Pay in 4 and the Arc credit line.
import {
  decodeEventLog,
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
import { erc20PermitAbi, norenAssetOracleAbi, norenCreditAbi, norenGatewayAbi, norenVaultAbi } from './abi.js'
import { NATIVE_ETH, type NorenAddresses } from './addresses.js'

export * from './addresses.js'
export * from './abi.js'

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

  const quote = async ({ merchant, invoiceId, asset }: { merchant: Address; invoiceId: Hex; asset: Address }) => {
    const [assetIn, priceUsd8, marketClosed] = (await read(addresses.gateway, norenGatewayAbi, 'quote', [merchant, invoiceId, asset])) as [
      bigint,
      bigint,
      boolean,
    ]
    return { assetIn, priceUsd8, marketClosed }
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
    const invoicePaid = eventArgs(await confirm(hash), norenGatewayAbi, 'InvoicePaid')
    return { hash, paymentMethod, quote: q, invoicePaid }
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

  /** Pay in 4. collateral = NATIVE_ETH locks ETH (sent as value, held as WETH). */
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
        const open = next <= 4 && Number(plan.status) === 1
        return {
          planId,
          plan,
          nextDue: open ? ((await read(addresses.credit, norenCreditAbi, 'dueAt', [planId, next])) as bigint) : null,
          nextAmount: open ? ((await read(addresses.credit, norenCreditAbi, 'installmentAmount', [planId, next])) as bigint) : 0n,
          liquidatable: { overdue, undercollateralised },
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
    readPositions,
    vaultDeposit,
    vaultRedeem,
    vaultStats,
  }
}

export { zeroAddress }
