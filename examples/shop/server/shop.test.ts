import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { priceCart, PRODUCTS } from '../src/catalog.ts';
import { readWebhook } from './noren.ts';

const sign = (body: string, secret: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const secret = `whsec_${'ab'.repeat(32)}`;
const paidEvent = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', created: 1, data: { invoiceId: `0x${'11'.repeat(32)}`, amount: '248000000', status: 'paid', description: 'x', paymentTx: `0x${'22'.repeat(32)}`, refundTx: null, refundAmount: null } });

test('catalogue has 15 dresses with unique slugs and real prices', () => {
  assert.equal(PRODUCTS.length, 15);
  assert.equal(new Set(PRODUCTS.map(p => p.slug)).size, 15);
  for (const p of PRODUCTS) assert.ok(Number.isInteger(p.price) && p.price > 0 && p.sizes.length > 0, p.slug);
});

test('cart totals come from the catalogue, not the browser', () => {
  const { total, lines } = priceCart([{ slug: 'camille-slip', size: 'S', qty: 2, price: 1 }, { slug: 'amelie-gingham', size: 'M', qty: 1 }]);
  assert.equal(total, 24800 * 2 + 14800);
  assert.equal(lines[0].price, 24800);
});

test('cart rejects unknown products, sold-out sizes and silly quantities', () => {
  assert.throws(() => priceCart([]), /empty/);
  assert.throws(() => priceCart([{ slug: 'nope', size: 'S', qty: 1 }]), /Unknown product/);
  assert.throws(() => priceCart([{ slug: 'camille-slip', size: 'XS', qty: 1 }]), /not available/);
  assert.throws(() => priceCart([{ slug: 'camille-slip', size: 'S', qty: 0 }]), /Quantity/);
  assert.throws(() => priceCart([{ slug: 'camille-slip', size: 'S', qty: 1.5 }]), /Quantity/);
});

test('a correctly signed payment.succeeded webhook marks the invoice paid', async () => {
  const { paid } = await readWebhook(paidEvent, sign(paidEvent, secret), secret);
  assert.deepEqual(paid, { invoiceId: `0x${'11'.repeat(32)}`, tx: `0x${'22'.repeat(32)}` });
});

test('webhooks with a wrong secret, edited body or stale timestamp are rejected', async () => {
  await assert.rejects(readWebhook(paidEvent, sign(paidEvent, `whsec_${'cd'.repeat(32)}`), secret), /Invalid webhook signature/);
  await assert.rejects(readWebhook(paidEvent.replace('248000000', '1'), sign(paidEvent, secret), secret), /Invalid webhook signature/);
  await assert.rejects(readWebhook(paidEvent, sign(paidEvent, secret, Math.floor(Date.now() / 1000) - 3600), secret), /stale/);
  await assert.rejects(readWebhook(paidEvent, null, secret), /header/);
});
