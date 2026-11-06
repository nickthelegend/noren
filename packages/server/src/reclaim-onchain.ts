/**
 * On-chain, private reputation: NorenReputation.recordAttestation(borrower, kind, commitment, boostBps).
 * After the Noren server verifies a proof off-chain (a Reclaim zkTLS proof, World ID, or repayments it read on-chain)
 * it records only the proof KIND and a commitment:
 *   commitment = keccak256(abi.encode(uint8 kind, bytes32 proofId, bytes32 salt))   (= NorenReputation.commitmentFor)
 * The salt stays off-chain (the 0600 proof store), so the chain learns "this wallet proved a credit score" and nothing
 * that identifies the proof or the person.
 *
 * Weights are public, so every kind uses ONE fixed boostBps: 10,000 (the full MAX_KIND_POINTS = 25 points). A per-proof
 * weight would leak something about the proof (for example how high a score was); a fixed one reveals only the kind.
 * With 25 points per kind the ladder reads: any 2 kinds → 70% LTV, plus World ID → 75%, plus an on-chain repayment
 * attestation (and 100 points) → 80%.
 *
 * The attester must be NorenCredit.underwriter() or NorenReputation.attester(). The server uses the underwriter key
 * (NOREN_RH_UNDERWRITER_KEY; on a local fork only, Anvil's published key #9 that deploy-fork.sh made the underwriter).
 */
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseAbi, toBytes, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ReclaimGroup } from './reclaim-providers.ts';

/** NorenReputation attestation kinds (KIND_* constants). */
export const KIND = { worldId: 0, creditScore: 1, kyc: 2, balance: 3, identity: 4, onchainRepayment: 5 } as const;
export type KindName = keyof typeof KIND;
export const GROUP_KIND: Record<ReclaimGroup, KindName> = { 'credit-score': 'creditScore', kyc: 'kyc', balance: 'balance', identity: 'identity' };
/** One fixed public weight for every kind (bps of MAX_KIND_POINTS): reveals nothing beyond the kind. */
export const FIXED_BOOST_BPS = 10_000;
/** Kept for the Reclaim group mapping; every group records FIXED_BOOST_BPS. */
export const ATTESTATION_KIND: Record<ReclaimGroup, number> = { 'credit-score': KIND.creditScore, kyc: KIND.kyc, balance: KIND.balance, identity: KIND.identity };

export const reputationAttestationAbi = parseAbi([
  'function recordAttestation(address borrower, uint8 kind, bytes32 commitment, uint16 boostBps)',
  'function attestationsOf(address account) view returns (uint8 tier, uint256 kinds, uint8 count)',
  'event AttestationRecorded(address indexed borrower, uint8 indexed kind, bytes32 commitment)',
]);
/** Anvil's published dev key #9, the fork's NorenCredit.underwriter() (packages/robinhood deploy-fork.sh). Fork only. */
const FORK_UNDERWRITER_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as Hex;

export type OnchainRecord = { status: 'recorded'; tx: Hex; kind: number; commitment: Hex; boostBps: number } | { status: 'unavailable'; reason: string };
export type OnchainTarget = { rpcUrl: string; reputation: Address; attesterKey?: Hex };

/** A proof identifier as bytes32: a 0x…64-hex identifier as is (Reclaim's), anything else hashed. */
export const proofIdBytes32 = (id: string): Hex => (/^0x[0-9a-fA-F]{64}$/.test(id) ? (id.toLowerCase() as Hex) : keccak256(toBytes(id)));
export const commitmentOf = (kind: number, proofId: string, salt: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], [kind, proofIdBytes32(proofId), salt]));
export const newSalt = (): Hex => toHex(randomBytes(32));

const loopback = (url: string) => { try { return ['127.0.0.1', 'localhost'].includes(new URL(url).hostname); } catch { return false; } };

/** Record one kind for `borrower`. Simulates first; a revert comes back as { status: 'unavailable', reason }. */
export async function recordKind(target: OnchainTarget | undefined, borrower: Address, kindName: KindName, proofId: string, salt: Hex): Promise<OnchainRecord> {
  if (!target) return { status: 'unavailable', reason: 'Setup required: no NorenReputation on this stack (pnpm dev:all with packages/robinhood)' };
  const key = target.attesterKey ?? (process.env.NOREN_RH_UNDERWRITER_KEY as Hex | undefined) ?? (loopback(target.rpcUrl) ? FORK_UNDERWRITER_KEY : undefined);
  if (!key) return { status: 'unavailable', reason: 'Setup required: NOREN_RH_UNDERWRITER_KEY (the attester)' };
  const kind = KIND[kindName], boostBps = FIXED_BOOST_BPS;
  const commitment = commitmentOf(kind, proofId, salt);
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ transport: http(target.rpcUrl) });
  try {
    await pub.simulateContract({ account, address: target.reputation, abi: reputationAttestationAbi, functionName: 'recordAttestation', args: [borrower, kind, commitment, boostBps] });
  } catch (e: any) {
    const m = String(e?.shortMessage ?? e?.message ?? e);
    if (/KindAlreadyRecorded/.test(m)) return { status: 'unavailable', reason: `this wallet already has a ${kindName} attestation on-chain (one per kind)` };
    if (/NotAttester/.test(m)) return { status: 'unavailable', reason: 'the server key is not NorenReputation\'s attester on this stack' };
    return { status: 'unavailable', reason: `recordAttestation would revert: ${m.slice(0, 160)}` };
  }
  const wallet = createWalletClient({ account, transport: http(target.rpcUrl) });
  const tx = await wallet.writeContract({ address: target.reputation, abi: reputationAttestationAbi, functionName: 'recordAttestation', args: [borrower, kind, commitment, boostBps], account, chain: null });
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  if (r.status !== 'success') return { status: 'unavailable', reason: `recordAttestation reverted: ${tx}` };
  return { status: 'recorded', tx, kind, commitment, boostBps };
}

/** Reclaim proofs: the group decides the kind. */
export const recordOnchain = (target: OnchainTarget | undefined, borrower: Address, group: ReclaimGroup, proofId: string, salt: Hex) =>
  recordKind(target, borrower, GROUP_KIND[group], proofId, salt);
