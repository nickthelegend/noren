import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters } from 'viem';
import { verifyWebhook } from '@noren/core/merchant';
import { createMerchantServer } from './server.ts';

const merchant = `0x${'22'.repeat(20)}` as const;
const checkout = `0x${'44'.repeat(20)}` as const;
const listen = (server: ReturnType<typeof createServer>, port: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = (server: ReturnType<typeof createServer>) => new Promise<void>(resolve => server.close(() => resolve()));
const until = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 80; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out waiting for webhook delivery'); };

describe('merchant webhooks and profile', () => {
  it('persists metadata, verifies delivery, and records three failed attempts', async () => {
    const rpc = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const { method } = JSON.parse(raw); const result = method === 'eth_chainId' ? '0x4cef52' : method === 'anvil_nodeInfo' ? { forkConfig: { forkUrl: 'https://rpc.testnet.arc.io' } } : method === 'eth_getBlockByNumber' ? { number: '0x1', timestamp: '0x3e8' } : method === 'eth_call' ? encodeAbiParameters([{ type: 'address' }], [merchant]) : null; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result })); });
    const received: { raw: string; signature: string | null }[] = [];
    const receiver = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; received.push({ raw, signature: req.headers['noren-signature'] as string }); res.writeHead(200); res.end(); });
    let failed = 0; const failing = createServer(async (req, res) => { for await (const _ of req) { /* consume */ } failed++; res.writeHead(500); res.end(); });
    const dir = await mkdtemp(join(tmpdir(), 'noren-webhooks-'));
    let server: ReturnType<typeof createMerchantServer> | undefined;
    try {
      await listen(rpc, 8706); await listen(receiver, 8707); await listen(failing, 8708);
      server = createMerchantServer({ deployment: { chainId: 5042002, deploymentBlock: '1', usdc: merchant, entrypoint: merchant, pool: merchant, checkout }, rpcUrl: 'http://127.0.0.1:8706', localUnlockedMerchant: merchant, dataFile: join(dir, 'rows.json'), dev: { aspUrl: 'http://127.0.0.1:8709', merchantToken: 'test-token' } });
      await listen(server, 8709);
      const call = async (path: string, method = 'GET', data?: unknown, auth = false) => { const response = await fetch('http://127.0.0.1:8709' + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer test-token' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
      const path = `/merchants/${merchant}`;
      expect((await call(`${path}/profile`)).body.name).toBeNull();
      expect((await call(`${path}/profile`, 'POST', { name: ' Takumi Coffee ' }, true)).body.name).toBe('Takumi Coffee');
      expect((await call(`${path}/webhooks`, 'POST', { url: 'file:///bad' }, true)).status).toBe(400);
      const hook = (await call(`${path}/webhooks`, 'POST', { url: 'http://127.0.0.1:8707' }, true)).body;
      const badHook = (await call(`${path}/webhooks`, 'POST', { url: 'http://127.0.0.1:8708' }, true)).body;
      expect(hook.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
      expect((await call(`${path}/webhooks`, 'GET', undefined, true)).body[0].secret).toBeUndefined();
      const created = (await call(`${path}/invoices`, 'POST', { amount: '7500000', expiry: '2000', description: ' Flat white ' }, true)).body;
      expect(created.invoice.invoiceId).toMatch(/^0x/);
      const id = created.invoice.invoiceId;
      await until(async () => received.length === 1);
      const event = await verifyWebhook(received[0].raw, received[0].signature, hook.secret, { toleranceSeconds: 9999999999 });
      expect(event.type).toBe('invoice.created'); expect(event.data.invoiceId).toBe(id); expect(event.data.description).toBe('Flat white');
      await until(async () => failed === 3 && (await call(`${path}/events`, 'GET', undefined, true)).body[0]?.deliveries.filter((d: any) => d.endpointId === badHook.id).length === 3);
      const events = (await call(`${path}/events`, 'GET', undefined, true)).body;
      expect(events[0].deliveries.filter((d: any) => d.endpointId === hook.id)[0].ok).toBe(true);
      expect(events[0].deliveries.filter((d: any) => d.endpointId === badHook.id)).toHaveLength(3);
      const retrieved = (await call(`/invoices/${id}`)).body;
      expect(retrieved).toMatchObject({ createdAt: 1000, description: 'Flat white', merchantName: 'Takumi Coffee' });
      expect((await call(`${path}/webhooks/${hook.id}`, 'DELETE', undefined, true)).body.deleted).toBe(true);
      expect(await readFile(join(dir, 'rows.json.profile.json'), 'utf8')).toContain('Takumi Coffee');
    } finally { if (server) await close(server); await close(failing); await close(receiver); await close(rpc); await rm(dir, { recursive: true, force: true }); }
  }, 15000);
});
