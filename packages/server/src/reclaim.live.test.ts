// Live: the Reclaim SDK's real verifyProof fetches Reclaim's attestor list over the network. If that fetch fails the
// first test fails (it does not pass silently), so a rejection below is always a real signature rejection.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSignDataForClaim, getAttestors, verifyProof, type Proof } from '@reclaimprotocol/js-sdk';
import { verifyAndRecord } from './reclaim.ts';

const address = `0x${'ab'.repeat(20)}`;
const storeFile = join(mkdtempSync(join(tmpdir(), 'noren-reclaim-live-')), 'reclaim-proofs.json');

async function forged(): Promise<Proof> {
  const claim = { provider: 'http', parameters: JSON.stringify({ url: 'https://example.com/balance', method: 'GET' }), owner: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), timestampS: Math.floor(Date.now() / 1000), context: JSON.stringify({ contextAddress: address, contextMessage: 'Noren credit: raise my limit', reclaimSessionId: 'live-test', extractedParameters: { balance: '1000000' } }), identifier: '0x' + 'ee'.repeat(32), epoch: 1 };
  // A well-formed EIP-191 signature over the exact claim data, made by a key that is not a Reclaim attestor.
  const signature = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: createSignDataForClaim(claim) });
  return { identifier: claim.identifier, claimData: claim, signatures: [signature], witnesses: [{ id: '0x0', url: '' }], extractedParameterValues: { balance: '1000000' } };
}

describe('Reclaim verifyProof (real SDK, live attestor list)', () => {
  it('reaches Reclaim and gets the attestor list', async () => {
    const attestors = await getAttestors();
    expect(attestors.length).toBeGreaterThan(0);
  }, 30_000);

  it('rejects a well-formed proof signed by a non-attestor', async () => {
    const r = await verifyProof(await forged(), { providerId: 'any' });
    expect(r.isVerified).toBe(false);
    expect(String(r.error?.message)).toMatch(/Identifier mismatch/);
  }, 30_000);

  it('verifyAndRecord throws ReclaimProofRejected and stores nothing', async () => {
    await expect(verifyAndRecord(await forged(), address, { storeFile, provider: { id: 'p', name: 'P' }, sessionId: 'live-test', config: { providerId: 'any' } })).rejects.toThrow(/ReclaimProofRejected: .*Identifier mismatch/);
    expect(existsSync(storeFile)).toBe(false);
  }, 30_000);

  it('rejects a tampered claim (signature no longer matches the data)', async () => {
    const p = await forged();
    p.claimData = { ...p.claimData, parameters: p.claimData.parameters.replace('balance', 'balances') };
    const r = await verifyProof(p, { providerId: 'any' });
    expect(r.isVerified).toBe(false);
  }, 30_000);
});
