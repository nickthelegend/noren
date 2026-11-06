/**
 * The hosted checkout's third method: pay a Noren invoice later, from a credit line on Arc.
 * The browser calls NorenCreditLine.payInvoice; the merchant server sees the Drawn log and marks the invoice paid.
 */
import { useCallback, useEffect, useState } from "react";
import { api, short, usdc, type Config, type InvoiceView } from "./api";
import { Icon, msgOf } from "./ui";
import { payoutOf } from "./kit";
import type { Line, Onchain } from "./onchain";

export function CreditPay({ cfg, view, shop, onPaid }: { cfg: Config; view: InvoiceView; shop: string; onPaid: () => void }) {
  const [tk, setTk] = useState<Onchain | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gas, setGas] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: string; bad?: boolean } | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [n, setN] = useState<number | null>(null);
  useEffect(() => { if (tk) import("./credit-actions").then((m) => m.creditActions(cfg, tk).installments()).then(setN).catch(() => setN(null)); }, [tk, cfg]);

  useEffect(() => { import("./onchain").then((m) => setTk(m.makeOnchain(cfg))).catch((e) => setErr(msgOf(e))); }, [cfg]);
  const load = useCallback(async () => {
    if (!tk) return;
    try { setLines(await tk.lines()); setErr(null); } catch (e) { setErr(msgOf(e)); }
    try { setGas(await tk.arcGas()); } catch { setGas(null); }
  }, [tk]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const amount = BigInt(view.invoice.amount);
  const line = lines?.filter((l) => !l.closed).at(-1);
  const available = line ? (line.limit > line.drawn - line.repaid ? line.limit - (line.drawn - line.repaid) : 0n) : 0n;
  const parts = n ? Array.from({ length: n }, (_, i) => (i === n - 1 ? amount - (amount / BigInt(n)) * BigInt(n - 1) : amount / BigInt(n))) : [];

  if (err) return <div className="co-setup"><span className="eyebrow">Setup required</span><p>{err.replace(/^Setup required:\s*/, "")}</p></div>;
  if (!lines) return <div className="co-setup quiet"><span className="spin xs" /> Reading your credit line on Robinhood and Arc…</div>;
  if (!line) return (
    <div className="co-credit-empty">
      <p><b>You don't have a credit line yet.</b> Lock Stock Tokens on Robinhood Chain to open a credit line. It reaches Arc through a Chainlink CRE workflow in a few seconds.</p>
      <a className="btn line full" href="#/app">Open a credit line in the Noren app <Icon.arrow /></a>
    </div>
  );

  const pay = async () => {
    setBusy("pay"); setNote(null);
    try {
      const payout = await payoutOf(cfg.rpcUrl, cfg.deployment.checkout, view.invoice.merchant);
      const to = (/^0x0{40}$/.test(payout) ? view.invoice.merchant : payout) as `0x${string}`;
      const r = await tk!.payInvoice(line.lineId, to, amount, view.invoice.invoiceId);
      setTx(r.hash); setNote({ t: `Paid from your credit line (tx ${short(r.hash, 6)}). Waiting for ${shop} to see it…` });
      onPaid();
    } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); load(); }
  };
  const needGas = gas !== null && gas === 0n;

  return (
    <div className="co-credit">
      <div className="co-bal">
        <div><span>Available credit</span><b>{usdc(available)}<em>USDC</em></b></div>
        <div><span>Line</span><b className="mono sm">{short(line.lineId, 4)}</b><small className="faint">limit {usdc(line.limit)}</small></div>
      </div>
      <p className="co-plan-h">{parts.length ? `Suggested: repay in ${parts.length} parts` : "Repay any amount, any time,"} before the line expires on {new Date(line.expiry * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}.</p>
      {parts.length > 0 && <ol className="co-plan" aria-label="Suggested repayment plan" style={{ gridTemplateColumns: `repeat(${parts.length}, minmax(0, 1fr))` }}>
        {parts.map((v, i) => <li key={i}><i>{i + 1}</i><span>{i === 0 ? "First" : i === parts.length - 1 ? "Last" : `Part ${i + 1}`}</span><b className="num">{usdc(v)}</b></li>)}
      </ol>}
      <div className="co-privacy light">
        <Icon.layers />
        <p><b>Not private.</b> A credit payment is tied to your credit line, and the line to your Robinhood wallet. {shop} is paid in full now; you repay the pool in USDC.</p>
      </div>
      {needGas && (
        <button className="btn line full" disabled={!!busy} onClick={async () => { setBusy("gas"); try { await api.faucet(tk!.address); await load(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); } }}>
          {busy === "gas" ? <><span className="spin" /> Sending…</> : "Get test gas on Arc"}
        </button>
      )}
      {note && <p className={note.bad ? "err" : "note"} role="status">{note.t}</p>}
      <button className="btn kaki full xl" disabled={!!busy || !!tx || available < amount || needGas} onClick={pay}>
        {busy === "pay" ? <><span className="spin" /> Paying from your line…</> : available < amount ? `Not enough credit (${usdc(available)} USDC)` : <><Icon.layers /> Pay {usdc(amount)} USDC on credit</>}
      </button>
      <p className="faint sm center">NorenCreditLine.payInvoice on Arc, signed by your test key in this browser.</p>
    </div>
  );
}
