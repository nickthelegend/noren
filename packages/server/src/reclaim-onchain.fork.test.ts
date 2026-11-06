// Needs pnpm dev:all (the Robinhood fork on 8646 with packages/robinhood/.fork/deployment.json). Runs against the real
// deployed NorenReputation (with recordAttestation): it records kind + salted commitment and the chain shows only that.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { commitmentOf, newSalt, recordOnchain, reputationAttestationAbi } from './reclaim-onchain.ts';

const d = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../robinhood/.fork/deployment.json'), 'utf8'));
const rpcUrl = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8646';

describe('recordOnchain on the Robinhood fork', () => {
  it('records an identity attestation (kind 4) with a salted commitment, once per kind', async () => {
    const borrower = privateKeyToAccount(generatePrivateKey()).address, salt = newSalt();
    const r = await recordOnchain({ rpcUrl, reputation: d.reputation }, borrower, 'identity', 'proof-x', salt);
    expect(r.status).toBe('recorded');
    if (r.status !== 'recorded') return;
    expect(r.commitment).toBe(commitmentOf(4, 'proof-x', salt));
    expect(r.boostBps).toBe(10_000);
    const [, kinds, count] = await createPublicClient({ transport: http(rpcUrl) }).readContract({ address: d.reputation, abi: reputationAttestationAbi, functionName: 'attestationsOf', args: [borrower] });
    expect(kinds).toBe(1n << 4n);
    expect(count).toBe(1);
    const again = await recordOnchain({ rpcUrl, reputation: d.reputation }, borrower, 'identity', 'proof-y', newSalt());
    expect(again).toMatchObject({ status: 'unavailable' });
    if (again.status === 'unavailable') expect(again.reason).toMatch(/already has a identity attestation|one per kind/);
  });
});
