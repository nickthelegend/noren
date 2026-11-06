import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullifierRegistry } from '../src/registry.ts';
import type { StarterLine } from '../src/types.ts';

const starter: StarterLine = { status: 'setup_required', lineId: `0x${'11'.repeat(32)}`, limitUsdc6: '25000000', expiry: 2_000_000_000, detail: 'x' };
const row = (nullifier: string, wallet: `0x${string}`) => ({ action: 'noren-credit', nullifier, credential: 'selfie' as const, verifiedAt: 1, wallet, starter });
const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'noren-world-reg-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('nullifier registry', () => {
  it('stores the nullifier as a decimal and refuses the same human again, whatever the hex spelling', async () => {
    const reg = new NullifierRegistry(join(dir, 'w.json'));
    expect((await reg.claim(row('0x2bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8', A))).ok).toBe(true);
    expect(await reg.claim(row('0x2BF8406809DCEFB1486DADC96C0A897DB9BAB002053054CF64272DB512C6FBD8', B))).toEqual({ ok: false, taken: 'human' });
    // Over-long spellings are refused outright by the IDKit Nullifier parser, so they can't mint a second identity.
    await expect(reg.claim(row('0x002bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8', B))).rejects.toThrow();
    // Short values with leading zeros compare as numbers.
    expect((await reg.claim(row('0x00ab', A.replace('C8', 'C9') as `0x${string}`))).ok).toBe(true);
    expect(await reg.claim(row('0xAB', B))).toEqual({ ok: false, taken: 'human' });
    const file = JSON.parse(await readFile(join(dir, 'w.json'), 'utf8'));
    expect(file.humans).toHaveLength(2);
    expect(file.humans[0].nullifier).toBe(BigInt('0x2bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8').toString(10));
  });

  it('gives one wallet one starter line, even from a second human', async () => {
    const reg = new NullifierRegistry(join(dir, 'w.json'));
    await reg.claim(row('0x01', A));
    expect(await reg.claim(row('0x02', A.toLowerCase() as `0x${string}`))).toEqual({ ok: false, taken: 'wallet' });
  });

  it('lets exactly one of many concurrent claims for the same human win', async () => {
    const reg = new NullifierRegistry(join(dir, 'w.json'));
    const wallets = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as `0x${string}`);
    const results = await Promise.all(wallets.map(w => reg.claim(row('0x1234', w))));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(await reg.count()).toBe(1);
  });

  it('survives a restart (a new instance reads the file) and keeps actions apart', async () => {
    const file = join(dir, 'w.json');
    await new NullifierRegistry(file).claim(row('0x99', A));
    const again = new NullifierRegistry(file);
    expect(await again.find('noren-credit', '0x99')).toBeTruthy();
    expect(await again.find('another-action', '0x99')).toBeUndefined();
    expect(await again.claim(row('0x99', B))).toEqual({ ok: false, taken: 'human' });
  });

  it('rejects a nullifier that is not a field element', async () => {
    const reg = new NullifierRegistry(join(dir, 'w.json'));
    await expect(reg.claim(row('0x' + 'f'.repeat(64), A))).rejects.toThrow();
    await expect(reg.claim(row('not-hex', A))).rejects.toThrow();
  });
});
