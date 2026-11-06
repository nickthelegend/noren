import { createWalletClient, hashTypedData, http, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { norenCreditAbi, norenReputationAbi } from '../../sdk/src/abi.js'
import { ACCOUNT_AGE_TYPES } from '../../sdk/src/earn.js'
import type { Attestation } from '../../sdk/src/index.js'

// Anvil published dev key #9: used only when the target is a local chain-4663 fork.
const DEV_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as Hex

export const attestationTypes = {
  CreditAttestation: [
    { name: 'borrower', type: 'address' },
    { name: 'tier', type: 'uint8' },
    { name: 'limitUsdg', type: 'uint256' },
    { name: 'collateralRatioBps', type: 'uint16' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

export type AttestationTermsInput = { tier: number; limitUsdg: bigint; collateralRatioBps: number }

export type SignedAttestation = { declined: false; attestation: Attestation; signature: Hex; signer: string; contract: Address; chainId: number }

/** Signs NorenCredit's EIP-712 CreditAttestation for `terms` after checking them against the contract. */
export async function signAttestation({
  borrower,
  terms,
  credit,
  chainId,
  publicClient,
}: {
  borrower: Address
  terms: AttestationTermsInput
  credit: Address
  chainId: number
  publicClient: PublicClient
}): Promise<{ declined: true; reason: string } | SignedAttestation> {
  if (terms.tier === 0) return { declined: true, reason: 'Tier 0 has no credit limit' }
  const url = publicClient.transport.url ?? ''
  // EIP-712 must use the chain id the contract sees (block.chainid); a local fork may be re-tagged
  // to Robinhood testnet (46630) for the CRE simulator, so read it rather than trust the caller.
  const liveChainId = await publicClient.getChainId()
  if (liveChainId !== chainId) throw new Error(`Chain id mismatch: RPC reports ${liveChainId}, caller passed ${chainId}`)
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)
  const local = loopback && (chainId === 4663 || chainId === 46630)
  const key = process.env.NOREN_RH_UNDERWRITER_KEY as Hex | undefined
  if (!key && !local) throw new Error('Setup required: NOREN_RH_UNDERWRITER_KEY')
  const account = privateKeyToAccount(key ?? DEV_KEY)

  const [expected, minRatio, nonce] = await Promise.all([
    publicClient.readContract({ address: credit, abi: norenCreditAbi, functionName: 'underwriter' }),
    publicClient.readContract({ address: credit, abi: norenCreditAbi, functionName: 'minCollateralRatioBps' }),
    publicClient.readContract({ address: credit, abi: norenCreditAbi, functionName: 'attestationNonce', args: [borrower] }),
  ])
  if (account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Underwriter signer ${account.address} does not match contract underwriter ${expected}`)
  }
  if (terms.collateralRatioBps < minRatio) {
    throw new Error(`Collateral ratio ${terms.collateralRatioBps} bps is below NorenCredit's minimum ${minRatio} bps`)
  }

  const attestation: Attestation = {
    borrower,
    tier: terms.tier,
    limitUsdg: terms.limitUsdg,
    collateralRatioBps: terms.collateralRatioBps,
    nonce,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  }
  const domain = { name: 'NorenCredit', version: '1', chainId, verifyingContract: credit } as const
  const localHash = hashTypedData({ domain, types: attestationTypes, primaryType: 'CreditAttestation', message: attestation })
  const contractHash = await publicClient.readContract({ address: credit, abi: norenCreditAbi, functionName: 'hashAttestation', args: [attestation] })
  if (localHash.toLowerCase() !== contractHash.toLowerCase()) throw new Error('Attestation hash mismatch with contract')
  const wallet = createWalletClient({ account, transport: http(url), chain: publicClient.chain ?? undefined })
  const signature = await wallet.signTypedData({ domain, types: attestationTypes, primaryType: 'CreditAttestation', message: attestation })
  return { declined: false, attestation, signature, signer: key ? account.address : 'anvil-dev-key (fork only)', contract: credit, chainId }
}

/**
 * Signs NorenReputation's EIP-712 AccountAge(account, firstSeenAt, expiry) with the underwriter key
 * (the same key as CreditAttestation; NorenReputation checks it equals NorenCredit.underwriter()).
 * firstSeenAt = now - the history scan's age in whole days (a lower bound on the real age).
 */
export async function signAccountAge({
  account,
  ageDays,
  reputation,
  publicClient,
}: {
  account: Address
  ageDays: number
  reputation: Address
  publicClient: PublicClient
}): Promise<{ declined: true; reason: string } | { declined: false; account: Address; firstSeenAt: bigint; expiry: bigint; signature: Hex; signer: string }> {
  if (!(ageDays > 0)) return { declined: true, reason: 'Account age unknown or under a day: nothing to attest' }
  const url = publicClient.transport.url ?? ''
  const chainId = await publicClient.getChainId()
  const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url) && (chainId === 4663 || chainId === 46630)
  const key = process.env.NOREN_RH_UNDERWRITER_KEY as Hex | undefined
  if (!key && !local) throw new Error('Setup required: NOREN_RH_UNDERWRITER_KEY')
  const signer = privateKeyToAccount(key ?? DEV_KEY)
  const now = (await publicClient.getBlock()).timestamp
  const firstSeenAt = now - BigInt(Math.floor(ageDays)) * 86_400n
  const expiry = now + 600n
  const domain = { name: 'NorenReputation', version: '1', chainId, verifyingContract: reputation } as const
  const message = { account, firstSeenAt, expiry }
  const local712 = hashTypedData({ domain, types: ACCOUNT_AGE_TYPES, primaryType: 'AccountAge', message })
  const onChain = await publicClient.readContract({ address: reputation, abi: norenReputationAbi, functionName: 'hashAccountAge', args: [account, firstSeenAt, expiry] })
  if (local712.toLowerCase() !== onChain.toLowerCase()) throw new Error('AccountAge hash mismatch with NorenReputation')
  const signature = await signer.signTypedData({ domain, types: ACCOUNT_AGE_TYPES, primaryType: 'AccountAge', message })
  return { declined: false, account, firstSeenAt, expiry, signature, signer: key ? signer.address : 'anvil-dev-key (fork only)' }
}

/**
 * Reputation multiplier for the attested Pay-in-3 / Arc line limit (NorenReputation.limitMultiplierOf,
 * 10,000 = 1x). Returns 1x with a reason when no NorenReputation is deployed.
 */
export async function reputationMultiplierBps(publicClient: PublicClient, reputation: Address | undefined, borrower: Address) {
  if (!reputation) return { bps: 10_000, source: 'none: NorenReputation not deployed' }
  const bps = await publicClient.readContract({ address: reputation, abi: norenReputationAbi, functionName: 'limitMultiplierOf', args: [borrower] })
  return { bps: Number(bps), source: `NorenReputation ${reputation}` }
}
