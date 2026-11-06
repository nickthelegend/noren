# Noren merchant API

Amounts are USDC base units (6 decimals). Merchant writes use `Authorization: Bearer <NOREN_MERCHANT_TOKEN>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/pricing/currencies` | Public supported fiat currencies, symbols, minor-unit decimals and Arc mainnet feed addresses. |
| GET | `/pricing/quote?currency=EUR&amount=690` | Public quote for 6.90 EUR; `amount` is a positive integer in fiat minor units. Returns USDC base units, rate, and both feed rounds. |
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

For a fiat invoice, send `{ "currency": "EUR", "fiatAmount": "690", "expiry": "<Unix seconds>" }` instead of `amount`. The server reads Chainlink feeds on Arc mainnet, stores the quote on the invoice row, and fixes `invoice.amount` to the quoted six-decimal USDC amount until expiry. The creation response, invoice retrieval and list, and webhook `data` include `quote`; all bigint fields are decimal strings in JSON. Feed failures return HTTP 503 with a readable message. See [CHAINLINK.md](CHAINLINK.md) for the formula and network separation.

```ts
import { createNoren, verifyWebhook } from '@noren/core/merchant';

const noren = createNoren({ server: 'http://127.0.0.1:8790', token: process.env.NOREN_MERCHANT_TOKEN, merchant: '0x...' });
const { invoice } = await noren.invoices.create({ amount: 7_500_000n, expiresIn: 1800, description: 'Flat white' });
await noren.profile.set('Takumi Coffee');
const fiat = await noren.invoices.create({ currency: 'EUR', fiatAmount: 690n, expiresIn: 1800, description: 'Coffee' });
const liveQuote = await noren.pricing.quote('EUR', 690n);
const endpoint = await noren.webhooks.create('https://example.com/hook');
// In your HTTP receiver, capture the raw request body before parsing JSON:
const event = await verifyWebhook(rawBody, signatureHeader, endpoint.secret);
```
