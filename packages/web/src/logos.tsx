/**
 * Real logos for every token, chain and protocol Noren shows. Every file is self-hosted in public/logos (no request
 * to a third party); public/logos/SOURCES.md records where each one came from. Anything without a file is drawn as a
 * neutral circle with its initials, never an invented logo.
 */
import { useState, type CSSProperties } from "react";

type Spec = { file: string; name: string; bg?: string; pad?: number };
const S = (file: string, name: string, bg?: string, pad?: number): Spec => ({ file: `/logos/${file}`, name, bg, pad });

export const LOGOS: Record<string, Spec> = {
  // tokens
  USDC: S("usdc.svg", "USDC"), EURC: S("eurc.svg", "EURC"), USDT: S("usdt.svg", "Tether USDt"), USDG: S("usdg.svg", "Global Dollar"),
  ETH: S("eth.svg", "Ether", "#eceefb", 0.17), WETH: S("eth.svg", "Wrapped Ether", "#eceefb", 0.17),
  // Stock Tokens: each company's own logo
  NVDA: S("nvda.svg", "NVIDIA", "#fff", 0.09), TSLA: S("tsla.png", "Tesla", "#171a20", 0.24), AAPL: S("aapl.svg", "Apple", "#fff", 0.2),
  SPY: S("spy.svg", "State Street SPDR S&P 500", "#fff", 0.17), MSFT: S("msft.svg", "Microsoft", "#fff", 0.25), GOOGL: S("googl.png", "Alphabet (Google)", "#fff", 0.16),
  AMZN: S("amzn.png", "Amazon"), META: S("meta.png", "Meta", "#fff", 0.13),
  // chains
  ARC: S("arc.svg", "Arc"), ROBINHOOD: S("robinhood-chain.png", "Robinhood Chain"),
  // protocols
  CHAINLINK: S("chainlink.svg", "Chainlink", "#fff", 0.18), "1INCH": S("1inch.svg", "1inch", "#fff", 0.12), UNISWAP: S("uniswap.svg", "Uniswap", "#fff", 0.07),
  WORLD: S("world.svg", "World", "#fff", 0.13), "0G": S("0g.svg", "0G", "#0b0b0f", 0.2), CIRCLE: S("circle.svg", "Circle", "#fff", 0.04),
  RELAY: S("relay.svg", "Relay", "#fff", 0.12), ACROSS: S("across.svg", "Across"), KOHAKU: S("kohaku.png", "Kohaku (Ethereum Foundation)", "#fff", 0.04),
};

/** Logo key for a symbol or name as the UI writes it ("Uniswap v4", "1inch Aqua", "Robinhood Chain", "Arc testnet"…). */
export function logoKey(s: string): string | undefined {
  const u = s.toUpperCase();
  if (LOGOS[u]) return u;
  if (/^ROBINHOOD/.test(u)) return "ROBINHOOD";
  if (/^ARC\b/.test(u)) return "ARC";
  if (/1INCH|AQUA/.test(u)) return "1INCH";
  if (/UNISWAP/.test(u)) return "UNISWAP";
  if (/CHAINLINK|\bCRE\b/.test(u)) return "CHAINLINK";
  if (/WORLD/.test(u)) return "WORLD";
  if (/^0G\b/.test(u)) return "0G";
  if (/KOHAKU|PRIVACY POOL/.test(u)) return "KOHAKU";
  if (/^RELAY/.test(u)) return "RELAY";
  if (/^ACROSS/.test(u)) return "ACROSS";
  if (/^CIRCLE/.test(u)) return "CIRCLE";
  return undefined;
}

/**
 * A round logo at 16/20/24 px (any size works). `id` is a token symbol, chain or protocol (see logoKey). Decorative by
 * default: the symbol is always written next to it; pass `label` when it stands alone.
 */
export function Mark({ id, size = 20, label, className = "", style }: { id: string; size?: number; label?: string; className?: string; style?: CSSProperties }) {
  const key = logoKey(id);
  const spec = key ? LOGOS[key] : undefined;
  const [broken, setBroken] = useState(false);
  const box: CSSProperties = { width: size, height: size, ...style };
  if (!spec || broken) {
    const init = id.replace(/[^A-Za-z0-9]/g, "").slice(0, id.length > 3 ? 2 : 3).toUpperCase() || "?";
    return <span className={`lg-mark lg-none ${className}`} style={{ ...box, fontSize: Math.max(7, size * (init.length > 2 ? 0.3 : 0.38)) }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>{init}</span>;
  }
  const pad = Math.round(size * (spec.pad ?? 0) * 10) / 10;
  return (
    <span className={`lg-mark ${className}`} style={{ ...box, background: spec.bg ?? "transparent", padding: pad }} role={label ? "img" : undefined} aria-label={label ?? undefined} aria-hidden={label ? undefined : true} title={label ? undefined : spec.name}>
      <img src={spec.file} alt="" width={size} height={size} decoding="async" draggable={false} onError={() => setBroken(true)} />
    </span>
  );
}

/** Two marks overlapping (a pair, or a token on its chain). */
export const MarkPair = ({ a, b, size = 20 }: { a: string; b: string; size?: number }) => (
  <span className="lg-pair" style={{ width: size * 1.6, height: size }} aria-hidden><Mark id={a} size={size} /><Mark id={b} size={size} /></span>
);
