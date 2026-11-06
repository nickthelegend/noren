// Needs pnpm dev:all (the Robinhood fork on 8646 with packages/robinhood/.fork/deployment.json). Runs against the real
// deployed NorenReputation: until the contracts-audit recordAttestation lands, the recorder must say so, not fake a tx.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitmentOf, newSalt, recordOnchain } from './reclaim-onchain.ts';

const d = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../robinhood/.fork/deployment.json'), 'utf8'));
const rpcUrl = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8646';

describe('recordOnchain on the Robinhood fork', () => {
  it('records kind + commitment, or says exactly why it cannot', async () => {
    const salt = newSalt();
    const r = await recordOnchain({ rpcUrl, reputation: d.reputation }, '0x1111000000000000000000000000000000002222', 'identity', 'proof-x', salt);
    if (r.status === 'recorded') { expect(r.commitment).toBe(commitmentOf(4, 'proof-x', salt)); expect(r.tx).toMatch(/^0x[0-9a-f]{64}$/); }
    else expect(r.reason).toMatch(/no recordAttestation yet|would revert/);
  });
});
