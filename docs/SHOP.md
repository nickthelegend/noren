# Aubelle: a demo shop that takes payment with Noren

`examples/shop` is a small women's fashion boutique, **Aubelle**, built to show how any shop adds Noren checkout. It is a separate merchant from Noren: it talks to Noren only through the public SDK (`@noren/core/merchant`) with its own store key, exactly as a third-party shop would.

- **Storefront** (React + Vite): editorial home, a dress grid filtered by length, shade and size, product pages with size selection, a bag drawer and bag page, and an order page. Fonts are self-hosted with Fontsource (Geist and Instrument Serif), so the page makes no Google Fonts requests.
- **Backend** (Node, `server/index.ts`, port 8780): re-prices the bag from the catalogue, creates the Noren invoice, receives Noren's webhook and serves the built storefront.
- **The integration** is one file, [`examples/shop/server/noren.ts`](../examples/shop/server/noren.ts). The storefront shows the same file in its "How this shop added Noren" panel (`/#/noren`), imported with Vite's `?raw`, so the panel can't drift from the code.

## The integration

```ts
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
```

The backend (`server/index.ts`) wires those two functions to `POST /api/checkout` and `POST /api/noren/webhook`:

1. **Checkout.** The browser sends only `{ slug, size, qty }` lines. The backend prices them from `src/catalog.ts`, creates order `AUB-xxxxxx`, calls `createCheckout`, and redirects the shopper to Noren's hosted checkout (`url` from the API, or `${NOREN_CHECKOUT_URL}/#/pay/<invoiceId>`).
2. **Webhook.** On first start the backend registers `${SHOP_URL}/api/noren/webhook` with `noren.webhooks.create` and keeps the signing secret (Noren returns it once) in `data/webhook.json` (gitignored). Each delivery is checked with `verifyWebhook` against the raw body and the `noren-signature` header; a bad signature, an edited body or a stale timestamp gets HTTP 400 and changes nothing. A verified `payment.succeeded` marks the order paid with Noren's transaction hash.
3. **Order page.** `/#/order/<id>` polls the backend, which also reads the invoice back with `noren.invoices.retrieve`, so the page shows Noren's own status and transaction. It says "Signed Noren webhook ✓ signature verified" only when the order was marked paid by a verified webhook.

Prices are in USD and charged as USDC 1:1 (cents × 10⁴ base units). The euro estimate next to each price comes from `noren.pricing.quote('EUR', …)`, which reads Chainlink EUR/USD and USDC/USD on Arc mainnet; if the quote fails, the euro line is hidden rather than guessed.

## Run it

The shop needs a running Noren server (`pnpm dev:all` from the repo root, owned by the app/web agent: API on 8790, hosted checkout on 5190) and a Noren store with a secret key (Noren Merchant > Developers).

```sh
cd examples/shop
pnpm install --ignore-workspace     # its own lockfile; @noren/core is linked from packages/core
cp .env.example .env                # fill NOREN_SERVER, NOREN_MERCHANT, NOREN_SECRET_KEY, or on a local stack:
pnpm connect:local                  # SIWE sign-in + POST /stores "Aubelle" on the LOCAL Noren server, keys into .env
pnpm build                          # builds the storefront into dist/
pnpm start                          # backend + storefront on http://127.0.0.1:8780
pnpm test                           # 5 tests: catalogue pricing, webhook signature accept/reject
```

For storefront work, `pnpm dev` runs Vite on 8781 and proxies `/api` to the backend on 8780.

| Variable | Meaning |
| --- | --- |
| `NOREN_SERVER` | Noren API base URL, e.g. `http://127.0.0.1:8790` |
| `NOREN_MERCHANT` | The store's merchant address on Noren |
| `NOREN_SECRET_KEY` | The store's secret key (`sk_test_…`). Server-side only, never sent to the browser |
| `NOREN_CHECKOUT_URL` | Hosted checkout origin, used when the API does not return a checkout URL (default `http://localhost:5190`) |
| `NOREN_WEBHOOK_SECRET` | Optional: signing secret of an existing endpoint; otherwise the shop registers its own |
| `SHOP_PORT`, `SHOP_URL` | Where the shop listens and the public base for redirects and the webhook (default 8780) |

`pnpm connect:local` does locally what a merchant does in Noren Merchant: it signs in with Ethereum (SIWE) as Anvil's published dev account #9, creates the store "Aubelle" with `POST /stores` (Noren registers the store's merchant account on the forked NorenCheckout), and writes the returned secret key into `.env` without printing it. It refuses any Noren server that is not on 127.0.0.1 or localhost.

Without `NOREN_SERVER`, `NOREN_MERCHANT` and `NOREN_SECRET_KEY`, the bag shows **Setup required** with the missing variable names and `POST /api/checkout` answers HTTP 503. Nothing is simulated.

## Photos

The fifteen product photos and two editorial images were generated with ChatGPT image generation (studio photos on a dress form or a flat lay, no faces, no brands, no text) and converted to WebP. The dresses are imagined; the footer says so.

## End-to-end evidence (local forks, Nov 6 2026)

Both runs used the real Noren stack from `pnpm dev:all` (Arc testnet fork on 8645, Noren server on 8790, hosted checkout on 5190), a store created with `pnpm connect:local`, and the shop on 8780. Transaction hashes are on the **local Arc fork**, not on Arc testnet.

| Viewport | Order | Bag | Noren invoice | Payment tx (fork) | How it was confirmed |
| --- | --- | --- | --- | --- | --- |
| 1440 px | `AUB-5A309F` | Margot Wrap, M, $198 | `0xcf7230…a189fa` | `0x044db79f…32ea0c7f` (status 1, 198 USDC to the store's payout) | `payment.succeeded` webhook `evt_aaafca4a862b4a4d`, signature verified |
| 375 px | `AUB-2643C8` | Amélie Gingham, S, $148 | `0xb695d1…042616` | `0x3412b00f…6dae7b6b` (status 1) | `payment.succeeded` webhook `evt_349a77c747fc6d1e`, signature verified, method `usdc` |

Flow in both: product page → size → bag drawer → **Checkout with Noren** → the shop backend creates the invoice (description, `metadata.orderId`, `successUrl`, `cancelUrl`) → Noren's hosted checkout shows "Pay Aubelle" → **Pay with USDC** → Noren redirects to `successUrl` → the order page shows Paid, the Noren payment ID, the transaction and "Signed Noren webhook ✓ signature verified". "Back to Aubelle" on the checkout returns to the bag with the items intact (`cancelUrl`).

The checkout's test faucet gives 50 USDC once per wallet and every Aubelle dress costs more, so for these runs the test wallet was topped up on the fork with `ForkUSDC.mint` (the fork-only USDC shim the faucet itself uses).
