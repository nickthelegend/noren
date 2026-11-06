/**
 * The hosted checkout's third method: pay a Noren invoice from a Tsuke credit line on Arc.
 * The browser calls NorenCreditLine.payInvoice; the merchant server sees the Drawn log and marks the invoice paid.
 */
import { useCallback, useEffect, useState } from "react";
import { api, short, usdc, type Config, type InvoiceView } from "./api";
import { Icon, msgOf } from "./ui";
import { payoutOf } from "./kit";
import type { Line, Tsuke } from "./tsuke";

export function CreditPay({ cfg, view, shop, onPaid }: { cfg: Config; view: InvoiceView; shop: string; onPaid: () => void }) {
  const [tk, setTk] = useState<Tsuke | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gas, setGas] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: string; bad?: boolean } | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  useEffect(() => { import("./tsuke").then((m) => setTk(m.makeTsuke(cfg))).catch((e) => setErr(msgOf(e))); }, [cfg]);
  const load = useCallback(async () => {
    if (!tk) return;
    try { setLines(await tk.lines()); setErr(null); } catch (e) { setErr(msgOf(e)); }
    try { setGas(await tk.arcGas()); } catch { setGas(null); }
  }, [tk]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const amount = BigInt(view.invoice.amount);
  const line = lines?.filter((l) => !l.closed).at(-1);
  const available = line ? (line.limit > line.drawn - line.repaid ? line.limit - (line.drawn - line.repaid) : 0n) : 0n;
  const part = amount / 4n, last = amount - part * 3n;

  if (err) return <div className="co-setup"><span className="eyebrow">Setup required</span><p>{err.replace(/^Setup required:\s*/, "")}</p></div>;
  if (!lines) return <div className="co-setup quiet"><span className="spin xs" /> Reading your credit line on Robinhood and Arc…</div>;
  if (!line) return (
    <div className="co-credit-empty">
      <p><b>You don't have a tab yet.</b> Lock Stock Tokens on Robinhood Chain to open a credit line. It reaches Arc through a Chainlink CRE workflow in a few seconds.</p>
      <a className="btn line full" href="#/credit">Open a tab with your stock <Icon.arrow /></a>
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
      <ol className="co-plan" aria-label="Repayment plan">
        {[part, part, part, last].map((v, i) => <li key={i}><i>{i + 1}</i><span>{i === 0 ? "First" : i === 3 ? "Last" : `Part ${i + 1}`}</span><b className="num">{usdc(v)}</b></li>)}
      </ol>
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
