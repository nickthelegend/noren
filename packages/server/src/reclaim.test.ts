import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Proof } from '@reclaimprotocol/js-sdk';
import { createReclaimHandler, missingReclaimEnv, verifyAndRecord } from './reclaim.ts';
import { minimalStatement } from './reclaim-providers.ts';
import { commitmentOf } from './reclaim-onchain.ts';

const dir = mkdtempSync(join(tmpdir(), 'noren-reclaim-'));
const storeFile = join(dir, 'reclaim-proofs.json');
const wallet = `0x${'ab'.repeat(20)}`;
let server: Server, base = '';
const listen = async (env: Record<string, string>) => {
  const handle = createReclaimHandler({ env, storeFile });
  const s = createServer((req, res) => { void handle(req, res).then((done) => { if (!done) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return { s, url: `http://127.0.0.1:${(s.address() as any).port}` };
};
beforeAll(async () => { ({ s: server, url: base } = await listen({})); });
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Reclaim routes without credentials', () => {
  it('POST /reclaim/request answers 503 Setup required, naming every missing variable', async () => {
    const r = await fetch(`${base}/reclaim/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet }) });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/^Setup required: RECLAIM_APP_ID, RECLAIM_APP_SECRET \(/);
  });
  it('with only the secret missing, names only RECLAIM_APP_SECRET and never echoes the app ID', async () => {
    const { s, url } = await listen({ RECLAIM_APP_ID: 'app-id-value-123' });
    try {
      const r = await fetch(`${url}/reclaim/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet }) });
      expect(r.status).toBe(503);
      const { error } = await r.json();
      expect(error).toMatch(/^Setup required: RECLAIM_APP_SECRET \(/);
      expect(error).not.toMatch(/RECLAIM_APP_ID|app-id-value/);
    } finally { s.close(); }
  });
  it('GET /reclaim/status says configured:false, lists the grouped providers and nothing is verified', async () => {
    const j = await (await fetch(`${base}/reclaim/status?address=${wallet}`)).json();
    expect(j).toMatchObject({ configured: false, missing: ['RECLAIM_APP_ID', 'RECLAIM_APP_SECRET'], verified: [], points: 0, maxPoints: 20 });
    expect(j.providers.map((p: any) => p.group)).toEqual(['credit-score', 'credit-score', 'credit-score', 'kyc', 'kyc', 'balance', 'balance', 'balance', 'balance', 'identity']);
  });
  it('lists only the variables that are actually missing, applies provider overrides, and never echoes the secret', async () => {
    expect(missingReclaimEnv({ RECLAIM_APP_ID: 'x', RECLAIM_APP_SECRET: ' ' })).toEqual(['RECLAIM_APP_SECRET']);
    const env = { RECLAIM_APP_ID: 'app', RECLAIM_APP_SECRET: 'do-not-echo', RECLAIM_PROVIDER_ID: '2b22db5c-78d9-4d82-84f0-a9e0a4ed0470', RECLAIM_PROVIDER_IDS: 'github:11111111-2222-4333-8444-555555555555,nope:x' };
    const { s, url } = await listen(env);
    const text = await (await fetch(`${url}/reclaim/status?address=${wallet}`)).text();
    const bad = await fetch(`${url}/reclaim/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet, provider: 'not_a_provider' }) });
    s.close();
    const j = JSON.parse(text);
    expect(j).toMatchObject({ configured: true, missing: [] });
    expect(j.providers[0]).toMatchObject({ label: 'binance_kyc', group: 'kyc', points: 8 });
    expect(j.providers.find((p: any) => p.label === 'github').id).toBe('11111111-2222-4333-8444-555555555555');
    expect(bad.status).toBe(400);
    expect(text).not.toContain('do-not-echo');
  });
  it('rejects bad addresses and unknown sessions', async () => {
    expect((await fetch(`${base}/reclaim/request`, { method: 'POST', body: JSON.stringify({ address: 'nope' }) })).status).toBe(400);
    expect((await fetch(`${base}/reclaim/session/abc`)).status).toBe(404);
  });
});

describe('minimal claims: coarse statements, never the values', () => {
  it('rounds credit scores down to 50 and balances to a power of ten; KYC and identity keep only that they hold', () => {
    expect(minimalStatement('credit-score', { latestScore: '742', name: 'Jane Doe' })).toBe('credit score ≥ 700');
    expect(minimalStatement('balance', { totalBalance: '$12,345.67' })).toBe('balance ≥ 10,000');
    expect(minimalStatement('kyc', { kycLevel: '2', dob: '1990-01-01', fullName: 'Jane Doe' })).toBe('KYC level ≥ 1');
    expect(minimalStatement('identity', { username: 'jane' })).toBe('account exists');
  });
});

describe('on-chain commitment', () => {
  it('hides the proof behind a salt: same proof, different salt, different commitment', () => {
    const a = commitmentOf(1, 'proof-1', `0x${'01'.repeat(32)}`), b = commitmentOf(1, 'proof-1', `0x${'02'.repeat(32)}`);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(commitmentOf(1, 'proof-1', `0x${'01'.repeat(32)}`)).toBe(a);
  });
});

describe('verifyAndRecord offline checks (before the SDK is asked)', () => {
  const proof = (contextAddress: string, sessionId = 's1'): Proof => ({ identifier: '0x' + '11'.repeat(32), claimData: { provider: 'http', parameters: '{}', owner: wallet, timestampS: 1, context: JSON.stringify({ contextAddress, contextMessage: 'm', reclaimSessionId: sessionId }), identifier: '0x' + '11'.repeat(32), epoch: 1 }, signatures: ['0x' + '00'.repeat(65)], witnesses: [], extractedParameterValues: {} });
  const opts = { storeFile, provider: { label: 'binance_kyc', id: 'p', name: 'P', group: 'kyc' as const, points: 8 }, sessionId: 's1', config: { providerId: 'p' } };
  it('rejects a proof bound to another wallet and stores nothing', async () => {
    await expect(verifyAndRecord(proof(`0x${'cd'.repeat(20)}`), wallet, opts)).rejects.toThrow(/different wallet/);
    expect(existsSync(storeFile)).toBe(false);
  });
  it('rejects a proof from another session, and an empty or malformed proof list', async () => {
    await expect(verifyAndRecord(proof(wallet, 's2'), wallet, opts)).rejects.toThrow(/different Reclaim session/);
    await expect(verifyAndRecord([], wallet, opts)).rejects.toThrow(/no proofs/);
    await expect(verifyAndRecord({ ...proof(wallet), signatures: [] }, wallet, opts)).rejects.toThrow(/malformed/);
    expect(existsSync(storeFile)).toBe(false);
  });
});
