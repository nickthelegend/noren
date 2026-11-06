/**
 * The Noren app: the customer's side of Noren. Home (balance, Pay, recent activity), then one card per task: Pay,
 * Bridge, Earn, Credit, Borrow, Swap.
 * Every number is read from the two local forks (Robinhood Chain mainnet snapshot, Arc testnet fork) or a Noren
 * service; anything not running says "Setup required".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { erc20Abi } from "viem";
import "@fontsource-variable/urbanist";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "./app.css";
import { api, usdc } from "../api";
import { Logo, msgOf, useConfig } from "../ui";
import type { Config } from "../api";
import { makeOnchain, type Holding, type Onchain } from "../onchain";
import { WETH } from "./tokens";
import { shortHex, spring } from "./kit";
import { SwapTab } from "./SwapTab";
import { BridgeTab } from "./BridgeTab";
import { EarnTab } from "./EarnTab";
import { BorrowTab } from "./BorrowTab";
import { CreditTab } from "./CreditTab";
import { PayTab } from "./PayTab";
import { HomeTab } from "./HomeTab";
import { LiveArc, NetSwitch } from "../LiveArc";
import { useNet } from "../network";
import { Mark } from "../logos";

export const TABS = ["home", "pay", "bridge", "earn", "credit", "borrow", "swap"] as const;
export type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { home: "Home", pay: "Pay", bridge: "Bridge", earn: "Earn", credit: "Credit", borrow: "Borrow", swap: "Swap" };
const tabFromHash = (): Tab => { const m = /^#\/(?:app|credit)\/(\w+)/.exec(location.hash); return (TABS as readonly string[]).includes(m?.[1] ?? "") ? (m![1] as Tab) : "home"; };

export type Wallet = {
  cfg: Config; oc: Onchain;
  hold: { stocks: Holding[]; usdg: bigint; eth: bigint; weth: bigint } | null; holdErr: string | null;
  arcUsdc: bigint | null; refresh: () => void; tick: number;
};

export function NorenApp() {
  const { cfg, err } = useConfig();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => { const on = () => setTab(tabFromHash()); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  const go = (t: Tab) => { history.replaceState(null, "", `#/app/${t}`); setTab(t); scrollTo({ top: 0 }); };
  const oc = useMemo(() => (cfg ? makeOnchain(cfg) : null), [cfg]);
  const [hold, setHold] = useState<Wallet["hold"]>(null);
  const [holdErr, setHoldErr] = useState<string | null>(null);
  const [arcUsdc, setArcUsdc] = useState<bigint | null>(null);
  const [tick, setTick] = useState(0);
  const [menu, setMenu] = useState(false);
  const [net] = useNet();

  const refresh = useCallback(() => {
    if (!oc) return;
    oc.holdings().then(async (h) => {
      const { pub } = oc.robinhood();
      const weth = await pub.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [oc.address] }).catch(() => 0n);
      setHold({ ...h, weth }); setHoldErr(null);
    }).catch((e) => setHoldErr(msgOf(e)));
    oc.arcUsdc().then(setArcUsdc).catch(() => setArcUsdc(null));
    setTick((t) => t + 1);
  }, [oc]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  if (err) return (
    <div className="nk"><main className="nk-main"><div className="nk-col"><div className="nk-setup" role="alert"><span className="nk-tag">Setup required</span><b>The Noren server isn't running.</b><p>{err}</p><p><code>pnpm dev:all</code> then <code>pnpm --filter @noren/web dev</code></p></div></div></main></div>
  );
  const w: Wallet | null = cfg && oc ? { cfg, oc, hold, holdErr, arcUsdc, refresh, tick } : null;
  const credit = oc?.credit;

  return (
    <MotionConfig reducedMotion="user">
      <div className="nk">
        <header className="nk-nav">
          <a className="nk-brand" href="#/"><Logo size={30} /><span>Noren</span><small>app</small></a>
          <nav className="nk-tabs" role="tablist" aria-label="Noren app">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-label={LABEL[t]} aria-selected={tab === t} onClick={() => go(t)}>
                {tab === t && <motion.span className="nk-tab-pill" layoutId="nk-tab-pill" transition={spring} />}
                <span className="nk-tab-l">{LABEL[t]}</span>
              </button>
            ))}
          </nav>
          <div className="nk-right">
            <NetSwitch />
            {net === "fork" && <span className="nk-nets" aria-label="Networks">
              <span className="nk-net" title={credit?.robinhoodRpc ?? "not running"}><i className={credit?.robinhoodRpc ? "on" : ""} /><Mark id="ROBINHOOD" size={16} />Robinhood fork</span>
              <span className="nk-net" title={cfg?.rpcUrl}><i className={cfg ? "on" : ""} /><Mark id="ARC" size={16} />Arc fork</span>
            </span>}
            <div className="nk-prof">
              <button className="nk-chip" onClick={() => setMenu((o) => !o)} aria-expanded={menu} aria-haspopup="dialog"><i className="nk-ava" aria-hidden />{oc ? shortHex(oc.address, 6) : "…"}</button>
              {menu && w && <Profile w={w} onClose={() => setMenu(false)} />}
            </div>
          </div>
        </header>

        <main className="nk-main">
          {net === "live" ? <div className="nk-col"><LiveArc context="app" /></div> : !w ? <div className="nk-col"><div className="nk-skel"><i /><i /><i /></div></div> : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={tab} className={`nk-pane${tab === "home" ? " wide" : ""}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}>
                {tab === "home" && <HomeTab w={w} go={go} />}
                {tab === "swap" && <SwapTab w={w} />}
                {tab === "bridge" && <BridgeTab w={w} />}
                {tab === "earn" && <EarnTab w={w} />}
                {tab === "borrow" && <BorrowTab w={w} />}
                {tab === "credit" && <CreditTab w={w} />}
                {tab === "pay" && <PayTab w={w} />}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
        <p className={`nk-foot${tab === "home" ? " wide" : ""}`}>Test networks only. Robinhood Chain runs as a local snapshot of mainnet (real Stock Tokens, Chainlink feeds, 1inch Aqua and Uniswap v4); Arc runs as a local testnet fork, except Swap on Arc and Bridge, which use the public testnets. No real money moves.</p>
      </div>
    </MotionConfig>
  );
}

function Profile({ w, onClose }: { w: Wallet; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: string; bad?: boolean } | null>(null);
  const run = async (k: string, f: () => Promise<string>) => { setBusy(k); setNote(null); try { setNote({ t: await f() }); w.refresh(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); } };
  const h = w.hold;
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="nk-menu" role="dialog" aria-label="Your wallet">
      <div className="nk-menu-row"><small>Your address on both chains (a test key kept in this browser)</small><span>{w.oc.address}</span></div>
      <div className="nk-bal" aria-label="Robinhood Chain balances">
        <span>{h ? usdc(h.usdg) : "…"}<em><Mark id="USDG" size={14} />USDG</em></span>
        <span>{h ? (Number(h.eth) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "…"}<em><Mark id="ETH" size={14} />ETH</em></span>
        <span>{h ? (Number(h.stocks.find((s) => s.sym === "NVDA")?.balance ?? 0n) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "…"}<em><Mark id="NVDA" size={14} />NVDA</em></span>
      </div>
      <div className="nk-menu-row"><small className="lg-row"><Mark id="ARC" size={14} />Arc</small></div>
      <div className="nk-bal" style={{ gridTemplateColumns: "1fr" }}><span>{w.arcUsdc === null ? "–" : usdc(w.arcUsdc)}<em><Mark id="USDC" size={14} />USDC on Arc</em></span></div>
      <button className="nk-btn" disabled={!!busy} onClick={() => run("rh", async () => { const r = await api.robinhoodFaucet(w.oc.address); return `Robinhood fork faucet: NVDA and USDG moved from real holders (${Object.keys(r).join(", ")}).`; })}>{busy === "rh" ? "Moving tokens…" : "Get test stock and USDG (Robinhood fork)"}</button>
      <button className="nk-btn" disabled={!!busy} onClick={() => run("arc", async () => { await api.faucet(w.oc.address); return "Arc fork faucet: test USDC and gas sent."; })}>{busy === "arc" ? "Sending…" : "Get test USDC (Arc fork)"}</button>
      {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
      <button className="nk-x" onClick={onClose} aria-label="Close">×</button>
    </div>
  );
}
