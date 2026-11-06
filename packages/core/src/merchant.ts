export class NorenError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'NorenError'; }
}
export type NorenOptions = { server: string; token?: string; merchant: string };
export type WebhookEvent = { id: string; type: string; created: number; data: { invoiceId: string; amount: string; status: string; description: string | null; metadata?: Record<string, string> | null; paymentTx: string | null; refundTx: string | null; refundAmount: string | null; quote?: import('./pricing.ts').UsdcQuote | null } };
export function createNoren({ server, token, merchant }: NorenOptions) {
  const base = server.replace(/\/$/, '');
  const merchantPath = `/merchants/${merchant}`;
  async function request(path: string, method = 'GET', value?: unknown): Promise<any> {
    let response: Response;
    try { response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) }); }
    catch (error: any) { throw new NorenError(error?.message ?? 'Network request failed', 0); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new NorenError(result.error ?? `HTTP ${response.status}`, response.status);
    return result;
  }
  return {
    invoices: {
      async create(input: ({ amount: bigint; currency?: never; fiatAmount?: never } | { amount?: never; currency: string; fiatAmount: bigint }) & { expiresIn: number; description?: string; successUrl?: string; cancelUrl?: string; metadata?: Record<string, string> }) { const expiry = Math.floor(Date.now() / 1000) + input.expiresIn; const pricing = input.currency === undefined ? { amount: input.amount!.toString() } : { currency: input.currency, fiatAmount: input.fiatAmount!.toString() }; const result = await request(`${merchantPath}/invoices`, 'POST', { ...pricing, expiry: expiry.toString(), description: input.description, successUrl: input.successUrl, cancelUrl: input.cancelUrl, metadata: input.metadata }); return { invoice: result.invoice, ...(result.quote ? { quote: result.quote } : {}), ...(result.url ? { url: result.url } : {}), ...(result.successUrl ? { successUrl: result.successUrl } : {}), ...(result.cancelUrl ? { cancelUrl: result.cancelUrl } : {}), ...(result.metadata ? { metadata: result.metadata } : {}) }; },
      list: () => request(`${merchantPath}/invoices`),
      retrieve: (id: string) => request(`/invoices/${id}`),
      refund: (id: string, amount: bigint) => request(`/invoices/${id}/refund`, 'POST', { amount: amount.toString() }),
    },
    profile: { get: () => request(`${merchantPath}/profile`), set: (name: string) => request(`${merchantPath}/profile`, 'POST', { name }) },
    webhooks: { create: (url: string) => request(`${merchantPath}/webhooks`, 'POST', { url }), list: () => request(`${merchantPath}/webhooks`), del: (id: string) => request(`${merchantPath}/webhooks/${id}`, 'DELETE'), delete: (id: string) => request(`${merchantPath}/webhooks/${id}`, 'DELETE') },
    events: { list: () => request(`${merchantPath}/events`) },
    pricing: { quote: (currency: string, fiatAmount: bigint) => request(`/pricing/quote?currency=${encodeURIComponent(currency)}&amount=${fiatAmount.toString()}`), currencies: () => request('/pricing/currencies') },
  };
}
export async function verifyWebhook(rawBody: string, signatureHeader: string | null, secret: string, { toleranceSeconds = 300 }: { toleranceSeconds?: number } = {}): Promise<WebhookEvent> {
  const timestamp = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader ?? '');
  if (!timestamp) throw new Error('Invalid webhook signature header');
  const t = Number(timestamp[1]);
  if (!Number.isSafeInteger(t) || Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) throw new Error('Webhook timestamp is stale');
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${rawBody}`)));
  const received = new Uint8Array(timestamp[2].match(/../g)!.map(part => parseInt(part, 16)));
  let difference = expected.length ^ received.length;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ (received[i] ?? 0);
  if (difference !== 0) throw new Error('Invalid webhook signature');
  try { return JSON.parse(rawBody) as WebhookEvent; } catch { throw new Error('Invalid webhook JSON'); }
}
