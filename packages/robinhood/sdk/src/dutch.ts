// Partial Dutch-auction liquidations of Pay-in-3 plans (NorenDutchAuction) for integrators:
// auctionStatus, previewPartialLiquidation, fillPartialLiquidation, plus open/close and the maker
// side (build, ship and register a NorenDutchDecay + NorenOraclePeg strategy on 1inch Aqua).
import {
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem'
import { aquaAbi, erc20PermitAbi, norenDutchAuctionAbi } from './abi.js'
import { AQUA, formatUnitsTrim, symbolOf } from './aqua.js'
import type { NorenAddresses } from './addresses.js'

const WAD = 10n ** 18n
const MAX = 2n ** 256n - 1n

export type DutchAuctionStatus = {
  planId: bigint
  open: boolean
  startedAt: bigint
  elapsedSeconds: bigint
  /** Total discount now (1e18 = 100%): the borrower's cost per unit of collateral value sold. */
  discountWad: bigint
  makerDiscountWad: bigint
  keeperDiscountWad: bigint
  /** Collateral value / (debt x liquidation threshold); below 1e18 the plan is liquidatable. */
  healthWad: bigint
  targetHealthWad: bigint
  overdue: boolean
  liquidatable: boolean
  round: number
  fills: number
  collateral: Address
  collateralAmount: bigint
  outstandingUsdg: bigint
  priceUsd8: bigint
  /** Why health could not be read (stale feed, paused token); empty when fine. */
  error: string
  /** Schedule: start, cap, duration and the keeper's share of the discount. */
  schedule: { startBps: number; capBps: number; durationSeconds: number; keeperShareBps: number; targetHealthBps: number }
  message: string
}

export type PartialLiquidationPreview = {
  strategyHash: Hex
  sellAll: boolean
  usdgOut: bigint
  repayUsdg: bigint
  excessUsdg: bigint
  collateralSold: bigint
  keeperBonus: bigint
  discountWad: bigint
  closesPlan: boolean
  badDebtUsdg: bigint
  healthAfterWad: bigint
  collateralLeft: bigint
  outstandingAfterUsdg: bigint
}

const pct = (wad: bigint, digits = 2) => `${formatUnitsTrim(wad * 100n, 18, digits)}%`
const health = (wad: bigint) => (wad === MAX ? 'n/a' : formatUnitsTrim(wad, 18, 4))

export function createNorenDutch({
  publicClient,
  walletClient,
  addresses,
}: {
  publicClient: PublicClient
  walletClient?: WalletClient
  addresses: NorenAddresses
}) {
  const pc = publicClient as any
  const wc = walletClient as any
  const house = (): Address => {
    if (!addresses.dutchAuction) throw new Error('Setup required: addresses.dutchAuction (deploy NorenDutchAuction with the opcode-35 router)')
    return addresses.dutchAuction
  }
  const account = (): Address => {
    const a = wc?.account?.address as Address | undefined
    if (!a) throw new Error('Setup required: a walletClient with an account')
    return a
  }
  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<any> =>
    pc.readContract({ address, abi, functionName, args, account: wc?.account })
  const write = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<Hex> => {
    account()
    const chain =
      wc.chain ??
      defineChain({
        id: await pc.getChainId(),
        name: 'Robinhood Chain',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [addresses.rpcUrl ?? 'http://127.0.0.1:8720'] } },
      })
    return wc.writeContract({ address, abi, functionName, args, account: wc.account, chain })
  }
  const confirm = async (hash: Hex): Promise<TransactionReceipt> => {
    const r = (await pc.waitForTransactionReceipt({ hash })) as TransactionReceipt
    if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
    return r
  }
  const events = (r: TransactionReceipt, eventName: string): any[] => {
    const out: any[] = []
    for (const log of r.logs) {
      if (log.address.toLowerCase() !== house().toLowerCase()) continue
      try {
        const d = decodeEventLog({ abi: norenDutchAuctionAbi as Abi, data: log.data, topics: log.topics }) as { eventName: string; args: unknown }
        if (d.eventName === eventName) out.push(d.args)
      } catch {
        // not one of the house's events
      }
    }
    return out
  }

  const schedule = async () => {
    const [startBps, capBps, durationSeconds, keeperShareBps, targetHealthBps] = (await Promise.all([
      read(house(), norenDutchAuctionAbi as Abi, 'startDiscountBps'),
      read(house(), norenDutchAuctionAbi as Abi, 'capDiscountBps'),
      read(house(), norenDutchAuctionAbi as Abi, 'duration'),
      read(house(), norenDutchAuctionAbi as Abi, 'keeperShareBps'),
      read(house(), norenDutchAuctionAbi as Abi, 'targetHealthBps'),
    ])) as number[]
    return { startBps: Number(startBps), capBps: Number(capBps), durationSeconds: Number(durationSeconds), keeperShareBps: Number(keeperShareBps), targetHealthBps: Number(targetHealthBps) }
  }

  /** Auction state of a plan: open or not, discount now, health vs target, overdue, the app sentence. */
  const auctionStatus = async (planId: bigint): Promise<DutchAuctionStatus> => {
    const [s, sch] = await Promise.all([read(house(), norenDutchAuctionAbi as Abi, 'auctionStatus', [planId]), schedule()])
    const sym = symbolOf(s.collateral)
    const amt = formatUnitsTrim(s.collateralAmount, 18, 6)
    let message: string
    if (s.error) message = `Auction paused: ${s.error}`
    else if (s.open)
      message = `Auction open for ${amt} ${sym}: discount ${pct(s.discountWad)} (rising to ${sch.capBps / 100}%), health ${health(s.healthWad)} -> target ${health(s.targetHealthWad)}`
    else if (s.liquidatable) message = `Plan liquidatable (health ${health(s.healthWad)}${s.overdue ? ', missed installments' : ''}): anyone can open an auction`
    else message = `No auction: health ${health(s.healthWad)}`
    return {
      planId,
      open: s.open,
      startedAt: BigInt(s.startedAt),
      elapsedSeconds: s.elapsed,
      discountWad: s.discountWad,
      makerDiscountWad: s.makerDiscountWad,
      keeperDiscountWad: s.keeperDiscountWad,
      healthWad: s.healthWad,
      targetHealthWad: s.targetHealthWad,
      overdue: s.overdue,
      liquidatable: s.liquidatable,
      round: Number(s.round),
      fills: Number(s.fills),
      collateral: s.collateral,
      collateralAmount: s.collateralAmount,
      outstandingUsdg: s.outstandingUsdg,
      priceUsd8: s.priceUsd8,
      error: s.error,
      schedule: sch,
      message,
    }
  }

  /** What a fill would do right now (static call; throws the contract's revert reason otherwise). */
  const previewPartialLiquidation = async ({ planId, maxRepayUsdg = MAX }: { planId: bigint; maxRepayUsdg?: bigint }) =>
    (await read(house(), norenDutchAuctionAbi as Abi, 'previewFill', [planId, maxRepayUsdg])) as PartialLiquidationPreview

  /** Open the auction for a liquidatable plan (anyone). */
  const openAuction = async (planId: bigint) => {
    const r = await confirm(await write(house(), norenDutchAuctionAbi as Abi, 'openAuction', [planId]))
    return { receipt: r, opened: events(r, 'AuctionOpened')[0] }
  }

  /** Close an auction whose plan is no longer liquidatable (anyone). */
  const closeAuction = async (planId: bigint) => {
    const r = await confirm(await write(house(), norenDutchAuctionAbi as Abi, 'closeAuction', [planId]))
    return { receipt: r, closed: events(r, 'AuctionClosed')[0] }
  }

  /**
   * Keeper: fill the open auction. Opens it first when `open` is true and none is open. The caller
   * pays nothing; the maker's USDG goes to the lender pool and the keeper receives its share of the
   * discount in collateral. Returns the fill, the tx receipt and whether the auction closed.
   */
  const fillPartialLiquidation = async ({ planId, maxRepayUsdg = MAX, open = false }: { planId: bigint; maxRepayUsdg?: bigint; open?: boolean }) => {
    let openReceipt: TransactionReceipt | undefined
    if (open) {
      const st = (await read(house(), norenDutchAuctionAbi as Abi, 'auction', [planId])) as { startedAt: bigint }
      if (BigInt(st.startedAt) === 0n) openReceipt = (await openAuction(planId)).receipt
    }
    const preview = await previewPartialLiquidation({ planId, maxRepayUsdg })
    const r = await confirm(await write(house(), norenDutchAuctionAbi as Abi, 'fill', [planId, maxRepayUsdg]))
    const filled = events(r, 'AuctionFilled')[0]
    if (!filled) throw new Error(`Expected AuctionFilled event missing from ${r.transactionHash}`)
    return { receipt: r, openReceipt, preview, filled, auctionClosed: events(r, 'AuctionClosed').length > 0 }
  }

  // ---------------------------------------------------------------- makers

  /** The canonical Dutch-auction Aqua order (Salt, NorenDutchDecay, zero-spread NorenOraclePeg). */
  const buildDutchStrategy = async ({ maker, asset, salt = 0n }: { maker: Address; asset: Address; salt?: bigint }) => {
    const [order, strategyHash] = (await read(house(), norenDutchAuctionAbi as Abi, 'buildOrder', [maker, asset, salt])) as [
      { maker: Address; traits: bigint; data: Hex },
      Hex,
    ]
    return { order, strategyHash }
  }

  /** Maker: approve Aqua for USDG, ship the Dutch strategy with `usdgAmount` virtual USDG, register it. */
  const shipDutchStrategy = async ({ asset, usdgAmount, salt = 0n }: { asset: Address; usdgAmount: bigint; salt?: bigint }) => {
    if (!addresses.swapRouter) throw new Error('Setup required: addresses.swapRouter')
    const me = account()
    const aqua = addresses.aqua ?? AQUA
    const allowed = (await read(addresses.usdg, erc20PermitAbi as Abi, 'allowance', [me, aqua])) as bigint
    if (allowed < usdgAmount) await confirm(await write(addresses.usdg, erc20PermitAbi as Abi, 'approve', [aqua, MAX]))
    const { order, strategyHash } = await buildDutchStrategy({ maker: me, asset, salt })
    const strategy = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], [order])
    const shipHash = await write(aqua, aquaAbi as Abi, 'ship', [addresses.swapRouter, strategy, [addresses.usdg, asset], [usdgAmount, 0n]])
    await confirm(shipHash)
    const registerHash = await write(house(), norenDutchAuctionAbi as Abi, 'register', [asset, salt])
    await confirm(registerHash)
    return { strategyHash, shipHash, registerHash }
  }

  return { auctionStatus, previewPartialLiquidation, fillPartialLiquidation, openAuction, closeAuction, buildDutchStrategy, shipDutchStrategy, schedule }
}

export const formatDiscount = pct
export const formatHealth = health
export const DUTCH_WAD = WAD
