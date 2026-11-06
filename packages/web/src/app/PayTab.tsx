/**
 * Pay: open a Noren payment link (paste it, or pick an open link and scan its QR), your private balance in the
 * Kohaku privacy pool, and your Pay in 3 plans on NorenCredit with their next installment.
 */
import { useEffect, useState } from "react";
import { api, usdc, type InvoiceView } from "../api";
import { msgOf } from "../ui";
import { QR } from "../kit";
import type { Wallet } from "./NorenApp";
import { rhSdk, type Positions } from "./rh";
import { Card, Empty, SetupCard, Skel, Spin, shortHex } from "./kit";
import type { ReactNode } from "react";
import { TxLink } from "../tx";
import { Mark } from "../logos";

const day = (t: bigint | number) => new Date(Number(t) * 1000).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const linkFor = (id: string) => `${location.origin}${location.pathname}#/pay/${id}`;

export function PayTab({ w }: { w: Wallet }) {
  const [priv, setPriv] = useState<{ approved: bigint; pending: bigint } | null>(null);
  const [privErr, setPrivErr] = useState<string | null>(null);
  useEffect(() => {
    let on = true, timer: ReturnType<typeof setInterval> | undefined;
    import("../wallet").then((m) => { const wl = m.makeWallet(w.cfg); const read = () => wl.balances().then((b) => on && (setPriv(b), setPrivErr(null))).catch((e) => on && setPrivErr(msgOf(e))); read(); timer = setInterval(read, 10000); }).catch((e) => setPrivErr(msgOf(e)));
    return () => { on = false; if (timer) clearInterval(timer); };
  }, [w.cfg]);

  return (
    <div className="nk-col">
      <div className="nk-hero" aria-label="Private balance">
        <small className="lg-row"><Mark id="KOHAKU" size={16} />Private balance · Kohaku privacy pool on Arc</small>
        <b><i>$</i>{priv ? usdc(priv.approved) : privErr ? "–" : "…"}</b>
        <p>{privErr ? `Couldn't read the pool: ${privErr}` : priv && priv.pending > 0n ? `+${usdc(priv.pending)} USDC being screened by the ASP` : "Pay any Noren checkout from here and the merchant never learns your wallet."}{w.arcUsdc !== null ? ` · Public Arc wallet: ${usdc(w.arcUsdc)} USDC` : ""}</p>
      </div>
      <PayLink w={w} />
      <Plans w={w} />
    </div>
  );
}

function PayLink({ w }: { w: Wallet }) {
  const [v, setV] = useState("");
  const [open, setOpen] = useState<InvoiceView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [shop, setShop] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    api.listInvoices(w.cfg.merchant).then((rows) => on && (setOpen(rows.filter((r) => r.status === "draft" || r.status === "open").slice(0, 4)), setErr(null))).catch((e) => on && setErr(msgOf(e)));
    api.profile(w.cfg.merchant).then((p) => on && setShop(p.name)).catch(() => {});
    return () => { on = false; };
  }, [w.cfg.merchant, w.tick]);
  const id = /0x[0-9a-fA-F]{64}/.exec(v)?.[0];
  return (
    <Card title="Pay a link" sub="Paste a Noren payment link, or scan one at the counter">
      <div className="nk-box">
        <label htmlFor="nk-link">Payment link or invoice ID</label>
        <div className="nk-row"><input id="nk-link" style={{ fontSize: 18, fontWeight: 500 }} placeholder="https://…/#/pay/0x…" value={v} onChange={(e) => setV(e.target.value.trim())} autoComplete="off" /></div>
        <div className="nk-sub"><span>{v && !id ? "That isn't a Noren payment link" : "Opens Noren's hosted checkout"}</span><span /></div>
      </div>
      <a className="nk-cta" aria-disabled={!id} href={id ? `#/pay/${id}` : undefined} onClick={(e) => { if (!id) e.preventDefault(); }} style={id ? undefined : { background: "rgba(23,32,63,.07)", color: "var(--nk-faint)", boxShadow: "none", cursor: "not-allowed" }}>Open checkout</a>
      <div className="nk-pad" style={{ marginTop: 10 }}>
        <span className="nk-tag">Open links{shop ? ` from ${shop}` : ""}</span>
        <div style={{ marginTop: 10 }}>
          {err ? <div className="nk-err">{err}</div> : !open ? <Skel rows={2} /> : !open.length ? <Empty title="No open payment links" text="When a shop creates a link in Noren Merchant it appears here, with its QR code." /> : (
            <ul className="nk-items">
              {open.map((r) => (
                <li key={r.invoice.invoiceId}>
                  <Mark id="USDC" size={24} /><div><b>{r.description ?? "Payment"} · {usdc(r.invoice.amount)} USDC</b><small className="nk-mono">{shortHex(r.invoice.invoiceId, 8)} · expires {day(BigInt(r.invoice.expiry))}</small></div>
                  <button className="nk-btn ghost" onClick={() => setQr(qr === r.invoice.invoiceId ? null : r.invoice.invoiceId)} aria-expanded={qr === r.invoice.invoiceId}>QR</button>
                  <a className="nk-btn ink" href={`#/pay/${r.invoice.invoiceId}`}>Pay</a>
                </li>
              ))}
            </ul>
          )}
          {qr && <div className="nk-qr" style={{ marginTop: 8 }}><QR text={linkFor(qr)} size={200} /><p className="nk-fine" style={{ textAlign: "center" }}>Scan with a phone camera to open this checkout</p></div>}
        </div>
      </div>
    </Card>
  );
}

