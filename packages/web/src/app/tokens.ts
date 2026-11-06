/** Tokens the Noren app trades on Robinhood Chain (real mainnet addresses, served from the local snapshot fork). */
import type { Address } from "viem";
import { STOCKS, USDG } from "../onchain";

export const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const ETH_FEED: Address = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";

export type Token = {
  sym: string; name: string; decimals: number;
  /** The ERC-20 used on-chain. ETH is wrapped to WETH before a swap and unwrapped after one. */
  address: Address; native?: boolean; feed?: Address; color: string; kind: "stable" | "eth" | "stock";
};

const STOCK_COLORS: Record<string, string> = { NVDA: "#4f7a2a", TSLA: "#b3412c", AAPL: "#3a3f4b", SPY: "#2c3d7c", MSFT: "#2f6f9f", AMZN: "#c4661f", GOOGL: "#3f6fd8", META: "#3157a8" };

export const TOKENS: Token[] = [
  { sym: "USDG", name: "Global Dollar", decimals: 6, address: USDG, color: "#2f7a55", kind: "stable" },
  { sym: "ETH", name: "Ether", decimals: 18, address: WETH, native: true, feed: ETH_FEED, color: "#5b5f8f", kind: "eth" },
  ...STOCKS.map((s) => ({ sym: s.sym, name: s.name, decimals: 18, address: s.token, feed: s.feed, color: STOCK_COLORS[s.sym] ?? "#6d6890", kind: "stock" as const })),
];
export const tokenBy = (sym: string) => TOKENS.find((t) => t.sym === sym)!;
export const USDG_TOKEN = TOKENS[0];

export function fmtUnits(v: bigint, decimals: number, dp = 4) {
  const n = Number(v) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? Math.max(dp, 6) : dp });
}
export function parseAmount(s: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  try { const v = BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0"); return v > 0n ? v : null; } catch { return null; }
}
