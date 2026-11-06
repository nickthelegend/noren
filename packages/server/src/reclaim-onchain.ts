/**
 * On-chain, private reputation for verified off-chain facts. After the Noren server verifies a Reclaim proof it
 * records only the proof TYPE and a commitment on NorenReputation:
 *   commitment = keccak256(abi.encode(uint8 kind, string proofId, bytes32 salt))
 * The salt stays off-chain in the 0600 proof store, so the chain sees "this wallet proved a credit score" and nothing
 * that identifies the proof or the person. The attester is the existing World ID attester key (NOREN_WORLD_ATTESTER_KEY;
 * on a local fork only, Anvil's published key #7 that deploy-fork.sh made the attester).
 *
 * `recordAttestation(borrower, kind, commitment, boostBps)` lands on NorenReputation with the contracts-audit branch.
 * Until the deployed contract has it, this returns { status: 'unavailable', reason } and the UI says so; nothing is
 * faked, and the proof still counts on the history underwriter's score.
 */
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ReclaimGroup } from './reclaim-providers.ts';

/** Attestation kinds Noren writes (1-4 Reclaim groups; 0 is World ID, recorded by verifyHuman today). */
export const ATTESTATION_KIND: Record<ReclaimGroup, number> = { 'credit-score': 1, kyc: 2, balance: 3, identity: 4 };
/** The limit boost each kind asks for, in bps; NorenReputation caps it. Mirrors the score points (15/8/8/3). */
export const KIND_BOOST_BPS: Record<ReclaimGroup, number> = { 'credit-score': 1_500, kyc: 800, balance: 800, identity: 300 };

export const reputationAttestationAbi = parseAbi([
  'function recordAttestation(address borrower, uint8 kind, bytes32 commitment, uint16 boostBps)',
]);
/** Anvil's published dev key #7, the fork's World ID attester (packages/robinhood deploy-fork.sh). Fork only. */
const FORK_ATTESTER_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356' as Hex;

export type OnchainRecord = { status: 'recorded'; tx: Hex; kind: number; commitment: Hex; boostBps: number } | { status: 'unavailable'; reason: string };
export type OnchainTarget = { rpcUrl: string; reputation: Address; attesterKey?: Hex };

export const commitmentOf = (kind: number, proofId: string, salt: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint8' }, { type: 'string' }, { type: 'bytes32' }], [kind, proofId, salt]));
export const newSalt = (): Hex => toHex(randomBytes(32));

const loopback = (url: string) => { try { return ['127.0.0.1', 'localhost'].includes(new URL(url).hostname); } catch { return false; } };

export async function recordOnchain(target: OnchainTarget | undefined, borrower: Address, group: ReclaimGroup, proofId: string, salt: Hex): Promise<OnchainRecord> {
  if (!target) return { status: 'unavailable', reason: 'Setup required: no NorenReputation on this stack (pnpm dev:all with packages/robinhood)' };
  const key = target.attesterKey ?? (process.env.NOREN_WORLD_ATTESTER_KEY as Hex | undefined) ?? (loopback(target.rpcUrl) ? FORK_ATTESTER_KEY : undefined);
  if (!key) return { status: 'unavailable', reason: 'Setup required: NOREN_WORLD_ATTESTER_KEY' };
  const kind = ATTESTATION_KIND[group], boostBps = KIND_BOOST_BPS[group];
  const commitment = commitmentOf(kind, proofId, salt);
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ transport: http(target.rpcUrl) });
  try {
    await pub.simulateContract({ account, address: target.reputation, abi: reputationAttestationAbi, functionName: 'recordAttestation', args: [borrower, kind, commitment, boostBps] });
  } catch (e: any) {
    const m = String(e?.shortMessage ?? e?.message ?? e);
    // No such function on the deployed NorenReputation: the contracts-audit change isn't on this stack yet.
    if (/reverted|execution reverted|function selector|0x$/i.test(m) && !/Unauthorized|NotAttester|BadSignature/i.test(m))
      return { status: 'unavailable', reason: 'NorenReputation on this stack has no recordAttestation yet (it lands with the contracts-audit branch); the proof counts on the history score meanwhile' };
    return { status: 'unavailable', reason: `recordAttestation would revert: ${m.slice(0, 160)}` };
  }
  const wallet = createWalletClient({ account, transport: http(target.rpcUrl) });
  const tx = await wallet.writeContract({ address: target.reputation, abi: reputationAttestationAbi, functionName: 'recordAttestation', args: [borrower, kind, commitment, boostBps], account, chain: null });
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  if (r.status !== 'success') return { status: 'unavailable', reason: `recordAttestation reverted: ${tx}` };
  return { status: 'recorded', tx, kind, commitment, boostBps };
}
