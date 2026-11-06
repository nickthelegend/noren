/**
 * Home: the Noren app's first screen, laid out like a hosted consumer wallet. One balance (private + public on Arc,
 * USDG and Stock Tokens on Robinhood Chain, credit available), the five things people do (Pay, Send privately, Bridge
 * Robinhood ⇄ Arc, Earn, Credit), an in-app Pay that runs a private payment end to end, and recent activity read from
 * this browser's receipts and both chains. Every number is read live; nothing is a placeholder.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { api, usdc, type InvoiceView } from "../api";
import { msgOf } from "../ui";
import { TxLink } from "../tx";
import { Mark } from "../logos";
import type { Wallet, Tab } from "./NorenApp";
import { PayInvoice, WAYS } from "./PayInvoice";
import { readActivity, type Activity } from "./activity";
import { Empty, Skel, shortHex } from "./kit";
import type { Line } from "../onchain";

const ago = (t: number) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" }); };
const usd = (v6: bigint) => (Number(v6) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function HomeTab({ w, go }: { w: Wallet; go: (t: Tab) => void }) {
  const [priv, setPriv] = useState<{ approved: bigint; pending: bigint } | null>(null);
  const [privErr, setPrivErr] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [acts, setActs] = useState<Activity[] | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [open, setOpen] = useState<InvoiceView[] | null>(null);
  const [shop, setShop] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const payRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let on = true;
    import("../wallet").then((m) => m.makeWallet(w.cfg).balances()).then((b) => on && (setPriv(b), setPrivErr(null))).catch((e) => on && setPrivErr(msgOf(e)));
    w.oc.lines().then((l) => on && setLines(l)).catch(() => on && setLines([]));
    readActivity(w).then((a) => on && (setActs(a), setActErr(null))).catch((e) => on && setActErr(msgOf(e)));
    api.listInvoices(w.cfg.merchant).then((rows) => on && setOpen(rows.filter((r) => r.status === "draft" || r.status === "open").slice(0, 3))).catch(() => on && setOpen([]));
    api.profile(w.cfg.merchant).then((p) => on && setShop(p.name)).catch(() => {});
    return () => { on = false; };
  }, [w.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const h = w.hold;
  const stocks6 = h ? h.stocks.reduce((s, x) => s + x.value8 / 100n, 0n) : null; // Chainlink value, 8 dp → 6 dp
  const credit = useMemo(() => (lines ? lines.filter((l) => !l.closed).reduce((s, l) => s + (l.limit > l.drawn - l.repaid ? l.limit - (l.drawn - l.repaid) : 0n), 0n) : null), [lines]);
  const parts = [priv?.approved ?? null, w.arcUsdc, h?.usdg ?? null, stocks6];
  const total = parts.every((p) => p !== null) ? parts.reduce((a, b) => a! + b!, 0n)! : null;
  const toPay = () => { payRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); setTimeout(() => document.getElementById("nk-paylink")?.focus(), 350); };

  const ACTIONS: { k: string; label: string; short?: string; sub: string; icon: string; on: () => void; primary?: boolean }[] = [
    { k: "pay", label: "Pay", sub: "Scan or paste a link", icon: "M4 7h16M4 12h10M4 17h7", on: toPay, primary: true },
    { k: "send", label: "Send privately", short: "Send", sub: "From your private balance", icon: "M4 12h13M13 6l6 6-6 6", on: () => go("pay") },
    { k: "bridge", label: "Bridge", sub: "Robinhood ⇄ Arc", icon: "M7 7h11l-3-3M17 17H6l3 3", on: () => go("bridge") },
    { k: "earn", label: "Earn", sub: "Deposits become Aqua liquidity", icon: "M5 18l5-6 4 3 5-8", on: () => go("earn") },
    { k: "credit", label: "Credit", sub: "Borrow against stock", icon: "M4 8h16v10H4zM4 12h16", on: () => go("credit") },
  ];

  return (
    <div className="nk-home">
      <div className="nk-home-main">
        <section className="nk-wallet" aria-label="Your balance">
          <div className="nk-wallet-top">
            <small>Total balance</small>
            <span className="nk-wallet-addr nk-mono">{shortHex(w.oc.address, 6)}</span>
          </div>
          <b className="nk-wallet-total"><i>$</i>{total !== null ? usd(total) : "…"}</b>
          <p className="nk-wallet-note">USDC and USDG at $1, Stock Tokens at their Chainlink price. Test networks.</p>
          <div className="nk-wallet-split">
            <div className="priv"><small className="lg-row"><Mark id="KOHAKU" size={14} />Private · Arc</small><b>{priv ? usdc(priv.approved) : privErr ? "–" : "…"}</b><em>USDC{priv && priv.pending > 0n ? ` · +${usdc(priv.pending)} screening` : ""}</em></div>
            <div><small className="lg-row"><Mark id="ARC" size={14} />Public · Arc</small><b>{w.arcUsdc !== null ? usdc(w.arcUsdc) : "–"}</b><em>USDC</em></div>
            <div><small className="lg-row"><Mark id="ROBINHOOD" size={14} />Robinhood Chain</small><b>{h ? usdc(h.usdg + (stocks6 ?? 0n)) : w.holdErr ? "–" : "…"}</b><em>{h ? `${usdc(h.usdg)} USDG · ${h.stocks.filter((s) => s.balance > 0n).map((s) => s.sym).join(", ") || "no stock"}` : "USDG + stock"}</em></div>
            <div><small className="lg-row"><Mark id="CHAINLINK" size={14} />Credit available</small><b>{credit !== null ? usdc(credit) : "…"}</b><em>{lines?.filter((l) => !l.closed).length ? "USDC on Arc" : "no line yet"}</em></div>
          </div>
        </section>

        <nav className="nk-actions" aria-label="Actions">
          {ACTIONS.map((a, i) => (
            <motion.button key={a.k} className={a.primary ? "primary" : ""} onClick={a.on} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 * i, duration: 0.25 }}>
              <i aria-hidden><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={a.icon} /></svg></i>
              <b><span className="lg">{a.label}</span><span className="sm">{a.short ?? a.label}</span></b><small>{a.sub}</small>
            </motion.button>
          ))}
        </nav>

        <section className="nk-card nk-paycard" aria-label="Pay" ref={payRef}>
          <div className="nk-card-h"><div><b>Pay</b><p>Scan or paste a Noren link. Paying privately happens right here.</p></div><span className="nk-pill live"><Mark id="ARC" size={16} />Arc</span></div>
          <div className="nk-pad">
            {open && open.length > 0 && (
              <div className="nk-openlinks" aria-label="Open payment links">
                <small>Open links{shop ? ` from ${shop}` : ""}</small>
                <div>{open.map((r) => <button key={r.invoice.invoiceId} type="button" className="nk-chiplink" aria-pressed={picked === r.invoice.invoiceId} onClick={() => setPicked(r.invoice.invoiceId)}><b>{usdc(r.invoice.amount)}</b> {r.description ?? "Payment"}</button>)}</div>
              </div>
            )}
            <PayInvoice w={w} initial={picked} />
          </div>
        </section>
      </div>

      <aside className="nk-home-side">
        <section className="nk-card" aria-label="Recent activity">
          <div className="nk-card-h"><div><b>Recent activity</b><p>Your receipts in this browser, and both chains</p></div></div>
          <div className="nk-pad">
            {actErr ? <div className="nk-err">{actErr}</div> : !acts ? <Skel rows={4} /> : !acts.length ? <Empty title="Nothing yet" text="Get test funds from your wallet menu (top right), then pay a link: it shows up here." /> : (
              <ul className="nk-acts">
                {acts.map((a) => (
                  <li key={a.id} data-kind={a.kind}>
                    <span className="nk-act-ic" aria-hidden><Mark id={a.private ? "KOHAKU" : a.chain === "arc" ? "ARC" : "ROBINHOOD"} size={22} /></span>
                    <div><b>{a.title}</b><small>{a.detail} · {ago(a.at)}</small></div>
                    <div className="r"><b className={a.sign === "+" ? "ok-t" : ""}>{a.sign}{a.amount}</b>{a.tx && <TxLink chain={a.chain === "arc" ? "arc" : "robinhood"} cfg={w.cfg} hash={a.tx} n={4} />}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className="nk-card" aria-label="Four ways to pay">
          <div className="nk-card-h"><div><b>Four ways to pay</b><p>The same at every Noren checkout</p></div></div>
          <ol className="nk-fourways">
            {WAYS.map((m, i) => <li key={m.id}><i>{i + 1}</i><div><b>{m.title}</b><small>{m.sub}</small></div><span className={`nk-way-tag ${m.tag === "Public" ? "" : "ok"}`}>{m.tag}</span></li>)}
          </ol>
          <p className="nk-fine" style={{ padding: "0 14px 10px" }}>Swaps and bridges are public. Payments are private by default. Your stock is credit collateral on Robinhood Chain; {credit !== null && credit > 0n ? `${usdc(credit)} USDC of it is spendable on Arc now.` : "open a line in Credit."}</p>
        </section>
      </aside>
    </div>
  );
}
