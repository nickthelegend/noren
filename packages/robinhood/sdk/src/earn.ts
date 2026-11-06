// Noren app: deposit and earn (per-asset vaults backing 1inch Aqua maker strategies), borrow USDG
// against deposit shares at a Chainlink-priced LTV, reputation milestones, World ID and credit limits.
// Every number comes from the contracts; APY is computed from realised fees and labelled as such.
import {
  createWalletClient,
  decodeEventLog,
  defineChain,
  hashTypedData,
  http,
  isHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { erc20PermitAbi, norenAssetOracleAbi, norenBorrowAbi, norenCreditAbi, norenDepositVaultAbi, norenLiquidityAbi, norenReputationAbi } from './abi.js'
import { NATIVE_ETH, WETH, type NorenAddresses } from './addresses.js'

const YEAR = 365n * 86_400n
const BPS = 10_000n
const MAX = 2n ** 256n - 1n
/** Anvil published dev key #7: the fork-only stand-in for the World ID server key (loopback 4663/46630 only). */
const FORK_WORLD_ID_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356' as Hex

export const VERIFIED_HUMAN_TYPES = {
  VerifiedHuman: [
    { name: 'account', type: 'address' },
    { name: 'nullifierHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const
export const ACCOUNT_AGE_TYPES = {
  AccountAge: [
    { name: 'account', type: 'address' },
    { name: 'firstSeenAt', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export const MILESTONES = [
  { bit: 1n << 0n, key: 'verifiedHuman', label: 'Verified human (World ID)', points: 50 },
  { bit: 1n << 1n, key: 'account30d', label: 'Account older than 30 days', points: 20 },
  { bit: 1n << 2n, key: 'account180d', label: 'Account older than 180 days', points: 20 },
  { bit: 1n << 3n, key: 'onTime3', label: 'Three on-time Pay-in-3 installments', points: 30 },
  { bit: 1n << 4n, key: 'firstLoanRepaid', label: 'First loan repaid', points: 25 },
  { bit: 1n << 5n, key: 'loansRepaid3', label: 'Three loans repaid', points: 75 },
  { bit: 1n << 6n, key: 'cleanRecord', label: 'No late payments or liquidations', points: 0 },
] as const

export type EarnAddresses = NorenAddresses & {
  reputation?: Address
  borrow?: Address
  depositVaults?: { asset: Address; vault: Address }[]
  worldIdSigner?: Address
}

const isLoopback = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)

/** World ID nullifiers arrive as decimal strings, hex strings or bigints; NorenReputation stores bytes32. */
export function nullifierToBytes32(n: string | bigint): Hex {
  const v = typeof n === 'bigint' ? n : isHex(n) ? BigInt(n) : BigInt(n.trim())
  if (v <= 0n || v >= 2n ** 256n) throw new Error('Invalid nullifier: must be a non-zero field element')
  return toHex(v, { size: 32 })
}

/**
 * Sign NorenReputation's EIP-712 `VerifiedHuman(account, nullifierHash, expiry)` with the World ID
 * server key. Call only after World's /api/v4/verify returned success for a proof bound to `account`.
 * Key: NOREN_WORLD_ATTESTER_KEY. Only on a loopback RPC whose chain id is 4663 or 46630 does it fall
 * back to Anvil's published key #7 (the fork's configured signer), and the result says so.
 * Checks before signing: signer == worldIdSigner(), local digest == hashVerifiedHuman(), the nullifier
 * is unused and the account is not yet verified (readable errors instead of a reverted transaction).
 */
export async function signVerifiedHuman({
  publicClient,
  reputation,
  account,
  nullifier,
  ttlSeconds = 600,
  key = process.env.NOREN_WORLD_ATTESTER_KEY as Hex | undefined,
}: {
  publicClient: PublicClient
  reputation: Address
  account: Address
  nullifier: string | bigint
  ttlSeconds?: number
  key?: Hex
}) {
  const url = (publicClient.transport as { url?: string }).url ?? ''
  const chainId = await publicClient.getChainId()
  const forkOnly = isLoopback(url) && (chainId === 4663 || chainId === 46630)
  if (!key && !forkOnly) throw new Error('Setup required: NOREN_WORLD_ATTESTER_KEY')
  const signer = privateKeyToAccount(key ?? FORK_WORLD_ID_KEY)
  const nullifierHash = nullifierToBytes32(nullifier)
  const read = (functionName: string, args: readonly unknown[] = []) =>
    (publicClient as any).readContract({ address: reputation, abi: norenReputationAbi, functionName, args })
  const [expected, holder, existing] = (await Promise.all([read('worldIdSigner'), read('humanOf', [nullifierHash]), read('nullifierOf', [account])])) as [Address, Address, Hex]
  if (expected.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`World ID attester ${signer.address} is not NorenReputation.worldIdSigner() ${expected}`)
  }
  if (holder !== '0x0000000000000000000000000000000000000000') {
    throw new Error(holder.toLowerCase() === account.toLowerCase() ? 'Already verified: this account is already a verified human' : 'Already used: this human is already verified on another account')
  }
  if (BigInt(existing) !== 0n) throw new Error('Already verified: this account already has a World ID nullifier')
  const now = (await publicClient.getBlock()).timestamp
  const expiry = now + BigInt(ttlSeconds)
  const domain = { name: 'NorenReputation', version: '1', chainId, verifyingContract: reputation } as const
  const message = { account, nullifierHash, expiry }
  const local = hashTypedData({ domain, types: VERIFIED_HUMAN_TYPES, primaryType: 'VerifiedHuman', message })
  const onChain = (await read('hashVerifiedHuman', [account, nullifierHash, expiry])) as Hex
  if (local.toLowerCase() !== onChain.toLowerCase()) throw new Error('VerifiedHuman hash mismatch with NorenReputation')
  const signature = await signer.signTypedData({ domain, types: VERIFIED_HUMAN_TYPES, primaryType: 'VerifiedHuman', message })
  return { account, nullifierHash, expiry, signature, signer: key ? signer.address : 'anvil-dev-key #7 (fork only)', chainId, reputation }
}

/**
 * The World ID handler calls this right after a successful verification: signs the attestation,
 * relays `verifyHuman` (gas paid by `relayer`, default the attester account) and returns the new
 * reputation, milestones and credit limit, which apply immediately.
 */
export async function recordVerifiedHuman({
  publicClient,
  addresses,
  account,
  nullifier,
  relayer,
  key,
}: {
  publicClient: PublicClient
  addresses: EarnAddresses
  account: Address
  nullifier: string | bigint
  relayer?: WalletClient
  key?: Hex
}) {
  if (!addresses.reputation) throw new Error('Setup required: addresses.reputation (NorenReputation deployment)')
  const signed = await signVerifiedHuman({ publicClient, reputation: addresses.reputation, account, nullifier, key })
  const before = await createNorenEarn({ publicClient, addresses }).creditLimit(account)
  const url = (publicClient.transport as { url?: string }).url ?? addresses.rpcUrl ?? ''
  const attesterKey = key ?? (process.env.NOREN_WORLD_ATTESTER_KEY as Hex | undefined) ?? FORK_WORLD_ID_KEY
  const wallet = relayer ?? createWalletClient({ account: privateKeyToAccount(attesterKey), transport: http(url) })
  const earn = createNorenEarn({ publicClient, walletClient: wallet, addresses })
  const tx = await earn.applyVerifiedHuman(signed)
  const after = await earn.creditLimit(account)
  return { tx, signed, before, after, reputation: await earn.reputation(account), milestones: await earn.milestones(account) }
}

export function createNorenEarn({
  publicClient,
  walletClient,
  addresses,
}: {
  publicClient: PublicClient
  walletClient?: WalletClient
  addresses: EarnAddresses
}) {
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
    account()
    const chain =
      wc.chain ??
      defineChain({
        id: await pc.getChainId(),
        name: 'Robinhood Chain',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [addresses.rpcUrl ?? 'http://127.0.0.1:8720'] } },
      })
    return wc.writeContract({ address, abi, functionName, args, account: wc.account, chain, ...(value === undefined ? {} : { value }) })
  }
  const confirm = async (hash: Hex): Promise<TransactionReceipt> => {
    const r = (await pc.waitForTransactionReceipt({ hash })) as TransactionReceipt
    if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
    return r
  }
  const events = (r: TransactionReceipt, abi: Abi, eventName: string): any[] => {
    const out: any[] = []
    for (const log of r.logs) {
      try {
        const d = decodeEventLog({ abi, data: log.data, topics: log.topics }) as { eventName: string; args: unknown }
        if (d.eventName === eventName) out.push(d.args)
      } catch {}
    }
    return out
  }
  const approve = async (token: Address, spender: Address, amount: bigint) => {
    const allowed = (await read(token, erc20PermitAbi, 'allowance', [account(), spender])) as bigint
    if (allowed >= amount) return undefined
    const h = await write(token, erc20PermitAbi, 'approve', [spender, amount])
    await confirm(h)
    return h
  }
  const borrowAddr = (): Address => {
    if (!addresses.borrow) throw new Error('Setup required: addresses.borrow (NorenBorrow deployment)')
    return addresses.borrow
  }
  const repAddr = (): Address => {
    if (!addresses.reputation) throw new Error('Setup required: addresses.reputation (NorenReputation deployment)')
    return addresses.reputation
  }
  const liqAddr = (): Address => {
    if (!addresses.liquidity) throw new Error('Setup required: addresses.liquidity (NorenLiquidity deployment)')
    return addresses.liquidity
  }

  /** Deposit vault for an asset (NATIVE_ETH and WETH map to nETH). */
  const vaultFor = (asset: Address): Address => {
    const a = (asset === NATIVE_ETH ? WETH : asset).toLowerCase()
    const v = addresses.depositVaults?.find((x) => x.asset.toLowerCase() === a)
    if (!v) throw new Error(`No Noren deposit vault for ${asset}`)
    return v.vault
  }

  const vaults = async () =>
    Promise.all(
      (addresses.depositVaults ?? []).map(async ({ asset, vault }) => {
        const [name, symbol, decimals, assetSymbol, assetDecimals] = (await Promise.all([
          read(vault, norenDepositVaultAbi, 'name'),
          read(vault, norenDepositVaultAbi, 'symbol'),
          read(vault, norenDepositVaultAbi, 'decimals'),
          read(asset, erc20PermitAbi, 'symbol'),
          read(asset, erc20PermitAbi, 'decimals'),
        ])) as [string, string, number, string, number]
        return { asset, vault, name, symbol, decimals, assetSymbol: asset.toLowerCase() === WETH.toLowerCase() ? 'ETH' : assetSymbol, assetDecimals }
      }),
    )

  // ---------------------------------------------------------------- deposit and earn

  /** Deposit `amount` raw units of `asset` (NATIVE_ETH sends ETH, wrapped by the vault). Returns the shares minted. */
  const deposit = async ({ asset, amount }: { asset: Address; amount: bigint }) => {
    const vault = vaultFor(asset)
    const me = account()
    let hash: Hex
    if (asset === NATIVE_ETH) hash = await write(vault, norenDepositVaultAbi, 'depositETH', [me], amount)
    else {
      await approve(asset, vault, amount)
      hash = await write(vault, norenDepositVaultAbi, 'deposit', [amount, me])
    }
    const receipt = await confirm(hash)
    const ev = events(receipt, norenDepositVaultAbi, 'Deposit')[0]
    return { receipt, hash, vault, shares: ev.shares as bigint, assets: ev.assets as bigint }
  }

  /**
   * Withdraw from a deposit vault. Pass `amount` (raw asset units) or `shares` (all when neither).
   * When the vault holds less of the asset than requested (it sold some to buyers and holds USDG
   * until it buys back), this throws "Liquidity in use" with the amounts, unless `inKind` is set:
   * then the shares redeem for their pro-rata asset and USDG. `asEth` unwraps nETH to native ETH.
   */
  const withdraw = async ({ asset, amount, shares, inKind = false, asEth = false }: { asset: Address; amount?: bigint; shares?: bigint; inKind?: boolean; asEth?: boolean }) => {
    const vault = vaultFor(asset)
    const me = account()
    const owned = (await read(vault, norenDepositVaultAbi, 'balanceOf', [me])) as bigint
    const s = shares ?? (amount === undefined ? owned : ((await read(vault, norenDepositVaultAbi, 'previewWithdraw', [amount])) as bigint))
    if (s === 0n) throw new Error('Nothing to withdraw')
    if (s > owned) throw new Error(`Not enough deposit shares: ${owned} held`)
    if (inKind) {
      const r = await confirm(await write(vault, norenDepositVaultAbi, 'redeemInKind', [s, me, me]))
      const ev = events(r, norenDepositVaultAbi, 'RedeemedInKind')[0]
      return { receipt: r, vault, shares: s, assets: ev.assets as bigint, usdg: ev.usdgOut as bigint, inKind: true }
    }
    const want = amount ?? ((await read(vault, norenDepositVaultAbi, 'previewRedeem', [s])) as bigint)
    const [held, usdgHeld] = (await Promise.all([read(asset === NATIVE_ETH ? WETH : asset, erc20PermitAbi, 'balanceOf', [vault]), read(addresses.usdg, erc20PermitAbi, 'balanceOf', [vault])])) as [bigint, bigint]
    if (want > held) {
      throw new Error(`Liquidity in use: ${want} requested, ${held} of the asset available now; the vault holds ${usdgHeld} USDG (6 dp) from sales until it buys back. Withdraw up to ${held}, or withdraw in kind (asset + USDG).`)
    }
    let hash: Hex
    if (asEth) hash = await write(vault, norenDepositVaultAbi, 'redeemETH', [s, me, me])
    else if (amount !== undefined) hash = await write(vault, norenDepositVaultAbi, 'withdraw', [amount, me, me])
    else hash = await write(vault, norenDepositVaultAbi, 'redeem', [s, me, me])
    const r = await confirm(hash)
    const ev = events(r, norenDepositVaultAbi, 'Withdraw')[0]
    return { receipt: r, vault, shares: ev.shares as bigint, assets: ev.assets as bigint, usdg: 0n, inKind: false }
  }

  /**
   * Vault facts for the app: balances, NAV, realised fees from NorenLiquidity's fee book, and the APY
   * those fees imply over the observed window (first deposit to now). Not a forecast.
   */
  const vaultStats = async (asset: Address) => {
    const vault = vaultFor(asset)
    const st = (await read(vault, norenDepositVaultAbi, 'stats')) as {
      assetBalance: bigint
      usdgBalance: bigint
      totalAssets: bigint
      totalSupply: bigint
      assetsPerShare: bigint
      navUsd8: bigint
      feesUsdg: bigint
      fills: bigint
      volumeUsdg: bigint
      firstDepositAt: bigint
      strategyHash: Hex
      priced: boolean
    }
    const now = (await pc.getBlock()).timestamp as bigint
    const window = st.firstDepositAt === 0n ? 0n : now - st.firstDepositAt
    let usdgPx = 0n
    try {
      usdgPx = (await read(addresses.oracle, norenAssetOracleAbi, 'usdgPrice')) as bigint
    } catch {}
    const feesUsd8 = usdgPx === 0n ? 0n : (st.feesUsdg * usdgPx) / 1_000_000n
    // APY in bps = fees / NAV x (year / window). Simple (not compounded).
    const apyBps = st.priced && st.navUsd8 > 0n && window > 0n ? (feesUsd8 * BPS * YEAR) / (st.navUsd8 * window) : null
    const hours = Number(window) / 3600
    return {
      vault,
      ...st,
      feesUsd8,
      windowSeconds: window,
      realisedApyBps: apyBps,
      apyLabel:
        apyBps === null
          ? st.priced
            ? 'No realised fees or deposits yet'
            : 'A price feed is stale: NAV is unavailable (in-kind withdrawals still work)'
          : `Realised: ${Number(st.feesUsdg) / 1e6} USDG of maker fees from ${st.fills} fills over ${hours.toFixed(1)} h, annualised (simple). Not a forecast.`,
    }
  }

  /** What `amount` would have earned over the observed window at the realised fee rate (and per `days` at that rate). */
  const previewYield = async ({ asset, amount, days = 30 }: { asset: Address; amount: bigint; days?: number }) => {
    const vault = vaultFor(asset)
    const [stats, shares] = await Promise.all([vaultStats(asset), read(vault, norenDepositVaultAbi, 'previewDeposit', [amount]) as Promise<bigint>])
    const ratePerYearBps = stats.realisedApyBps
    const projected = ratePerYearBps === null ? null : (amount * ratePerYearBps * BigInt(Math.round(days * 86_400))) / (BPS * YEAR)
    return {
      shares,
      realisedApyBps: ratePerYearBps,
      projectedAssetGain: projected,
      days,
      label:
        projected === null
          ? stats.apyLabel
          : `If the realised fee rate of the last ${(Number(stats.windowSeconds) / 3600).toFixed(1)} h continued for ${days} days. Fees depend on fills; this is not a promise.`,
    }
  }

  // ---------------------------------------------------------------- borrow

  const lock = async ({ asset, shares }: { asset: Address; shares?: bigint }) => {
    const vault = vaultFor(asset)
    const s = shares ?? ((await read(vault, norenDepositVaultAbi, 'balanceOf', [account()])) as bigint)
    await approve(vault, borrowAddr(), s)
    const r = await confirm(await write(borrowAddr(), norenBorrowAbi, 'lock', [vault, s]))
    return { receipt: r, vault, shares: s }
  }

  const unlock = async ({ asset, shares }: { asset: Address; shares?: bigint }) => {
    const vault = vaultFor(asset)
    const s = shares ?? ((await read(borrowAddr(), norenBorrowAbi, 'lockedShares', [account(), vault])) as bigint)
    const r = await confirm(await write(borrowAddr(), norenBorrowAbi, 'unlock', [vault, s, account()]))
    return { receipt: r, vault, shares: s }
  }

  /** Borrow USDG from the lender pool (optionally locking deposit shares first). */
  const borrow = async ({ amountUsdg, lockShares }: { amountUsdg: bigint; lockShares?: { asset: Address; shares?: bigint } }) => {
    if (lockShares) await lock(lockShares)
    const limit = (await read(borrowAddr(), norenBorrowAbi, 'borrowLimitUsdg', [account()])) as bigint
    const debt = (await read(borrowAddr(), norenBorrowAbi, 'debtOf', [account()])) as bigint
    if (debt + amountUsdg > limit) throw new Error(`Over the borrow limit: debt would be ${debt + amountUsdg}, limit ${limit} USDG (6 dp)`)
    const r = await confirm(await write(borrowAddr(), norenBorrowAbi, 'borrow', [amountUsdg, account()]))
    return { receipt: r, borrowed: events(r, norenBorrowAbi, 'Borrowed')[0] }
  }

  /** Repay `amountUsdg`, or everything with 'all' (interest accrues per second, so the exact debt is settled in the tx). */
  const repay = async ({ amountUsdg, onBehalfOf }: { amountUsdg: bigint | 'all'; onBehalfOf?: Address }) => {
    const who = onBehalfOf ?? account()
    const debt = (await read(borrowAddr(), norenBorrowAbi, 'debtOf', [who])) as bigint
    if (debt === 0n) throw new Error('No debt to repay')
    const pay = amountUsdg === 'all' ? debt + debt / 10_000n + 1n : amountUsdg
    await approve(addresses.usdg, borrowAddr(), pay)
    const r = await confirm(await write(borrowAddr(), norenBorrowAbi, 'repay', [who, amountUsdg === 'all' ? MAX : amountUsdg]))
    return { receipt: r, repaid: events(r, norenBorrowAbi, 'Repaid')[0], loanClosed: events(r, norenBorrowAbi, 'LoanRepaid')[0] }
  }

  /** Debt, collateral, limit, LTV and health factor (1.0 = liquidation). */
  const health = async (who: Address) => {
    const b = borrowAddr()
    const [debt, valueUsd8, riskUsd8, limit, ltvBps, hf, liqLtv, rate] = (await Promise.all([
      read(b, norenBorrowAbi, 'debtOf', [who]),
      read(b, norenBorrowAbi, 'collateralValueUsd8', [who, false]),
      read(b, norenBorrowAbi, 'collateralValueUsd8', [who, true]),
      read(b, norenBorrowAbi, 'borrowLimitUsdg', [who]),
      read(b, norenBorrowAbi, 'ltvOf', [who]),
      read(b, norenBorrowAbi, 'healthFactor', [who]),
      read(b, norenBorrowAbi, 'liquidationLtvBps'),
      read(b, norenBorrowAbi, 'borrowRateBps'),
    ])) as [bigint, bigint, bigint, bigint, number, bigint, number, number]
    const locked = await Promise.all(
      (addresses.depositVaults ?? []).map(async ({ asset, vault }) => ({ asset, vault, shares: (await read(b, norenBorrowAbi, 'lockedShares', [who, vault])) as bigint })),
    )
    return {
      debtUsdg: debt,
      collateralUsd8: valueUsd8,
      collateralRiskUsd8: riskUsd8,
      borrowLimitUsdg: limit,
      availableUsdg: limit > debt ? limit - debt : 0n,
      ltvBps,
      liquidationLtvBps: liqLtv,
      borrowRateBps: rate,
      healthFactor: hf === MAX ? Infinity : Number(hf) / 1e18,
      healthFactorRaw: hf,
      locked: locked.filter((l) => l.shares > 0n),
    }
  }

  /** The asset price at which the position becomes liquidatable, and the app sentence. */
  const liquidationPrice = async (who: Address, asset: Address) => {
    const vault = vaultFor(asset)
    const a = asset === NATIVE_ETH ? WETH : asset
    const [px, shares, price] = (await Promise.all([
      read(borrowAddr(), norenBorrowAbi, 'liquidationPriceUsd8', [who, vault]),
      read(borrowAddr(), norenBorrowAbi, 'lockedShares', [who, vault]),
      read(addresses.oracle, norenAssetOracleAbi, 'price', [a]),
    ])) as [bigint, bigint, { usd8: bigint }]
    const [assetsLocked] = (await read(vault, norenDepositVaultAbi, 'inKind', [shares])) as [bigint, bigint]
    const symbol = a.toLowerCase() === WETH.toLowerCase() ? 'ETH' : ((await read(a, erc20PermitAbi, 'symbol')) as string)
    const decimals = (await read(a, erc20PermitAbi, 'decimals')) as number
    const usd = (v: bigint) => `$${(Number(v) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const amt = (Number(assetsLocked) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 4 })
    return {
      liquidationPriceUsd8: px,
      priceUsd8: price.usd8,
      bufferBps: px === 0n ? null : Number(((price.usd8 - px) * BPS) / price.usd8),
      message: px === 0n ? 'No debt against this deposit' : `Your ${amt} ${symbol} deposit is liquidated if ${symbol} < ${usd(px)} (now ${usd(price.usd8)})`,
    }
  }

  const liquidateLoanViaAqua = async ({ borrower, asset }: { borrower: Address; asset: Address }) => {
    const r = await confirm(await write(borrowAddr(), norenBorrowAbi, 'liquidateViaAqua', [borrower, vaultFor(asset)]))
    return { receipt: r, liquidated: events(r, norenBorrowAbi, 'LoanLiquidated')[0] }
  }

  /** Buy an asset from Noren makers (deposit vaults and independent makers) at Chainlink + ask. */
  const buyAsset = async ({ asset, amountOut, slippageBps = 50 }: { asset: Address; amountOut: bigint; slippageBps?: number }) => {
    const [, usdgIn] = (await read(liqAddr(), norenLiquidityAbi, 'bestAskForAsset', [asset, amountOut])) as [Hex, bigint]
    if (usdgIn === 0n) throw new Error('No maker can sell that amount right now')
    const max = (usdgIn * (BPS + BigInt(slippageBps))) / BPS
    await approve(addresses.usdg, liqAddr(), max)
    const r = await confirm(await write(liqAddr(), norenLiquidityAbi, 'buyFromMakers', [asset, amountOut, max, account()]))
    return { receipt: r, sale: events(r, norenLiquidityAbi, 'MakerSale')[0] }
  }

  // ---------------------------------------------------------------- reputation and credit

  const reputation = async (who: Address) => {
    const b = (await read(repAddr(), norenReputationAbi, 'breakdownOf', [who])) as {
      onTime: number
      late: number
      repaidLoans: number
      liquidations: number
      firstSeenAt: bigint
      ageDays: bigint
      verifiedHuman: boolean
      points: bigint
      milestones: bigint
      tier: number
      ltvBps: number
      limitMultiplierBps: number
    }
    const next = b.tier < 3 ? ((await read(repAddr(), norenReputationAbi, 'tierTable', [b.tier + 1])) as { ltvBps: number; minPoints: number; needsHuman: boolean; needsRepayment: boolean }) : null
    return {
      ...b,
      nextTier: next && {
        tier: b.tier + 1,
        ltvBps: next.ltvBps,
        pointsNeeded: Math.max(0, next.minPoints - Number(b.points)),
        needsWorldId: next.needsHuman && !b.verifiedHuman,
        needsRepayment: next.needsRepayment,
      },
    }
  }

  const milestones = async (who: Address) => {
    const mask = (await read(repAddr(), norenReputationAbi, 'milestonesOf', [who])) as bigint
    return MILESTONES.map((m) => ({ key: m.key, label: m.label, achieved: (mask & m.bit) !== 0n }))
  }

  /**
   * Credit limit: deposits x tier LTV (USDG from the lender pool) + the World ID starter line (USDC on
   * Arc, opened by the World ID server through the CRE bridge), plus the Pay-in-3 terms on NorenCredit
   * and the multiplier the underwriter applies to them at the next attestation.
   */
  const creditLimit = async (who: Address) => {
    const [[total, secured, starter], ltvBps, mult, terms] = (await Promise.all([
      read(repAddr(), norenReputationAbi, 'creditLimitOf', [who]),
      read(repAddr(), norenReputationAbi, 'ltvOf', [who]),
      read(repAddr(), norenReputationAbi, 'limitMultiplierOf', [who]),
      read(addresses.credit, norenCreditAbi, 'creditTerms', [who]),
    ])) as [[bigint, bigint, bigint], number, number, [number, bigint, number, bigint]]
    return {
      totalUsd6: total,
      securedUsdg: secured,
      starterUsdc6: starter,
      ltvBps,
      limitMultiplierBps: mult,
      payIn3: { tier: terms[0], limitUsdg: terms[1], collateralRatioBps: terms[2], availableUsdg: terms[3] },
    }
  }

  const applyVerifiedHuman = async (s: { account: Address; nullifierHash: Hex; expiry: bigint; signature: Hex }) => {
    const r = await confirm(await write(repAddr(), norenReputationAbi, 'verifyHuman', [s.account, s.nullifierHash, s.expiry, s.signature]))
    return { receipt: r, hash: r.transactionHash }
  }

  const applyAccountAge = async (s: { account: Address; firstSeenAt: bigint; expiry: bigint; signature: Hex }) => {
    const r = await confirm(await write(repAddr(), norenReputationAbi, 'recordAccountAge', [s.account, s.firstSeenAt, s.expiry, s.signature]))
    return { receipt: r, hash: r.transactionHash }
  }

  return {
    vaults,
    vaultFor,
    deposit,
    withdraw,
    previewYield,
    vaultStats,
    lock,
    unlock,
    borrow,
    repay,
    health,
    liquidationPrice,
    liquidateLoanViaAqua,
    buyAsset,
    reputation,
    milestones,
    creditLimit,
    applyVerifiedHuman,
    applyAccountAge,
  }
}
