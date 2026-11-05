/** Talks to the Noren merchant server (packages/server). Every call is real; errors surface as readable messages. */
export const SERVER = (import.meta.env.VITE_NOREN_SERVER as string | undefined) ?? "http://127.0.0.1:8790";

export type Config = {
  chainId: number; rpcUrl: string; aspUrl: string; merchant: `0x${string}`;
  deployment: { chainId: number; deploymentBlock: string; usdc: `0x${string}`; entrypoint: `0x${string}`; pool: `0x${string}`; checkout: `0x${string}`; [k: string]: unknown };
};
export type InvoiceView = {
  invoice: { invoiceId: `0x${string}`; merchant: `0x${string}`; amount: string; expiry: string; refundPrecommitment?: string; receiptCommitment?: string };
  status: "draft" | "open" | "paid" | "refunded" | "expired" | string;
  paymentTx?: string; refundTx?: string; refundAmount?: string; createdAt?: number; [k: string]: unknown;
};

async function call<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init?.headers ?? {}) } });
  } catch {
    throw new Error(`Can't reach the Noren server at ${SERVER}. Start it with: pnpm dev:stack`);
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error ?? body?.message ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  config: () => call<Config>("/config"),
  faucet: (address: string) => call<{ hashes?: string[] }>("/dev/faucet", { method: "POST", body: JSON.stringify({ address }) }),
  listInvoices: (merchant: string) => call<InvoiceView[]>(`/merchants/${merchant}/invoices`),
  createInvoice: (merchant: string, amount: bigint, expiry: bigint, token: string) =>
    call<{ invoice: InvoiceView["invoice"]; paymentLinkPayload?: unknown }>(`/merchants/${merchant}/invoices`, { method: "POST", token, body: JSON.stringify({ amount: amount.toString(), expiry: expiry.toString() }) }),
  invoice: (id: string) => call<InvoiceView>(`/invoices/${id}`),
  bind: (id: string, refundPrecommitment: bigint, receiptCommitment: string) =>
    call<InvoiceView>(`/invoices/${id}/bind`, { method: "POST", body: JSON.stringify({ refundPrecommitment: refundPrecommitment.toString(), receiptCommitment }) }),
  pay: (id: string, payload: string) => call<InvoiceView>(`/invoices/${id}/pay`, { method: "POST", body: payload }),
  refund: (id: string, amount: bigint, token: string) => call<InvoiceView>(`/invoices/${id}/refund`, { method: "POST", token, body: JSON.stringify({ amount: amount.toString() }) }),
  events: () => new EventSource(`${SERVER}/events`),
};

export const usdc = (base: string | bigint | undefined) => base === undefined ? "–" : (Number(BigInt(base)) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const short = (h?: string, n = 6) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : "");
