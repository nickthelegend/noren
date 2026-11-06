/**
 * Pay: open a Noren payment link (paste it, or pick an open link and scan its QR), your private balance in the
 * Kohaku privacy pool, send privately to any address through Noren's relayer, and your Pay in 3 plans on NorenCredit
 * with their next installment.
 */
import { useEffect, useState } from "react";
import { api, SERVER, toBase, usdc, type InvoiceView } from "../api";
import { jsonBigints } from "@noren/core";
import { isAddress, type Address, type Hex } from "viem";
import { msgOf } from "../ui";
import { QR } from "../kit";
import type { Wallet } from "./NorenApp";
import { dutchSdk, rhSdk, type Positions } from "./rh";
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
      <SendPrivately w={w} spendable={priv?.approved ?? null} />
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

type RelayQuote = { relayer: Address; feeRecipient: Address; feeBps: string; maxRelayFeeBps: string };
/**
 * Send privately: pay any address (a merchant or a person) from the private balance. The proof is made here; Noren's
 * server relays Kohaku's Entrypoint.relay, so the recipient is paid by the pool and never sees this wallet.
 */
function SendPrivately({ w, spendable }: { w: Wallet; spendable: bigint | null }) {
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [quote, setQuote] = useState<RelayQuote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"proving" | "relaying" | null>(null);
  const [note, setNote] = useState<{ t: ReactNode; bad?: boolean } | null>(null);
  useEffect(() => {
    let on = true;
    fetch(`${SERVER}/private/relayer`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `relayer answered ${r.status}`); return j; })
      .then((j) => on && (setQuote(j), setQErr(null))).catch((e) => on && setQErr(msgOf(e)));
    return () => { on = false; };
  }, []);
  const amount = /^\d+(\.\d{0,6})?$/.test(amt) ? toBase(amt) : 0n;
  const fee = quote ? (amount * BigInt(quote.feeBps)) / 10_000n : 0n;
  const okTo = isAddress(to) && !/^0x0{40}$/i.test(to);
  const tooMuch = spendable !== null && amount > spendable;
  const send = async () => {
    if (!quote || !okTo || amount <= 0n) return;
    setNote(null); setBusy("proving");
    try {
      const { makeWallet } = await import("../wallet");
      const t0 = performance.now();
      const p = await makeWallet(w.cfg).customer.proveRelayedSend({ recipient: to as Address, amount, feeRecipient: quote.feeRecipient, relayFeeBps: BigInt(quote.feeBps) });
      const secs = (performance.now() - t0) / 1000;
      setBusy("relaying");
      const r = await fetch(`${SERVER}/private/send`, { method: "POST", headers: { "content-type": "application/json" }, body: jsonBigints(p) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `relay failed (${r.status})`);
      setNote({ t: <>Sent {usdc(j.received)} USDC to <span className="nk-mono">{shortHex(to, 6)}</span> from the pool (proof {secs.toFixed(1)} s on this device). Tx <TxLink chain="arc" cfg={w.cfg} hash={j.tx as Hex} />. Your address is not in it.</> });
      setAmt(""); w.refresh();
    } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); }
  };
  return (
    <Card title="Send privately" sub="Pay any address from your private balance; they see the pool, not you">
      {qErr ? <div className="nk-pad"><SetupCard title="Noren's relayer isn't reachable" text={qErr} /></div> : <>
        <div className="nk-box">
          <label htmlFor="nk-send-to">To</label>
          <div className="nk-row"><input id="nk-send-to" className="nk-mono" placeholder="0x… a shop or a friend" value={to} onChange={(e) => setTo(e.target.value.trim())} autoComplete="off" spellCheck={false} /></div>
          <div className="nk-sub"><span>{to && !okTo ? "That isn't an address" : "Any address on Arc"}</span><span /></div>
        </div>
        <div className="nk-box">
          <label htmlFor="nk-send-amt">Amount</label>
          <div className="nk-row"><input id="nk-send-amt" inputMode="decimal" style={{ fontSize: 18, fontWeight: 500 }} placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value.trim())} autoComplete="off" /><span className="lg-row"><Mark id="USDC" size={18} />USDC</span></div>
          <div className="nk-sub"><span>{tooMuch ? "More than your private balance" : quote ? `Relayer fee ${Number(quote.feeBps) / 100}%${amount > 0n ? ` · they receive ${usdc(amount - fee)} USDC` : ""}` : "Reading the relayer…"}</span><span>{spendable !== null ? `${usdc(spendable)} private` : ""}</span></div>
        </div>
        <button className="nk-cta" disabled={!!busy || !quote || !okTo || amount <= 0n || tooMuch} onClick={send}>{busy === "proving" ? <><Spin /> Proving on this device…</> : busy === "relaying" ? <><Spin /> Noren is relaying…</> : "Send privately"}</button>
        <p className="nk-fine">One spend moves one private note: the amount must fit in a single deposit you made. Anything left stays private as change.</p>
      </>}
      {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
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
            <DutchStatus w={w} planId={p.planId} />
            <button className="nk-cta" disabled={!!busy || !p.nextAmount} onClick={() => pay(p.planId)}>{busy === String(p.planId) ? <><Spin /> Paying…</> : `Pay installment ${Number(p.plan.paid) + 1} · ${usdc(p.nextAmount)} USDG`}</button>
          </div>
        ))}
        {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
      </div>
    </Card>
  );
}

type Dutch = Awaited<ReturnType<ReturnType<typeof dutchSdk>["auctionStatus"]>>;
/** The plan's partial Dutch-auction liquidation status, read live from NorenDutchAuction (createNorenDutch). */
function DutchStatus({ w, planId }: { w: Wallet; planId: bigint }) {
  const [s, setS] = useState<Dutch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true; try { dutchSdk(w).auctionStatus(planId).then((x) => on && (setS(x), setErr(null))).catch((e) => on && setErr(msgOf(e))); } catch (e) { setErr(msgOf(e)); } return () => { on = false; }; }, [w.tick, planId]); // eslint-disable-line react-hooks/exhaustive-deps
  const tone = s?.open || s?.liquidatable ? "warn" : s ? "ok" : "";
  return (
    <div className={`nk-dutch ${tone}`} role="status" aria-label="Liquidation status">
      <span className="nk-tag">Partial Dutch auction</span>
      {err ? <p>{err}</p> : !s ? <p>Reading NorenDutchAuction…</p> : (
        <>
          <p><b>{s.open ? `Auction open · ${(Number(s.discountWad) / 1e16).toFixed(2)}% discount` : s.liquidatable ? "Liquidatable · anyone can open an auction" : "Not liquidatable"}</b> · health {s.healthWad >= 2n ** 255n ? "n/a" : (Number(s.healthWad) / 1e18).toFixed(2)}{s.open ? ` → target ${(Number(s.targetHealthWad) / 1e18).toFixed(2)}` : ""}{s.fills ? ` · ${s.fills} fill${s.fills === 1 ? "" : "s"}` : ""}</p>
          <small>If it falls below health 1.00, a 1inch Aqua Dutch maker buys only enough collateral to bring it back to {(s.schedule.targetHealthBps / 10_000).toFixed(2)}; the discount starts at {s.schedule.startBps / 100}% and rises to {s.schedule.capBps / 100}% over {Math.round(s.schedule.durationSeconds / 60)} min. You keep the rest.</small>
        </>
      )}
    </div>
  );
}
