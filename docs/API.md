# Noren merchant API

Amounts are USDC base units (6 decimals). Merchant writes use `Authorization: Bearer <sk_test_…>` for a store, a SIWE session, or the existing dev merchant token. A key can act only on its store's on-chain merchant account; a session can act on stores owned by its signer. Secrets are shown once and stored only as SHA-256 hashes. The server keeps each store's relayer private key so it can submit private payments and refunds as that merchant.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/pricing/currencies` | Public supported fiat currencies, symbols, minor-unit decimals and Arc mainnet feed addresses. |
| GET | `/pricing/quote?currency=EUR&amount=690` | Public quote for 6.90 EUR; `amount` is a positive integer in fiat minor units. Returns USDC base units, rate, and both feed rounds. |
| GET | `/auth/nonce` | Issue a single-use SIWE nonce, valid 10 minutes. |
| POST | `/auth/siwe` | Submit `{message,signature}` (EIP-4361, Arc chain ID, allowed domain); get a 24-hour `sess_…` bearer token. |
| POST | `/auth/logout` | Revoke the bearer session. |
| POST, GET | `/stores` | Create a store with `{name,payout}` or list the session owner's stores. Creation returns one `sk_test_…` secret. |
| PATCH | `/stores/:id` | Change the store and merchant profile name. |
| POST, DELETE | `/stores/:id/keys`, `/stores/:id/keys/:keyId` | Rotate or revoke a store secret key. |
| GET | `/stores/by-key/:publishableKey` | Public lookup of `{merchant,name}`. |
| POST | `/merchants/:addr/invoices` | Create draft with `amount`, `expiry`, optional private `description`, `successUrl`, `cancelUrl`, and `metadata`. |
| GET | `/merchants/:addr/invoices` | List invoices, newest first. |
| GET | `/invoices/:id` | Retrieve invoice, status, timestamps, transaction metadata, and `merchantName`. |
| POST | `/invoices/:id/bind` | Customer binds refund and receipt commitments. |
| POST | `/invoices/:id/pay` | Submit the customer's proof and pay. |
| POST | `/invoices/:id/pay-usdc` | Submit `{txHash}` after a direct Arc USDC transfer of the exact invoice amount to the registered payout. |
| POST | `/invoices/:id/refund` | Merchant refunds an amount to the private inbox. |
| GET, POST | `/merchants/:addr/profile` | Read or set merchant display name. |
| GET, POST | `/merchants/:addr/webhooks` | List or create webhook endpoints. Creation returns the secret once. |
| DELETE | `/merchants/:addr/webhooks/:id` | Delete an endpoint. |
| GET | `/merchants/:addr/events` | Read the newest 200 events and delivery attempts. |
| GET | `/bridge/settlements/:address` | Public settlement entries for a merchant address and the desk address. |
| GET | `/bridge/quote?amountUsdg6=7500000&recipient=0x…` | Public live Relay and Across bridge quotes for 1–1,000,000 USDG. Errors are returned per route. |

`successUrl` and `cancelUrl` must be absolute HTTP(S) URLs of at most 2,048 characters. `metadata` is an object with at most 20 keys matching `[A-Za-z0-9_]{1,40}` and string values of at most 500 characters. These fields appear in invoice creation and retrieval; `metadata` is included in webhook event `data`. The hosted checkout may append `noren_invoice` and `order_id` (from `metadata.orderId`) to `successUrl` after payment.

Direct USDC payment verifies a successful Arc receipt with exactly one USDC `Transfer` to the merchant payout for the invoice amount, within the invoice's time window, and rejects reused transaction hashes. It is public: the merchant can see the payer's address. Only **Pay privately** hides the payer.

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
