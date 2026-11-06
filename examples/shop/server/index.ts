// Aubelle's backend: serves the storefront, keeps orders, and talks to Noren through server/noren.ts.
// Nothing here pretends: without the store's Noren credentials, checkout answers "Setup required".
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const { priceCart } = await import('../src/catalog.ts');
const { noren, createCheckout, readWebhook } = await import('./noren.ts');

const PORT = Number(process.env.SHOP_PORT ?? 8780);
const SHOP_URL = (process.env.SHOP_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const CHECKOUT_BASE = (process.env.NOREN_CHECKOUT_URL ?? 'http://127.0.0.1:5190').replace(/\/$/, '');
const DATA = join(root, 'data');
const REQUIRED = ['NOREN_SERVER', 'NOREN_MERCHANT', 'NOREN_SECRET_KEY'] as const;
const missing = () => REQUIRED.filter(k => !process.env[k]);

type Order = {
  id: string; createdAt: number; lines: { slug: string; size: string; qty: number; name: string; price: number }[]; totalCents: number;
  invoiceId: string; checkoutUrl: string; status: 'awaiting_payment' | 'paid' | 'expired' | 'refunded';
  paymentTx: string | null; paidAt: number | null; paidVia: 'webhook' | null; events: { id: string; type: string; at: number }[];
};
const orders = new Map<string, Order>();
let webhook: { id: string; secret: string; server: string; merchant: string } | null = null;
let webhookError: string | null = null;

async function load() {
  await mkdir(DATA, { recursive: true });
  for (const o of JSON.parse(await readFile(join(DATA, 'orders.json'), 'utf8').catch(() => '[]')) as Order[]) orders.set(o.id, o);
  webhook = JSON.parse(await readFile(join(DATA, 'webhook.json'), 'utf8').catch(() => 'null'));
}
async function saveJson(name: string, value: unknown) { const tmp = join(DATA, `${name}.tmp`); await writeFile(tmp, JSON.stringify(value, null, 2)); await rename(tmp, join(DATA, name)); }
const saveOrders = () => saveJson('orders.json', [...orders.values()]);

/** Registers this shop's webhook endpoint with Noren once and keeps the signing secret (returned only at creation) on disk. */
async function ensureWebhook() {
  if (missing().length) return;
  if (process.env.NOREN_WEBHOOK_SECRET) { webhook = { id: 'env', secret: process.env.NOREN_WEBHOOK_SECRET, server: process.env.NOREN_SERVER!, merchant: process.env.NOREN_MERCHANT! }; return; }
  try {
    const listed = await noren.webhooks.list() as { id: string; url: string }[];
    const same = webhook && webhook.server === process.env.NOREN_SERVER && webhook.merchant.toLowerCase() === process.env.NOREN_MERCHANT!.toLowerCase();
    if (same && listed.some(e => e.id === webhook!.id)) { webhookError = null; return; }
    const created = await noren.webhooks.create(`${SHOP_URL}/api/noren/webhook`);
    webhook = { id: created.id, secret: created.secret, server: process.env.NOREN_SERVER!, merchant: process.env.NOREN_MERCHANT! };
    await saveJson('webhook.json', webhook);
    webhookError = null;
    console.log(`Registered Noren webhook ${created.id} -> ${SHOP_URL}/api/noren/webhook`);
  } catch (e: any) { webhookError = `Could not register the Noren webhook: ${e.message}`; console.error(webhookError); }
}

let fx: { eurPerUsd: number; at: number; feed: string; updatedAt: string } | null = null;
async function eurRate() {
  if (fx && Date.now() - fx.at < 5 * 60_000) return fx;
  // Noren prices fiat with Chainlink EUR/USD and USDC/USD on Arc mainnet. 100.00 EUR -> USDC gives the rate.
  const quote = await noren.pricing.quote('EUR', 10_000n) as any;
  fx = { eurPerUsd: 100 / (Number(quote.usdcAmount) / 1e6), at: Date.now(), feed: quote.fiatUsd.feed, updatedAt: quote.fiatUsd.updatedAt };
  return fx;
}

function send(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function rawBody(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const c of req) { size += c.length; if (size > 256_000) throw new Error('Body too large'); chunks.push(c); } return Buffer.concat(chunks).toString('utf8'); }

/** Reads the invoice back from Noren so the order page shows Noren's own status, not just what the shop remembers. */
async function refresh(order: Order) {
  if (order.status !== 'awaiting_payment' || missing().length) return order;
  try {
    const row = await noren.invoices.retrieve(order.invoiceId) as any;
    if (row.status === 'paid' && order.status === 'awaiting_payment') { order.status = 'paid'; order.paymentTx = row.paymentTx ?? order.paymentTx; order.paidAt ??= Math.floor(Date.now() / 1000); await saveOrders(); }
    else if (row.status === 'expired') { order.status = 'expired'; await saveOrders(); }
  } catch (e: any) { console.error(`Could not read invoice ${order.invoiceId}: ${e.message}`); }
  return order;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
async function serveStatic(path: string, res: ServerResponse) {
  const dist = join(root, 'dist');
  const file = normalize(join(dist, decodeURIComponent(path)));
  const target = file.startsWith(dist) && existsSync(file) && !file.endsWith('/') && extname(file) ? file : join(dist, 'index.html');
  if (!existsSync(target)) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('Storefront not built yet: run pnpm build in examples/shop'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': target.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(await readFile(target));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', SHOP_URL);
  try {
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return send(res, 200, { ready: missing().length === 0 && !!webhook, missing: missing(), webhookError, server: process.env.NOREN_SERVER ?? null, merchant: process.env.NOREN_MERCHANT ?? null, checkoutBase: CHECKOUT_BASE });
    }
    if (url.pathname === '/api/fx' && req.method === 'GET') {
      if (!process.env.NOREN_SERVER) return send(res, 503, { error: 'Setup required: NOREN_SERVER' });
      return send(res, 200, await eurRate());
    }
    if (url.pathname === '/api/checkout' && req.method === 'POST') {
      if (missing().length) return send(res, 503, { error: `Setup required: ${missing().join(', ')}` });
      if (!webhook) { await ensureWebhook(); if (!webhook) return send(res, 503, { error: webhookError ?? 'Setup required: Noren webhook' }); }
      const { lines, total } = priceCart(JSON.parse(await rawBody(req)).lines);
      const id = `AUB-${randomBytes(3).toString('hex').toUpperCase()}`;
      const items = lines.reduce((n, l) => n + l.qty, 0);
      const summary = `Aubelle order ${id}: ${lines[0].name}${lines.length > 1 ? ` and ${items - lines[0].qty} more` : lines[0].qty > 1 ? ` x${lines[0].qty}` : ''}`.slice(0, 120);
      const { invoiceId, url: hosted } = await createCheckout({ id, totalCents: total, summary }, SHOP_URL);
      const checkoutUrl = hosted ?? `${CHECKOUT_BASE}/#/pay/${invoiceId}`;
      const order: Order = { id, createdAt: Math.floor(Date.now() / 1000), lines, totalCents: total, invoiceId, checkoutUrl, status: 'awaiting_payment', paymentTx: null, paidAt: null, paidVia: null, events: [] };
      orders.set(id, order); await saveOrders();
      console.log(`Order ${id}: ${total} cents, Noren invoice ${invoiceId}`);
      return send(res, 201, { orderId: id, checkoutUrl });
    }
    const orderMatch = /^\/api\/orders\/(AUB-[0-9A-F]{6})$/.exec(url.pathname);
    if (orderMatch && req.method === 'GET') {
      const order = orders.get(orderMatch[1]);
      if (!order) return send(res, 404, { error: 'We could not find that order' });
      return send(res, 200, await refresh(order));
    }
    if (url.pathname === '/api/noren/webhook' && req.method === 'POST') {
      const body = await rawBody(req);
      if (!webhook) return send(res, 503, { error: 'Webhook secret not configured' });
      let result;
      try { result = await readWebhook(body, req.headers['noren-signature'] as string ?? null, webhook.secret); }
      catch (e: any) { console.warn(`Rejected webhook: ${e.message}`); return send(res, 400, { error: e.message }); }
      const { event, paid } = result;
      const order = [...orders.values()].find(o => o.invoiceId.toLowerCase() === event.data.invoiceId.toLowerCase());
      if (order && !order.events.some(e => e.id === event.id)) {
        order.events.push({ id: event.id, type: event.type, at: event.created });
        if (paid) { order.status = 'paid'; order.paymentTx = paid.tx; order.paidAt = event.created; order.paidVia = 'webhook'; console.log(`Order ${order.id} paid (webhook ${event.id}, tx ${paid.tx})`); }
        if (event.type === 'refund.succeeded') order.status = 'refunded';
        await saveOrders();
      }
      return send(res, 200, { received: true });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(url.pathname, res);
  } catch (e: any) {
    const status = typeof e?.status === 'number' && e.status >= 400 ? (e.status === 401 || e.status === 403 ? 502 : e.status) : 400;
    console.error(`${req.method} ${url.pathname}: ${e.message}`);
    return send(res, status, { error: e.status === 401 || e.status === 403 ? `Noren rejected the store's secret key (${e.message})` : e.message });
  }
});

await load();
await ensureWebhook();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Aubelle on ${SHOP_URL}`);
  if (missing().length) console.log(`Setup required: ${missing().join(', ')} (copy .env.example to .env)`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
