/**
 * Recent activity for the home screen, from real sources only:
 * - private payments: the receipts this browser saved when it paid (the chain has no payer address to search by),
 *   joined with the Noren server's invoice record;
 * - Arc: USDC transfers to and from this address on the Arc fork (shielding, faucet, USDC payments, credit draws);
 * - Robinhood Chain: USDG and Stock Token transfers on the Robinhood fork (swaps, stock payments, Earn, Borrow).
 * Nothing is invented: an empty wallet shows an empty list.
 */
import { erc20Abi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { api, type InvoiceView } from "../api";
import { STOCKS, USDG } from "../onchain";
import type { Wallet } from "./NorenApp";

export type Activity = {
  id: string; at: number; chain: "arc" | "robinhood";
  kind: "private-pay" | "pay" | "shield" | "in" | "out" | "credit" | "swap";
  title: string; detail: string; amount: string; sign: "+" | "−" | ""; tx?: Hex; private?: boolean;
};

const transferEv = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const fmt = (v: bigint, d: number, dp = 2) => (Number(v) / 10 ** d).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: d === 18 ? 5 : dp });

/** Invoice IDs this browser holds a receipt opening for (saved by the checkout and the app when they pay privately). */
export function receiptIds(): Hex[] {
  const out = new Set<Hex>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? "";
      const m = /noren:receipt:(0x[0-9a-f]{64})$/i.exec(k);
      if (m) out.add(m[1].toLowerCase() as Hex);
    }
  } catch { /* storage blocked: no private history in this browser */ }
  return [...out];
}

const tsCache = new Map<string, number>();
async function stamp(pub: PublicClient, chain: string, block: bigint) {
  const k = `${chain}:${block}`;
  if (!tsCache.has(k)) tsCache.set(k, Number((await pub.getBlock({ blockNumber: block })).timestamp));
  return tsCache.get(k)!;
}

async function transfers(pub: PublicClient, token: Address, me: Address, fromBlock: bigint) {
  const [ins, outs] = await Promise.all([
    pub.getLogs({ address: token, event: transferEv, args: { to: me }, fromBlock, toBlock: "latest" }),
    pub.getLogs({ address: token, event: transferEv, args: { from: me }, fromBlock, toBlock: "latest" }),
  ]);
  return [...ins.map((l) => ({ l, dir: "in" as const })), ...outs.map((l) => ({ l, dir: "out" as const }))];
}

export async function readActivity(w: Wallet, limit = 12): Promise<Activity[]> {
  const me = w.oc.address;
  const cfg = w.cfg;
  const out: Activity[] = [];
  const known: Record<string, string> = {
    [cfg.deployment.entrypoint.toLowerCase()]: "the privacy pool",
    [cfg.deployment.pool.toLowerCase()]: "the privacy pool",
    [cfg.merchant.toLowerCase()]: "the demo shop",
  };
  const line = w.oc.credit?.creditLine as Address | undefined;
  if (line) known[line.toLowerCase()] = "your credit line";

  // 1. Private payments from this browser's receipts.
  const ids = receiptIds();
  const views = (await Promise.all(ids.map((id) => api.invoice(id).catch(() => null)))).filter((v): v is InvoiceView => !!v && (v.status === "paid" || v.status === "refunded"));
  for (const v of views) {
    const at = Number(v.paidAt ?? v.createdAt ?? 0);
    out.push({ id: `p-${v.invoice.invoiceId}`, at: at > 1e12 ? Math.floor(at / 1000) : at, chain: "arc", kind: "private-pay", private: true,
      title: `Paid ${v.merchantName ?? "a Noren merchant"}`, detail: `${v.description ?? "Payment"} · privately${v.status === "refunded" ? " · refunded" : ""}`,
      amount: `${fmt(BigInt(v.invoice.amount), 6)} USDC`, sign: "−", tx: v.paymentTx as Hex | undefined });
  }

  // 2. Arc fork: USDC in and out of this address.
  const arc = w.oc.arcPublic() as unknown as PublicClient;
  const arcFrom = BigInt(cfg.deployment.deploymentBlock);
  const arcLogs = (await transfers(arc, cfg.deployment.usdc, me, arcFrom).catch(() => [])).sort((a, b) => Number(b.l.blockNumber! - a.l.blockNumber!)).slice(0, limit);
  for (const { l, dir } of arcLogs) {
    const other = (dir === "in" ? l.args.from! : l.args.to!).toLowerCase();
    const name = known[other];
    const kind: Activity["kind"] = name === "the privacy pool" ? "shield" : name === "your credit line" ? "credit" : dir === "in" ? "in" : "out";
    out.push({ id: `a-${l.transactionHash}-${l.logIndex}`, at: await stamp(arc, "arc", l.blockNumber!), chain: "arc", kind,
      title: kind === "shield" ? "Moved into your private balance" : kind === "credit" ? (dir === "in" ? "Credit line draw" : "Credit line repayment") : dir === "in" ? `Received USDC${name ? ` from ${name}` : ""}` : `Sent USDC${name ? ` to ${name}` : ""}`,
      detail: `Arc · ${name ?? `${other.slice(0, 6)}…${other.slice(-4)}`}`, amount: `${fmt(l.args.value!, 6)} USDC`, sign: dir === "in" ? "+" : "−", tx: l.transactionHash! });
  }

  // 3. Robinhood fork: USDG and Stock Tokens.
  if (w.oc.credit?.robinhoodRpc) {
    const { pub } = w.oc.robinhood();
    const rh = pub as unknown as PublicClient;
    const rhFrom = w.oc.credit.robinhoodFromBlock ? BigInt(w.oc.credit.robinhoodFromBlock) : 0n;
    const tokens: { sym: string; addr: Address; dec: number }[] = [{ sym: "USDG", addr: USDG, dec: 6 }, ...STOCKS.slice(0, 4).map((s) => ({ sym: s.sym, addr: s.token, dec: 18 }))];
    const logs = (await Promise.all(tokens.map(async (t) => (await transfers(rh, t.addr, me, rhFrom).catch(() => [])).map((x) => ({ ...x, t }))))).flat()
      .sort((a, b) => Number(b.l.blockNumber! - a.l.blockNumber!)).slice(0, limit);
    for (const { l, dir, t } of logs) {
      out.push({ id: `r-${l.transactionHash}-${l.logIndex}`, at: await stamp(rh, "rh", l.blockNumber!), chain: "robinhood", kind: dir === "in" ? "in" : "out",
        title: `${dir === "in" ? "Received" : "Sent"} ${t.sym}`, detail: `Robinhood Chain · ${(dir === "in" ? l.args.from! : l.args.to!).slice(0, 6)}…`,
        amount: `${fmt(l.args.value!, t.dec, t.dec === 6 ? 2 : 4)} ${t.sym}`, sign: dir === "in" ? "+" : "−", tx: l.transactionHash! });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

export { erc20Abi };
