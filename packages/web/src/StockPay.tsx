/**
 * Hosted checkout, "Pay with stock": the merchant server mirrors the invoice onto NorenGateway on Robinhood Chain,
 * the customer pays it with a Stock Token at the Chainlink price plus the vault's spread, and the vault pays the
 * merchant USDG. The merchant server sees InvoicePaid and settles the Noren invoice.
 */
import { useCallback, useEffect, useState } from "react";
import { api, short, usdc, type Config, type InvoiceView } from "./api";
import { Icon, msgOf } from "./ui";
import { usd8, units, type Holding, type Onchain } from "./onchain";

type Mirror = Awaited<ReturnType<typeof api.mirrorOnRobinhood>>;

export function StockPay({ cfg, view, shop, onPaid }: { cfg: Config; view: InvoiceView; shop: string; onPaid: () => void }) {
  const [tk, setTk] = useState<Onchain | null>(null);
  const [mirror, setMirror] = useState<Mirror | null>(null);
  const [hold, setHold] = useState<Holding[] | null>(null);
  const [eth, setEth] = useState<bigint | null>(null);
  const [sym, setSym] = useState<string | null>(null);
  const [q, setQ] = useState<{ assetIn: bigint; priceUsd8: bigint; marketClosed: boolean; spreadBps: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: string; bad?: boolean } | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  useEffect(() => { import("./onchain").then((m) => setTk(m.makeOnchain(cfg))).catch((e) => setErr(msgOf(e))); }, [cfg]);
  useEffect(() => {
    let on = true;
    // The server mirrors once per invoice (it serialises concurrent calls), so a double effect in dev mode is harmless.
    api.mirrorOnRobinhood(view.invoice.invoiceId).then((m) => on && setMirror(m)).catch((e) => on && setErr(msgOf(e)));
    return () => { on = false; };
  }, [view.invoice.invoiceId]);
  const load = useCallback(async () => {
    if (!tk) return;
    try { const h = await tk.holdings(); setHold(h.stocks.filter((s) => s.balance > 0n)); setEth(h.eth); setErr(null); } catch (e) { setErr(msgOf(e)); }
  }, [tk]);
  useEffect(() => { load(); const t = setInterval(() => { if (!hold) load(); }, 6000); return () => clearInterval(t); }, [load, hold]);
  useEffect(() => { if (!sym && hold?.length) setSym(hold[0].sym); }, [hold, sym]);
  const s = hold?.find((h) => h.sym === sym);
  useEffect(() => {
    if (!tk || !mirror || !s) return;
    let on = true; setQ(null);
    tk.stockQuote(mirror.gateway, mirror.merchant, mirror.invoiceId, s.token).then((x) => on && setQ(x)).catch((e) => on && setNote({ t: msgOf(e), bad: true }));
    const t = setInterval(() => tk.stockQuote(mirror.gateway, mirror.merchant, mirror.invoiceId, s.token).then((x) => on && setQ(x)).catch(() => {}), 10000);
    return () => { on = false; clearInterval(t); };
  }, [tk, mirror, s?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="co-setup"><span className="eyebrow">Setup required</span><p>{err.replace(/^Setup required:\s*/, "")}</p></div>;
  if (!hold || !mirror) return <div className="co-setup quiet"><span className="spin xs" /> Opening this invoice on Robinhood Chain…</div>;
  if (!hold.length) return (
    <div className="co-credit-empty">
      <p><b>No Stock Tokens in this wallet.</b> On the test network you can take a few real NVDA tokens from the fork faucet.</p>
      <button className="btn line full" disabled={!!busy} onClick={async () => { setBusy("faucet"); try { await api.robinhoodFaucet(tk!.address); await load(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); } }}>{busy === "faucet" ? <><span className="spin" /> Moving tokens…</> : "Get test stock"}</button>
      {note && <p className={note.bad ? "err" : "note"}>{note.t}</p>}
    </div>
  );
  const enough = !!s && !!q && s.balance >= q.assetIn;
  const pay = async () => {
    if (!s || !q || !tk) return;
    setBusy("pay"); setNote(null);
    try { const h = await tk.payWithStock(mirror.gateway, mirror.merchant, mirror.invoiceId, s.token, q.assetIn); setTx(h); setNote({ t: `Paid on Robinhood Chain (tx ${short(h, 6)}). Waiting for ${shop} to see it…` }); onPaid(); }
    catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); load(); }
  };
  return (
    <div className="co-credit">
      <div className="co-stock-pick" role="radiogroup" aria-label="Stock Token">
        {hold.map((h) => <button key={h.sym} role="radio" aria-checked={h.sym === sym} onClick={() => setSym(h.sym)}><span className="na-tick sm" aria-hidden>{h.sym[0]}</span><span><b>{h.sym}</b><small>{units(h.balance, 18)} held</small></span></button>)}
      </div>
      <dl className="co-quote">
        <dt>You pay</dt><dd><b className="num">{q ? units(q.assetIn, 18, 6) : "…"}</b> {sym}</dd>
        <dt>Chainlink price</dt><dd>{q ? `$${usd8(q.priceUsd8)}${q.marketClosed ? " · market closed" : ""}` : "…"}</dd>
        <dt>Vault spread</dt><dd>{q ? `${(q.spreadBps / 100).toFixed(2)}%` : "…"}</dd>
        <dt>{shop} receives</dt><dd>{usdc(mirror.amountUsdg)} USDG on Robinhood Chain</dd>
      </dl>
      <div className="co-privacy light">
        <Icon.chart />
        <p><b>Not private.</b> The payment comes from your Robinhood wallet. Noren's stock vault buys your shares at the Chainlink price and pays {shop} in USDG.</p>
      </div>
      {note && <p className={note.bad ? "err" : "note"} role="status">{note.t}</p>}
      <button className="btn kaki full xl" disabled={!!busy || !!tx || !enough || eth === 0n} onClick={pay}>
        {busy === "pay" ? <><span className="spin" /> Paying on Robinhood…</> : !enough ? `Not enough ${sym}` : eth === 0n ? "No ETH for gas on Robinhood" : <><Icon.chart /> Pay with {q ? units(q.assetIn, 18, 4) : ""} {sym}</>}
      </button>
      <p className="faint sm center">NorenGateway.pay on a local Robinhood Chain fork, signed by your test key in this browser.</p>
    </div>
  );
}
