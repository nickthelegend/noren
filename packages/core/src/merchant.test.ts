import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createNoren, verifyWebhook } from './merchant.ts';
import { createServer } from 'node:http';

describe('verifyWebhook', () => {
  const secret = 'whsec_' + 'a'.repeat(64);
  const raw = JSON.stringify({ id: 'evt_test', type: 'invoice.created', created: 1, data: { invoiceId: '0x1' } });
  const signature = (body: string, key = secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;
  it('accepts a valid signed event', async () => expect((await verifyWebhook(raw, signature(raw), secret)).type).toBe('invoice.created'));
  it('rejects a tampered body', async () => expect(verifyWebhook(raw + ' ', signature(raw), secret)).rejects.toThrow(/signature/));
  it('rejects a wrong secret', async () => expect(verifyWebhook(raw, signature(raw), 'wrong')).rejects.toThrow(/signature/));
  it('rejects a stale timestamp', async () => expect(verifyWebhook(raw, signature(raw, secret, Math.floor(Date.now() / 1000) - 301), secret)).rejects.toThrow(/stale/));
});

it('passes redirects and metadata through invoice creation and returns the checkout URL', async () => {
  let received: any;
  const server = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; received = { path: req.url, token: req.headers.authorization, body: JSON.parse(raw) }; res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ invoice: { invoiceId: '0x1' }, url: 'https://shop.example/pay/1', successUrl: received.body.successUrl, cancelUrl: received.body.cancelUrl, metadata: received.body.metadata })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port'); const sdk = createNoren({ server: `http://127.0.0.1:${address.port}`, token: 'sk_test_abc', merchant: '0xmerchant' }); const result = await sdk.invoices.create({ amount: 7_500_000n, expiresIn: 1800, successUrl: 'https://shop.example/ok', cancelUrl: 'https://shop.example/cancel', metadata: { orderId: '42' } }); expect(received.path).toBe('/merchants/0xmerchant/invoices'); expect(received.token).toBe('Bearer sk_test_abc'); expect(received.body).toMatchObject({ amount: '7500000', successUrl: 'https://shop.example/ok', cancelUrl: 'https://shop.example/cancel', metadata: { orderId: '42' } }); expect(result).toMatchObject({ url: 'https://shop.example/pay/1', successUrl: 'https://shop.example/ok', metadata: { orderId: '42' } }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
