/** Talks to the Noren merchant server (packages/server). Every call is real; errors surface as readable messages. */
export const SERVER = (import.meta.env.VITE_NOREN_SERVER as string | undefined) ?? "http://127.0.0.1:8790";

export type Config = {
  chainId: number; rpcUrl: string; aspUrl: string; merchant: `0x${string}`;
  deployment: { chainId: number; deploymentBlock: string; usdc: `0x${string}`; entrypoint: `0x${string}`; pool: `0x${string}`; checkout: `0x${string}`; [k: string]: unknown };
};
export type InvoiceView = {
  invoice: { invoiceId: `0x${string}`; merchant: `0x${string}`; amount: string; expiry: string; refundPrecommitment?: string; receiptCommitment?: string };
  status: "draft" | "open" | "paid" | "refunded" | "expired" | string;
  description?: string; merchantName?: string | null;
  createdAt?: number | string; boundAt?: number | string; paidAt?: number | string; refundedAt?: number | string;
  paymentTx?: string; refundTx?: string; refundAmount?: string; paymentGasUsed?: string; refundGasUsed?: string; paymentBlock?: string;
  /** How the customer paid: the private pool, a credit line (backed by stock on Robinhood Chain, bridged by Chainlink CRE), or stocks. */
  method?: "private" | "credit" | "stocks"; creditLineId?: `0x${string}`;
  /** NorenRateOracle.verifyQuote at the quote's rounds (rates written on Arc by the CRE pricing workflow). */
  rateCheck?: { oracle: `0x${string}`; verified: boolean; detail: string };
  stock?: { asset: `0x${string}`; assetIn: string; usdgOut: string; priceUsd8: string; chainId: number };
  [k: string]: unknown;
};
export type Webhook = { id: string; url: string; createdAt?: number | string; secret?: string };
export type Delivery = { endpointId: string; url: string; attempt: number; status: number | null; ok: boolean; ms?: number; error?: string; at?: number | string };
export type NorenEvent = { id: string; type: string; created: number | string; data: Record<string, unknown>; deliveries?: Delivery[] };

async function call<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init?.headers ?? {}) } });
  } catch {
    throw new Error(`Can't reach the Noren server at ${SERVER}. Start it with: pnpm dev:stack`);
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(body?.error ?? body?.message ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  config: () => call<Config>("/config"),
  bridgeLog: () => call<{ source: string; written?: string; event: string; ms: number; handler: number; skipped?: string; error?: string }[]>("/credit/bridge"),
  mirrorOnRobinhood: (id: string) => call<{ gateway: `0x${string}`; merchant: `0x${string}`; invoiceId: `0x${string}`; amountUsdg: string; expiry: string }>(`/invoices/${id}/robinhood`, { method: "POST" }),
  robinhoodFaucet: (address: string) => call<Record<string, string>>("/dev/robinhood-faucet", { method: "POST", body: JSON.stringify({ address }) }),
  faucet: (address: string) => call<{ hashes?: string[] }>("/dev/faucet", { method: "POST", body: JSON.stringify({ address }) }),
  listInvoices: (merchant: string) => call<InvoiceView[]>(`/merchants/${merchant}/invoices`),
  createInvoice: (merchant: string, amount: bigint, expiry: bigint, token: string, description?: string) =>
    call<{ invoice: InvoiceView["invoice"]; paymentLinkPayload?: unknown }>(`/merchants/${merchant}/invoices`, { method: "POST", token, body: JSON.stringify({ amount: amount.toString(), expiry: expiry.toString(), ...(description ? { description } : {}) }) }),
  invoice: (id: string) => call<InvoiceView>(`/invoices/${id}`),
  bind: (id: string, refundPrecommitment: bigint, receiptCommitment: string) =>
    call<InvoiceView>(`/invoices/${id}/bind`, { method: "POST", body: JSON.stringify({ refundPrecommitment: refundPrecommitment.toString(), receiptCommitment }) }),
  pay: (id: string, payload: string) => call<InvoiceView>(`/invoices/${id}/pay`, { method: "POST", body: payload }),
  refund: (id: string, amount: bigint, token: string) => call<InvoiceView>(`/invoices/${id}/refund`, { method: "POST", token, body: JSON.stringify({ amount: amount.toString() }) }),
  profile: (merchant: string) => call<{ merchant: string; name: string | null }>(`/merchants/${merchant}/profile`),
  setProfile: (merchant: string, name: string, token: string) => call<{ merchant: string; name: string | null }>(`/merchants/${merchant}/profile`, { method: "POST", token, body: JSON.stringify({ name }) }),
  webhooks: (merchant: string, token: string) => call<Webhook[]>(`/merchants/${merchant}/webhooks`, { token }),
  addWebhook: (merchant: string, url: string, token: string) => call<Webhook>(`/merchants/${merchant}/webhooks`, { method: "POST", token, body: JSON.stringify({ url }) }),
  deleteWebhook: (merchant: string, id: string, token: string) => call<{ deleted: boolean }>(`/merchants/${merchant}/webhooks/${id}`, { method: "DELETE", token }),
  eventLog: (merchant: string, token: string) => call<NorenEvent[]>(`/merchants/${merchant}/events`, { token }),
  events: () => new EventSource(`${SERVER}/events`),
};

export const usdc = (base: string | bigint | undefined) => base === undefined ? "–" : (Number(BigInt(base)) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const short = (h?: string, n = 6) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : "");
export const toBase = (s: string) => BigInt(Math.round(Number(s || "0") * 1e6));
export const secs = (v?: number | string) => (v === undefined || v === null || v === "" ? undefined : Number(v));
export const when = (v?: number | string) => {
  const s = secs(v); if (!s) return "–";
  const d = new Date(s * 1000), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