function Plans({ w }: { w: Wallet }) {
  const [pos, setPos] = useState<Positions | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: ReactNode; bad?: boolean } | null>(null);
  useEffect(() => { let on = true; try { rhSdk(w).readPositions(w.oc.address).then((p) => on && (setPos(p), setErr(null))).catch((e) => on && setErr(msgOf(e))); } catch (e) { setErr(msgOf(e)); } return () => { on = false; }; }, [w.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const plans = pos?.plans.filter((p) => Number(p.plan.status) === 1) ?? [];
  const pay = async (planId: bigint) => {
    setBusy(String(planId)); setNote(null);
    try { const r = await rhSdk(w).repay({ planId, count: 1 }); setNote({ t: <>Paid {usdc(r.amountUsdg)} USDG on Robinhood (tx <TxLink chain="robinhood" hash={r.hash} />).</> }); w.refresh(); }
    catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); }
  };
  return (
    <Card title="Pay in 3" sub="Plans on NorenCredit: stock locked at the Chainlink price, three USDG installments" pill={<span className="nk-pill">{plans.length} open</span>}>
      <div className="nk-pad">
        {err ? <SetupCard title="NorenCredit isn't reachable" text={err} /> : !pos ? <Skel rows={2} /> : !plans.length ? <Empty title="No plans yet" text="Choose “Pay in 3” at a Noren checkout. Your stock stays locked until the third installment." /> : plans.map((p) => (
          <div key={String(p.planId)} className="nk-box" style={{ marginBottom: 6 }}>
            <span className="nk-l"><span>Plan #{String(p.planId)} · {p.liquidation?.sharesText} {p.liquidation?.symbol} locked</span><span>{Number(p.plan.paid)}/3 paid</span></span>
            <div className="nk-meter"><i className={p.liquidatable.overdue || p.liquidatable.undercollateralised ? "bad" : ""} style={{ width: `${(Number(p.plan.paid) / 3) * 100}%` }} /></div>
            <ul className="nk-items" style={{ marginTop: 10 }}>
              {p.liquidation?.schedule.map((s) => <li key={s.installment} data-done={s.paid}><span className="nk-check">{s.paid ? "✓" : s.installment}</span><div><b>{usdc(s.amountUsdg)} USDG</b><small>{s.paid ? "Paid" : `Due ${day(s.dueAt)}`}</small></div></li>)}
            </ul>
            {p.liquidation && <p className="nk-fine">{p.liquidation.message}</p>}
            <button className="nk-cta" disabled={!!busy || !p.nextAmount} onClick={() => pay(p.planId)}>{busy === String(p.planId) ? <><Spin /> Paying…</> : `Pay installment ${Number(p.plan.paid) + 1} · ${usdc(p.nextAmount)} USDG`}</button>
          </div>
        ))}
        {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
      </div>
    </Card>
  );
}
