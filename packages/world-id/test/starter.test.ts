import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeAbiParameters, encodeAbiParameters, keccak256, size, toHex } from 'viem';
import { creSimulateSink, HUMAN_STARTER_KIND, starterLineId, humanStarterRequest, httpTriggerPayload } from '../src/starter.ts';
import { starterLineId as bridgeStarterLineId } from '../../cre-bridge/credit-bridge/bridge.ts';

const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('human starter report', () => {
  it('encodes (kind, borrower, nullifierHash, limit, expiry) in 160 bytes, distinct from the 128-byte stock report', () => {
    const r = humanStarterRequest({ borrower: ALICE.toLowerCase(), nullifier: '0x1234', limitUsdc6: 25_000_000n, expiry: 1_800_000_000 });
    expect(size(r.report)).toBe(160);
    expect(HUMAN_STARTER_KIND).toBe(keccak256(toHex('noren.human-starter.v1')));
    const [kind, borrower, nh, limit, expiry] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }], r.report);
    expect(kind).toBe(HUMAN_STARTER_KIND);
    expect(borrower).toBe(ALICE);
    expect(nh).toBe(toHex(0x1234n, { size: 32 }));
    expect(limit).toBe(25_000_000n);
    expect(expiry).toBe(1_800_000_000n);
    expect(r.lineId).toBe(keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], ['noren.human-starter.v1', ALICE])));
  });

  it('derives the line id exactly as NorenCreditLine.starterLineId and the CRE bridge do', () => {
    expect(starterLineId(ALICE)).toBe(bridgeStarterLineId(ALICE));
    expect(starterLineId(ALICE.toLowerCase())).toBe(starterLineId(ALICE));
    expect(starterLineId(ALICE)).not.toBe(starterLineId('0x000000000000000000000000000000000000dEaD'));
  });

  it('rejects a zero limit and a bad borrower', () => {
    expect(() => humanStarterRequest({ borrower: ALICE, nullifier: '0x1', limitUsdc6: 0n, expiry: 1 })).toThrow();
    expect(() => humanStarterRequest({ borrower: '0x123', nullifier: '0x1', limitUsdc6: 1n, expiry: 1 })).toThrow();
  });

  it('builds the CRE HTTP trigger payload with string amounts', () => {
    const r = humanStarterRequest({ borrower: ALICE, nullifier: '0x1', limitUsdc6: 25_000_000n, expiry: 1_800_000_000 });
    expect(httpTriggerPayload(r)).toEqual({ kind: 'noren.human-starter.v1', borrower: ALICE, nullifierHash: toHex(1n, { size: 32 }), lineId: r.lineId, limitUsdc6: '25000000', expiry: 1_800_000_000 });
  });
});

// The sink shells out to the real `cre` CLI. To test its argument list and output parsing offline,
// these tests point creBin at a tiny local script that prints what the CRE simulator prints.
describe('CRE simulate sink (argument list and output parsing)', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'noren-world-cre-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  const script = async (name: string, body: string) => { const p = join(dir, name); await writeFile(p, `#!/bin/sh\n${body}\n`); await chmod(p, 0o755); return p; };
  const req = humanStarterRequest({ borrower: ALICE, nullifier: '0x99', limitUsdc6: 25_000_000n, expiry: 1_800_000_000 });

  it('passes the payload as --http-payload with --broadcast and reads the write tx', async () => {
    const tx = '0x' + 'cd'.repeat(32);
    const bin = await script('ok.sh', `echo "$@" > "${dir}/args.txt"; echo "[USER LOG] NorenCreditLine updated on arc-testnet: tx ${tx}"`);
    const sink = creSimulateSink({ projectRoot: dir, workflow: 'human-starter', target: 'local-fork', triggerIndex: 3, creBin: bin });
    expect(await sink.open(req)).toEqual({ txHash: tx });
    const args = (await import('node:fs')).readFileSync(join(dir, 'args.txt'), 'utf8');
    expect(args).toContain('workflow simulate human-starter');
    expect(args).toContain('--trigger-index 3');
    expect(args).toContain('--broadcast');
    expect(args).toContain('"kind":"noren.human-starter.v1"');
  });

  it('fails loudly, and redacts 32-byte hex from the error', async () => {
    const secretish = '0x' + 'ee'.repeat(32);
    const bin = await script('bad.sh', `echo "Error: execution reverted HumanAlreadyHasLine ${secretish}" >&2; exit 1`);
    const sink = creSimulateSink({ projectRoot: dir, workflow: 'human-starter', target: 'local-fork', triggerIndex: 3, creBin: bin });
    const err = await sink.open(req).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HumanAlreadyHasLine');
    expect((err as Error).message).not.toContain(secretish);
  });
});
