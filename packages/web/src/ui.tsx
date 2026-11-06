import { useEffect, useState, type ReactNode } from "react";
import { api, short, SERVER, type Config } from "./api";

export const EXPLORER = "https://explorer.testnet.arc.io/tx/";
export const isFork = (cfg: Config | null) => !cfg || /127\.0\.0\.1|localhost/.test(cfg.rpcUrl);
/** Fork transactions don't exist on the public explorer: link only when talking to a real network. */
export const TxRef = ({ cfg, hash, n = 8 }: { cfg: Config | null; hash?: string; n?: number }) => !hash ? <span className="faint">–</span> : !isFork(cfg)
  ? <a className="mono tx" href={`${EXPLORER}${hash}`} target="_blank" rel="noreferrer">{short(hash, n)} <Icon.ext /></a>
  : <span className="mono tx" title={`${hash} (local Arc fork: not on the public explorer)`}>{short(hash, n)}</span>;

/** viem errors carry request dumps; show the human part only. */
export const msgOf = (e: unknown) => {
  const m = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
  const head = m.split(/Request Arguments:|Contract Call:|Raw Call Arguments:|\n\n/)[0].trim();
  return head.length > 220 ? head.slice(0, 220) + "…" : head;
};

export type Route =
  | { page: "home" }
  | { page: "dashboard"; tab: "home" | "balances" | "payments" | "links" | "developers" | "settings" | "onboard"; sub?: string }
  | { page: "pay"; id: string }
  | { page: "app" };
export function useRoute(): Route {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => { const on = () => { setHash(location.hash); window.scrollTo(0, 0); }; addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  const m = /^#\/pay\/(0x[0-9a-fA-F]{64})/.exec(hash);
  if (m) return { page: "pay", id: m[1] };
  if (/^#\/(app|credit)\b/.test(hash)) return { page: "app" };
  const d = /^#\/(dashboard|merchant)(?:\/(balances|payments|links|developers|settings|onboard))?(?:\/([\w-]+))?/.exec(hash);
  if (d) return { page: "dashboard", tab: (d[2] as never) ?? "home", sub: d[3] };
  return { page: "home" };
}

export function useConfig() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.config().then(setCfg).catch((e) => setErr(e.message)); }, []);
  return { cfg, err };
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn ghost xs" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard blocked */ } }} aria-label={`${label}: ${text}`}>
      {done ? <Icon.check /> : <Icon.copy />}<span>{done ? "Copied" : label}</span>
    </button>
  );
}

export function Setup({ err, compact }: { err: string; compact?: boolean }) {
  return (
    <div className={`setup ${compact ? "compact" : ""}`} role="alert">
      <span className="eyebrow">Setup required</span>
      <h2>The merchant server isn't running.</h2>
      <p>{err}</p>
      <pre>{`pnpm install\npnpm dev:stack                # Arc testnet fork + contracts + merchant API + compliance postman\npnpm --filter @noren/web dev  # this app on :5190`}</pre>
      <p className="faint sm">API: {SERVER}</p>
    </div>
  );
}

export const Logo = ({ size = 26 }: { size?: number }) => (
  <img src="/art/mark.png" width={size} height={size} alt="" aria-hidden style={{ borderRadius: size * 0.24, display: "block" }} />
);

const S = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
export const Icon = {
  home: () => <S><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></S>,
  card: () => <S><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 10h19" /><path d="M6.5 15h4" /></S>,
  link: () => <S><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></S>,
  code: () => <S><path d="m8 7-5 5 5 5" /><path d="m16 7 5 5-5 5" /><path d="m13.5 4-3 16" /></S>,
  gear: () => <S><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></S>,
  arrow: () => <S><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></S>,
  back: () => <S><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></S>,
  copy: () => <S size={14}><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></S>,
  check: () => <S size={14}><path d="m5 12.5 4.5 4.5L19 7.5" /></S>,
  x: () => <S><path d="M18 6 6 18" /><path d="m6 6 12 12" /></S>,
  ext: () => <S size={12}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></S>,
  plus: () => <S><path d="M12 5v14" /><path d="M5 12h14" /></S>,
  shield: () => <S><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></S>,
  eyeOff: () => <S><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4.1" /><path d="M6.6 6.6A17 17 0 0 0 2.5 12s3.5 7 9.5 7a9.5 9.5 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></S>,
  refund: () => <S><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></S>,
  bolt: () => <S><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></S>,
  hook: () => <S><path d="M18 16.5a3.5 3.5 0 1 1-3.4-4.5" /><path d="M9.5 7.5 6 13.5h7.5" /><circle cx="12" cy="5" r="2.5" /><circle cx="6" cy="17" r="2.5" /></S>,
  receipt: () => <S><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 8h6" /><path d="M9 12h6" /></S>,
  lock: () => <S><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></S>,
  menu: () => <S><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></S>,
  layers: () => <S><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></S>,
  chart: () => <S><path d="M4 19V5" /><path d="M4 19h16" /><path d="m7 14 4-4 3 3 5-6" /></S>,
  gauge: () => <S><path d="M4.5 17a8.5 8.5 0 1 1 15 0" /><path d="m12 13 4-4" /></S>,
  clock: () => <S size={14}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></S>,
};
