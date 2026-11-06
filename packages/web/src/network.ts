/**
 * Network switch: "Local fork" (the full stack from pnpm dev:all) or "Arc testnet (live)", the public deployment
 * recorded in deployments/5042002.json (contracts, the live private payment and refund, the CRE writes).
 * Only Arc has a live deployment: Robinhood Chain, fiat invoices and the browser checkout run on the forks.
 */
import { useEffect, useState } from "react";
import { toFunctionSelector } from "viem";
import live from "../../../deployments/5042002.json";

export type Net = "fork" | "live";
const KEY = "noren.network";
const subs = new Set<(n: Net) => void>();
const read = (): Net => { try { return localStorage.getItem(KEY) === "live" ? "live" : "fork"; } catch { return "fork"; } };
export function setNet(n: Net) { try { localStorage.setItem(KEY, n); } catch { /* tab-only */ } subs.forEach((f) => f(n)); }
export function useNet(): [Net, (n: Net) => void] {
  const [n, set] = useState<Net>(read);
  useEffect(() => { subs.add(set); return () => { subs.delete(set); }; }, []);
  return [n, setNet];
}

type Step = { step: string; tx: string; note?: string; gasUsed?: string; explorer?: string; timestamp?: string };
const L = live as unknown as {
  chainId: number; rpcUrl: string; explorer: string; checkout: `0x${string}`; pool: `0x${string}`; entrypoint: `0x${string}`; usdc: `0x${string}`;
  live: { e2e: { invoice: { invoiceId: `0x${string}`; amountUsdc6: string }; payout: `0x${string}`; proofSeconds: number; finishedAt: string; steps: Step[] };
    pricing: { oracle: `0x${string}`; simulateTx: string; quoteEur100: string; quoteJpy10000: string };
    credit: { creditLine: `0x${string}`; starterTx: string } };
};
export const LIVE = {
  chainId: L.chainId, rpcUrl: L.rpcUrl, explorer: L.explorer, checkout: L.checkout, pool: L.pool, entrypoint: L.entrypoint, usdc: L.usdc,
  oracle: L.live.pricing.oracle, creditLine: L.live.credit.creditLine, e2e: L.live.e2e, pricing: L.live.pricing, credit: L.live.credit,
};
export const txUrl = (h: string) => `${LIVE.explorer}/tx/${h}`;
export const addrUrl = (a: string) => `${LIVE.explorer}/address/${a}`;

/** Live reads from the public Arc testnet RPC (no key). */
async function call(to: string, data: string) {
  const r = await fetch(LIVE.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result as string;
}
const pad = (h: string) => h.toLowerCase().replace(/^0x/, "").padStart(64, "0");
export async function liveFacts() {
  const [paid, payoutBal, poolBal, block] = await Promise.all([
    call(LIVE.checkout, toFunctionSelector("paid(bytes32)") + pad(LIVE.e2e.invoice.invoiceId)).then((x) => BigInt(x) === 1n),
    call(LIVE.usdc, toFunctionSelector("balanceOf(address)") + pad(LIVE.e2e.payout)).then(BigInt),
    call(LIVE.usdc, toFunctionSelector("balanceOf(address)") + pad(LIVE.pool)).then(BigInt),
    fetch(LIVE.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }).then((r) => r.json()).then((j) => BigInt(j.result)),
  ]);
  return { paid, payoutBal, poolBal, block };
}
