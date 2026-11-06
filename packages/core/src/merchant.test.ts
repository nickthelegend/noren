import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from './merchant.ts';

describe('verifyWebhook', () => {
  const secret = 'whsec_' + 'a'.repeat(64);
  const raw = JSON.stringify({ id: 'evt_test', type: 'invoice.created', created: 1, data: { invoiceId: '0x1' } });
  const signature = (body: string, key = secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;
  it('accepts a valid signed event', async () => expect((await verifyWebhook(raw, signature(raw), secret)).type).toBe('invoice.created'));
  it('rejects a tampered body', async () => expect(verifyWebhook(raw + ' ', signature(raw), secret)).rejects.toThrow(/signature/));
  it('rejects a wrong secret', async () => expect(verifyWebhook(raw, signature(raw), 'wrong')).rejects.toThrow(/signature/));
  it('rejects a stale timestamp', async () => expect(verifyWebhook(raw, signature(raw, secret, Math.floor(Date.now() / 1000) - 301), secret)).rejects.toThrow(/stale/));
});
