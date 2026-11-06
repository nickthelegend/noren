import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Proof } from '@reclaimprotocol/js-sdk';
import { createReclaimHandler, missingReclaimEnv, verifyAndRecord } from './reclaim.ts';

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
    expect((await r.json()).error).toMatch(/^Setup required: RECLAIM_APP_ID, RECLAIM_APP_SECRET, RECLAIM_PROVIDER_ID/);
  });
  it('with the app set but no provider, names only RECLAIM_PROVIDER_ID and never the app values', async () => {
    const { s, url } = await listen({ RECLAIM_APP_ID: 'app-id-value-123', RECLAIM_APP_SECRET: 'secret-value-456' });
    try {
      const r = await fetch(`${url}/reclaim/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet }) });
      expect(r.status).toBe(503);
      const { error } = await r.json();
      expect(error).toMatch(/^Setup required: RECLAIM_PROVIDER_ID \(add a provider/);
      expect(error).not.toMatch(/RECLAIM_APP_ID|RECLAIM_APP_SECRET|app-id-value|secret-value/);
    } finally { s.close(); }
  });
  it('GET /reclaim/status says configured:false and nothing is verified', async () => {
    const j = await (await fetch(`${base}/reclaim/status?address=${wallet}`)).json();
    expect(j).toMatchObject({ configured: false, missing: ['RECLAIM_APP_ID', 'RECLAIM_APP_SECRET', 'RECLAIM_PROVIDER_ID'], provider: null, verified: null });
  });
  it('lists only the variables that are actually missing, and never echoes the secret', async () => {
    expect(missingReclaimEnv({ RECLAIM_APP_ID: 'x', RECLAIM_APP_SECRET: ' ' })).toEqual(['RECLAIM_APP_SECRET', 'RECLAIM_PROVIDER_ID']);
    const { s, url } = await listen({ RECLAIM_APP_ID: 'app', RECLAIM_APP_SECRET: 'do-not-echo', RECLAIM_PROVIDER_ID: 'prov-1', RECLAIM_PROVIDER_NAME: 'Test provider' });
    const text = await (await fetch(`${url}/reclaim/status?address=${wallet}`)).text();
    s.close();
    expect(JSON.parse(text)).toMatchObject({ configured: true, missing: [], provider: { id: 'prov-1', name: 'Test provider' } });
    expect(text).not.toContain('do-not-echo');
  });
  it('rejects bad addresses and unknown sessions', async () => {
    expect((await fetch(`${base}/reclaim/request`, { method: 'POST', body: JSON.stringify({ address: 'nope' }) })).status).toBe(400);
    expect((await fetch(`${base}/reclaim/session/abc`)).status).toBe(404);
  });
});

describe('verifyAndRecord offline checks (before the SDK is asked)', () => {
  const proof = (contextAddress: string, sessionId = 's1'): Proof => ({ identifier: '0x' + '11'.repeat(32), claimData: { provider: 'http', parameters: '{}', owner: wallet, timestampS: 1, context: JSON.stringify({ contextAddress, contextMessage: 'm', reclaimSessionId: sessionId }), identifier: '0x' + '11'.repeat(32), epoch: 1 }, signatures: ['0x' + '00'.repeat(65)], witnesses: [], extractedParameterValues: {} });
  const opts = { storeFile, provider: { id: 'p', name: 'P' }, sessionId: 's1', config: { providerId: 'p' } };
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
