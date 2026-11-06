/**
 * Network switch: "Local fork" (the full stack from pnpm dev:all) or "Arc testnet (live)", the public deployment
 * recorded in deployments/5042002.json (contracts, the live private payment and refund, the CRE writes).
 * Only Arc has a live deployment: Robinhood Chain, fiat invoices and the browser checkout run on the forks.
 */
import { useEffect, useState } from "react";
import { createPublicClient, http, parseAbi, toFunctionSelector } from "viem";
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

/**
 * Freshness of the live NorenRateOracle on Arc testnet. quote() reverts StalePrice once a stored Chainlink round is older
 * than maxAge, which is an expected state between CRE runs, not an app error: the UI says "price stale" and how to refresh.
 */
const oracleAbi = parseAbi([
  "function quote(string currency, uint256 fiatAmount) view returns (uint256 usdcAmount, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId, uint256 oldestUpdatedAt)",
  "function maxAge() view returns (uint256)",
  "error StalePrice(bytes3 currency, uint256 updatedAt, uint256 maxAge)",
]);
export type OracleFreshness = { state: "fresh"; usdcFor100Eur: bigint; ageSec: number; maxAge: number } | { state: "stale"; updatedAt: number; maxAge: number } | { state: "unknown"; error: string };
export async function liveOracleFreshness(): Promise<OracleFreshness> {
  const c = createPublicClient({ transport: http(LIVE.rpcUrl) });
  try {
    const [q, maxAge, block] = await Promise.all([
      c.readContract({ address: LIVE.oracle, abi: oracleAbi, functionName: "quote", args: ["EUR", 10_000n] }),
      c.readContract({ address: LIVE.oracle, abi: oracleAbi, functionName: "maxAge" }),
      c.getBlock(),
    ]);
    return { state: "fresh", usdcFor100Eur: q[0], ageSec: Number(block.timestamp - q[3]), maxAge: Number(maxAge) };
  } catch (e) {
    const err = e as { walk?: (f: (x: unknown) => boolean) => unknown; shortMessage?: string; message?: string };
    const rev = err.walk?.((x) => !!(x as { data?: { errorName?: string } })?.data?.errorName) as { data?: { errorName: string; args: readonly unknown[] } } | undefined;
    if (rev?.data?.errorName === "StalePrice") return { state: "stale", updatedAt: Number(rev.data.args[1] as bigint), maxAge: Number(rev.data.args[2] as bigint) };
    return { state: "unknown", error: (err.shortMessage ?? err.message ?? String(e)).slice(0, 160) };
  }
}
