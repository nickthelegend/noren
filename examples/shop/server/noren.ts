// How Aubelle added Noren. This file is the whole integration; the storefront shows it as-is.
import { createNoren, verifyWebhook } from '@noren/core/merchant';

export const noren = createNoren({
  server: process.env.NOREN_SERVER ?? '', // the Noren API
  merchant: process.env.NOREN_MERCHANT!, // the store's Noren merchant address
  token: process.env.NOREN_SECRET_KEY,   // the store's secret key, server-side only
});

// 1. "Checkout with Noren": one invoice for the bag total, then redirect to Noren's hosted checkout.
export async function createCheckout(order: { id: string; totalCents: number; summary: string }, shopUrl: string) {
  const { invoice, url } = await noren.invoices.create({
    amount: BigInt(order.totalCents) * 10_000n, // USD cents -> USDC (6 decimals)
    expiresIn: 30 * 60,
    description: order.summary,
    metadata: { orderId: order.id },
    successUrl: `${shopUrl}/#/order/${order.id}`,
    cancelUrl: `${shopUrl}/#/bag`,
  });
  return { invoiceId: invoice.invoiceId as string, url: url as string | undefined };
}

// 2. Noren calls the shop when the payment settles. Verify the signature before trusting a byte of it.
export async function readWebhook(rawBody: string, signature: string | null, secret: string) {
  const event = await verifyWebhook(rawBody, signature, secret);
  if (event.type !== 'payment.succeeded') return { event, paid: null };
  return { event, paid: { invoiceId: event.data.invoiceId, tx: event.data.paymentTx } };
}
