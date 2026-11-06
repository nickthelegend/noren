/** Noren app components, adapted from Kabuto's DEX (MIT, ours): swap card boxes, token selector, toggle, result card. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TOKENS, fmtUnits, type Token } from "./tokens";

export const spring = { type: "spring", stiffness: 520, damping: 38 } as const;
export const pop = { initial: { opacity: 0, y: 18, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -10, scale: 0.98 }, transition: { type: "spring", stiffness: 380, damping: 32 } } as const;

export const Coin = ({ t, lg }: { t: Pick<Token, "sym" | "color">; lg?: boolean }) => (
  <span className={`nk-coin ${lg ? "lg" : ""}`} style={{ ["--c" as string]: t.color }} aria-hidden>{t.sym === "USDG" ? "$" : t.sym === "ETH" ? "Ξ" : t.sym === "USDC" ? "$" : t.sym.slice(0, 2)}</span>
);

const Caret = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>;

/** Token chip that opens the selector sheet. */
export function TokenButton({ t, onPick, exclude, balances, label, only }: { t: Token; onPick?: (t: Token) => void; exclude?: string; balances?: Record<string, bigint>; label: string; only?: (t: Token) => boolean }) {
  const [open, setOpen] = useState(false);
  if (!onPick) return <span className="nk-token" data-static="true"><Coin t={t} />{t.sym}</span>;
  return (
    <>
      <button type="button" className="nk-token" onClick={() => setOpen(true)} aria-label={`${label}: ${t.sym}. Change token`}><Coin t={t} />{t.sym}<Caret /></button>
      <AnimatePresence>{open && <TokenSheet current={t.sym} exclude={exclude} balances={balances} only={only} onClose={() => setOpen(false)} onPick={(x) => { onPick(x); setOpen(false); }} />}</AnimatePresence>
    </>
  );
}

function TokenSheet({ current, exclude, balances, only, onClose, onPick }: { current: string; exclude?: string; balances?: Record<string, bigint>; only?: (t: Token) => boolean; onClose: () => void; onPick: (t: Token) => void }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  const list = useMemo(() => TOKENS.filter((t) => (!only || only(t)) && (!q || `${t.sym} ${t.name}`.toLowerCase().includes(q.toLowerCase()))), [q, only]);
  return (
    <motion.div className="nk-modal" role="dialog" aria-modal="true" aria-label="Select a token" onMouseDown={(e) => e.target === e.currentTarget && onClose()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="nk-sheet" {...pop}>
        <div className="nk-sheet-h"><b>Select a token</b><button className="nk-x" onClick={onClose} aria-label="Close">×</button></div>
        <input ref={input} className="nk-search" placeholder="Search NVDA, ETH, USDG…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tokens" />
        <ul className="nk-list" role="listbox" aria-label="Tokens">
          {list.map((t) => (
            <li key={t.sym}>
              <button role="option" aria-selected={t.sym === current} disabled={t.sym === exclude} onClick={() => onPick(t)}>
                <Coin t={t} lg />
                <span><b>{t.sym}</b><small>{t.name}{t.kind === "stock" ? " · Stock Token" : ""}</small></span>
                <span className="r">{balances?.[t.sym] !== undefined ? <><b>{fmtUnits(balances[t.sym], t.decimals, 4)}</b><small>balance</small></> : null}</span>
              </button>
            </li>
          ))}
          {!list.length && <li className="nk-fine">No token matches “{q}”.</li>}
        </ul>
      </motion.div>
    </motion.div>
  );
}

/** Kabuto's protect switch, as a generic toggle row. */
export function Toggle({ on, onChange, title, hint, label }: { on: boolean; onChange: (v: boolean) => void; title: string; hint?: string; label: string }) {
  return (
    <div className={`nk-toggle ${on ? "on" : ""}`}>
      <div className="nk-toggle-l"><div><b>{title}</b>{hint && <small>{hint}</small>}</div></div>
      <span className="nk-toggle-s">{on ? "On" : "Off"}</span>
      <button role="switch" aria-checked={on} aria-label={label} className="nk-switch" onClick={() => onChange(!on)}><motion.i animate={{ x: on ? 22 : 0 }} transition={spring} /></button>
    </div>
  );
}

export function Band<T extends string | number>({ label, value, options, onChange, fmt }: { label: string; value: T; options: T[]; onChange: (v: T) => void; fmt: (v: T) => string }) {
  return <div className="nk-band" role="group" aria-label={label}><span>{label}</span>{options.map((o) => <button key={String(o)} aria-pressed={value === o} onClick={() => onChange(o)}>{fmt(o)}</button>)}</div>;
}

export const Skel = ({ rows = 2 }: { rows?: number }) => <div className="nk-skel" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <i key={i} />)}</div>;

/** "Setup required" card: the exact missing piece, never a placeholder number. */
export function SetupCard({ title, text, code }: { title: string; text: string; code?: string }) {
  return <div className="nk-setup" role="status"><span className="nk-tag">Setup required</span><b>{title}</b><p>{text.replace(/^Setup required:\s*/i, "")}</p>{code && <p><code>{code}</code></p>}</div>;
}
export const Empty = ({ title, text, children }: { title: string; text?: string; children?: ReactNode }) => <div className="nk-empty"><b>{title}</b>{text && <p>{text}</p>}{children}</div>;

export function Card({ title, sub, pill, children, label }: { title: ReactNode; sub?: ReactNode; pill?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className="nk-card" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      <div className="nk-card-h"><div><b>{title}</b>{sub && <p>{sub}</p>}</div>{pill}</div>
      {children}
    </section>
  );
}

/** Kabuto's result card: tag, headline, body, three key/values. */
export function Result({ tone, tag, link, title, body, kv, children }: { tone?: "good" | "bad" | ""; tag: string; link?: ReactNode; title: ReactNode; body?: ReactNode; kv?: [string, ReactNode][]; children?: ReactNode }) {
  return (
    <motion.section layout {...pop} className={`nk-result ${tone ?? ""}`} aria-live="polite">
      <div className="nk-result-h"><span className="nk-tag">{tag}</span>{link}</div>
      <b>{title}</b>
      {body && <p>{body}</p>}
      {kv && kv.length > 0 && <div className="nk-kv">{kv.map(([k, v]) => <div key={k}><small>{k}</small><span>{v}</span></div>)}</div>}
      {children}
    </motion.section>
  );
}

export function Track({ steps }: { steps: { k: string; on: boolean; d?: ReactNode }[] }) {
  const now = steps.findIndex((s) => !s.on);
  return (
    <ol className="nk-track" style={{ ["--n" as string]: steps.length }}>
      {steps.map((s, i) => <li key={s.k} data-on={s.on} data-now={i === now && i > 0 && steps[i - 1].on}><i /><b>{s.k}</b><span>{s.d}</span></li>)}
    </ol>
  );
}

export const Spin = () => <span className="nk-spin" aria-hidden />;
export const shortHex = (h?: string, n = 6) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : "");
