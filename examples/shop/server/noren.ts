// How Aubelle added Noren: this file is the whole integration.
import { createNoren, verifyWebhook } from '@noren/core/merchant';

export const noren = createNoren({
  server: process.env.NOREN_SERVER ?? '',  // the Noren API
  merchant: process.env.NOREN_MERCHANT!,   // the store's merchant address
  token: process.env.NOREN_SECRET_KEY,     // secret key, server-side only
});

// 1. "Checkout with Noren": invoice the bag, redirect to hosted checkout.
type Order = { id: string; totalCents: number; summary: string };
export async function createCheckout(order: Order, shopUrl: string) {
  const { invoice, url } = await noren.invoices.create({
    amount: BigInt(order.totalCents) * 10_000n, // cents -> USDC (6 dp)
    expiresIn: 30 * 60,
    description: order.summary,
    metadata: { orderId: order.id },
    successUrl: `${shopUrl}/#/order/${order.id}`,
    cancelUrl: `${shopUrl}/#/bag`,
  });
  return { invoiceId: String(invoice.invoiceId), url: url as string | undefined };
}

// 2. Noren calls back when the payment settles. Verify before trusting it.
export async function readWebhook(raw: string, sig: string | null, key: string) {
  const event = await verifyWebhook(raw, sig, key);
  if (event.type !== 'payment.succeeded') return { event, paid: null };
  const { invoiceId, paymentTx } = event.data;
  return { event, paid: { invoiceId, tx: paymentTx } };
}
