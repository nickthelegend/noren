# Noren merchant API

Amounts are USDC base units (6 decimals). Merchant writes use `Authorization: Bearer <NOREN_MERCHANT_TOKEN>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/merchants/:addr/invoices` | Create draft with `amount`, `expiry`, optional private `description` (1–120 characters). |
| GET | `/merchants/:addr/invoices` | List invoices, newest first. |
| GET | `/invoices/:id` | Retrieve invoice, status, timestamps, transaction metadata, and `merchantName`. |
| POST | `/invoices/:id/bind` | Customer binds refund and receipt commitments. |
| POST | `/invoices/:id/pay` | Submit the customer's proof and pay. |
| POST | `/invoices/:id/refund` | Merchant refunds an amount to the private inbox. |
| GET, POST | `/merchants/:addr/profile` | Read or set merchant display name. |
| GET, POST | `/merchants/:addr/webhooks` | List or create webhook endpoints. Creation returns the secret once. |
| DELETE | `/merchants/:addr/webhooks/:id` | Delete an endpoint. |
| GET | `/merchants/:addr/events` | Read the newest 200 events and delivery attempts. |

Webhook events are `invoice.created`, `invoice.bound`, `payment.succeeded`, and `refund.succeeded`. Each delivery is JSON with `id`, `type`, `created`, and `data`. Verify the exact raw body against `noren-signature: t=<unix>,v1=<hex>`, where `v1` is hex HMAC-SHA256 using the endpoint secret over `${t}.${rawBody}`. Reject timestamps outside a 300 second window. Delivery retries up to three times after network errors or non-2xx responses, with 1 s then 4 s backoff.

```ts
import { createNoren, verifyWebhook } from '@noren/core/merchant';

const noren = createNoren({ server: 'http://127.0.0.1:8790', token: process.env.NOREN_MERCHANT_TOKEN, merchant: '0x...' });
const { invoice } = await noren.invoices.create({ amount: 7_500_000n, expiresIn: 1800, description: 'Flat white' });
await noren.profile.set('Takumi Coffee');
const endpoint = await noren.webhooks.create('https://example.com/hook');
// In your HTTP receiver, capture the raw request body before parsing JSON:
const event = await verifyWebhook(rawBody, signatureHeader, endpoint.secret);
```
