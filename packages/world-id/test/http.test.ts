import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { createWorldIdHandler } from '../src/http.ts';
import { loadWorldIdConfig } from '../src/config.ts';
import { WorldIdService } from '../src/service.ts';
import { idkitResult, startStandin } from './standin.ts';

const KEY = keccak256(toHex('noren world-id http test key'));
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', BOB = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const PORT = 8754;
const base = `http://127.0.0.1:${PORT}`;
let server: Server, standin: Awaited<ReturnType<typeof startStandin>>, dir: string;

beforeAll(async () => {
  standin = await startStandin(8755);
  dir = await mkdtemp(join(tmpdir(), 'noren-world-http-'));
  const svc = new WorldIdService({ config: loadWorldIdConfig({ WORLD_APP_ID: 'app_test', WORLD_RP_ID: 'rp_test', WORLD_RP_SIGNING_KEY: KEY, WORLD_VERIFY_BASE: standin.url }), dataFile: join(dir, 'w.json') });
  const worldId = createWorldIdHandler(svc);
  server = createServer(async (req, res) => { if (await worldId(req, res)) return; res.writeHead(418).end('host route'); });
  await new Promise<void>(r => server.listen(PORT, '127.0.0.1', () => r()));
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); await standin.close(); await rm(dir, { recursive: true, force: true }); });

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('HTTP handler', () => {
  it('leaves other routes to the host server', async () => {
    expect((await fetch(base + '/merchants')).status).toBe(418);
    expect((await fetch(base + '/world-idx')).status).toBe(418);
  });

  it('serves config without any secret', async () => {
    const res = await fetch(base + '/world-id/config');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ configured: true, missing: [], action: 'noren-credit', credential: 'selfie', starterSink: 'none' });
    expect(text).not.toContain(KEY.slice(2));
  });

  it('runs request -> verify -> status, then answers 409 for the same human', async () => {
    const reqRes = await post('/world-id/request', { wallet: ALICE });
    expect(reqRes.status).toBe(200);
    const text = await reqRes.text();
    expect(text).not.toContain(KEY.slice(2));
    const req = JSON.parse(text);
    expect(req.rp_context).toMatchObject({ rp_id: 'rp_test', nonce: expect.stringMatching(/^0x/), signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) });

    const human = '0x' + '1a'.repeat(32);
    const ok = await post('/world-id/verify', { idkitResponse: idkitResult({ nonce: req.rp_context.nonce, wallet: ALICE, nullifier: human }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'verified', starter: { status: 'setup_required' } });
    expect(await (await fetch(`${base}/world-id/status/${ALICE}`)).json()).toMatchObject({ verified: true });
    expect(await (await fetch(`${base}/world-id/status/${BOB}`)).json()).toEqual({ verified: false });

    const req2 = await (await post('/world-id/request', { wallet: BOB })).json();
    const dup = await post('/world-id/verify', { idkitResponse: idkitResult({ nonce: req2.rp_context.nonce, wallet: BOB, nullifier: human }) });
    expect(dup.status).toBe(409);
    expect((await dup.json()).status).toBe('already_used');
  });

  it('maps bad input to 400, unknown routes to 404 and oversized bodies to 413', async () => {
    expect((await post('/world-id/request', { wallet: 'nope' })).status).toBe(400);
    expect((await post('/world-id/verify', '{not json')).status).toBe(400);
    expect((await post('/world-id/verify', { idkitResponse: { protocol_version: '4.0' } })).status).toBe(400);
    expect((await fetch(base + '/world-id/nothing')).status).toBe(404);
    expect((await post('/world-id/verify', { pad: 'x'.repeat(70_000) })).status).toBe(413);
  });

  it('answers 503 Setup required when the app is not configured', async () => {
    const svc = new WorldIdService({ config: loadWorldIdConfig({}), dataFile: join(dir, 'none.json') });
    const h = createWorldIdHandler(svc);
    const s = createServer(async (req, res) => { await h(req, res); });
    await new Promise<void>(r => s.listen(8756, '127.0.0.1', () => r()));
    try {
      const res = await fetch('http://127.0.0.1:8756/world-id/request', { method: 'POST', body: JSON.stringify({ wallet: ALICE }) });
      expect(res.status).toBe(503);
      expect((await res.json()).detail).toMatch(/^Setup required: WORLD_APP_ID, WORLD_RP_ID, WORLD_RP_SIGNING_KEY/);
    } finally { await new Promise<void>(r => s.close(() => r())); }
  });
});
