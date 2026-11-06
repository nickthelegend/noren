/**
 * Hosted checkout, "Pay with stocks or crypto": the merchant server mirrors the invoice onto NorenGateway on Robinhood
 * Chain, the customer pays it with any Stock Token they hold or with ETH (asset 0x0, priced as WETH) at the Chainlink
 * price, a 1inch Aqua maker (or the vault) buys it, and the merchant gets USDG. The merchant server sees InvoicePaid and settles the Noren invoice.
 */
import { useCallback, useEffect, useState } from "react";
import { api, short, usdc, type Config, type InvoiceView } from "./api";
import { Icon, msgOf } from "./ui";
import { useSigner } from "./signer";
import { NATIVE_ETH, USDG, usd8, units, type Holding, type Onchain } from "./onchain";
import { swapper, type RouteQuote } from "./app/swap";
import { TOKENS, USDG_TOKEN } from "./app/tokens";
import type { ReactNode } from "react";
import { TxLink } from "./tx";
import { Mark } from "./logos";

type Mirror = Awaited<ReturnType<typeof api.mirrorOnRobinhood>>;

/** Gas kept back when paying with ETH itself. */
const ETH_GAS_RESERVE = 2_000_000_000_000_000n;

export function StockPay({ cfg, view, shop, onPaid }: { cfg: Config; view: InvoiceView; shop: string; onPaid: () => void }) {
  const [tk, setTk] = useState<Onchain | null>(null);
  const [mirror, setMirror] = useState<Mirror | null>(null);
  const [hold, setHold] = useState<Holding[] | null>(null);
  const [eth, setEth] = useState<bigint | null>(null);
  const [sym, setSym] = useState<string | null>(null);
  const [q, setQ] = useState<Awaited<ReturnType<Onchain["stockQuote"]>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: ReactNode; bad?: boolean } | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [v4, setV4] = useState<{ need: bigint; route: RouteQuote } | { error: string } | null>(null);
  const [via, setVia] = useState<"aqua" | "v4">("aqua");

  // Re-created when the active wallet changes (an injected browser wallet restores after the first render).
  const signer = useSigner();
  useEffect(() => { import("./onchain").then((m) => setTk(m.makeOnchain(cfg))).catch((e) => setErr(msgOf(e))); }, [cfg, signer.signerKey]);
  useEffect(() => {
    let on = true;
    // The server mirrors once per invoice (it serialises concurrent calls), so a double effect in dev mode is harmless.
    api.mirrorOnRobinhood(view.invoice.invoiceId).then((m) => on && setMirror(m)).catch((e) => on && setErr(msgOf(e)));
    return () => { on = false; };
  }, [view.invoice.invoiceId]);
  const load = useCallback(async () => {
    if (!tk) return;
    try {
      const h = await tk.holdings();
      // ETH is a way to pay too (NorenGateway asset 0x0); keep 0.002 ETH back for gas.
      const ethPay = h.eth > ETH_GAS_RESERVE ? [{ sym: "ETH", name: "Ether", token: NATIVE_ETH, feed: NATIVE_ETH, balance: h.eth - ETH_GAS_RESERVE, price8: 0n, updatedAt: 0, value8: 0n } as Holding] : [];
      setHold([...h.stocks.filter((s) => s.balance > 0n), ...ethPay]); setEth(h.eth); setErr(null);
    } catch (e) { setErr(msgOf(e)); }
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

  // Uniswap v4 comparison: how much of the same stock buys the invoice's USDG on the v4 pool (exact-in quote of the
  // Aqua amount, scaled, plus 0.5% so slippage can't leave the invoice short). The v4 route swaps, then pays in USDG.
  useEffect(() => {
    if (!tk || !q || !s || s.sym === "ETH" || q.route !== "aqua-maker") { setV4(null); return; }
    let on = true;
    const tin = TOKENS.find((t) => t.sym === s.sym)!;
    const sw = swapper(cfg, tk);
    sw.quote(tin, USDG_TOKEN, q.assetIn).then((r) => {
      if (!on) return;
      const u = r.routes.find((x): x is RouteQuote => x.id === "v4" && "out" in x);
      if (!u) { setV4({ error: (r.routes.find((x) => x.id === "v4") as { error?: string })?.error ?? "No Uniswap v4 pool can fill this" }); return; }
      const need = (q.assetIn * BigInt(mirror!.amountUsdg) * 10050n) / (u.out * 10000n) + 1n;
      setV4({ need, route: u });
    }).catch((e) => on && setV4({ error: msgOf(e) }));
    return () => { on = false; };
  }, [tk, q?.assetIn, s?.sym]); // eslint-disable-line react-hooks/exhaustive-deps
  const v4ok = v4 && "need" in v4 ? v4 : null;
  const v4Better = !!v4ok && !!q && v4ok.need < q.assetIn;
  useEffect(() => { setVia(v4Better ? "v4" : "aqua"); }, [v4Better]);

  if (err) return <div className="co-setup"><span className="eyebrow">Setup required</span><p>{err.replace(/^Setup required:\s*/, "")}</p></div>;
  if (!hold || !mirror) return <div className="co-setup quiet"><span className="spin xs" /> Opening this invoice on Robinhood Chain…</div>;
  if (!hold.length) return (
    <div className="co-credit-empty">
      <p><b>No Stock Tokens or ETH in this wallet.</b> On the test network you can take a few real NVDA tokens from the fork faucet.</p>
      <button className="btn line full" disabled={!!busy} onClick={async () => { setBusy("faucet"); try { await api.robinhoodFaucet(tk!.address); await load(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); } }}>{busy === "faucet" ? <><span className="spin" /> Moving tokens…</> : "Get test stock"}</button>
      {note && <p className={note.bad ? "err" : "note"}>{note.t}</p>}
    </div>
  );
  const needIn = via === "v4" && v4ok ? v4ok.need : q?.assetIn;
  const enough = !!s && !!needIn && s.balance >= needIn;
  const pay = async () => {
    if (!s || !q || !tk) return;
    setBusy("pay"); setNote(null);
    try {
      let h: string;
      if (via === "v4" && v4ok) {
        const tin = TOKENS.find((t) => t.sym === s.sym)!;
        setNote({ t: `Selling ${units(v4ok.need, 18, 6)} ${s.sym} on Uniswap v4…` });
        const fresh = await swapper(cfg, tk).quote(tin, USDG_TOKEN, v4ok.need);
        const r = fresh.routes.find((x): x is RouteQuote => x.id === "v4" && "out" in x);
        if (!r || r.out < BigInt(mirror.amountUsdg)) throw new Error("The Uniswap v4 price moved; pick the Aqua route or try again");
        await swapper(cfg, tk).execute(r, tin, USDG_TOKEN, v4ok.need, 50, (t) => setNote({ t }));
        setNote({ t: `Paying ${usdc(mirror.amountUsdg)} USDG to ${shop}…` });
        h = await tk.payWithStock(mirror.gateway, mirror.merchant, mirror.invoiceId, USDG, BigInt(mirror.amountUsdg));
      } else if (s.token === NATIVE_ETH) h = await tk.payWithEth(mirror.gateway, mirror.merchant, mirror.invoiceId, q.assetIn);
      else h = await tk.payWithStock(mirror.gateway, mirror.merchant, mirror.invoiceId, s.token, q.assetIn);
      setTx(h); setNote({ t: <>Paid on Robinhood Chain (tx <TxLink chain="robinhood" hash={h} />). Waiting for {shop} to see it…</> }); onPaid(); }
    catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); load(); }
  };
  return (
    <div className="co-credit">
      <div className="co-stock-pick" role="radiogroup" aria-label="Stock Token or ETH">
        {hold.map((h) => <button key={h.sym} role="radio" aria-checked={h.sym === sym} onClick={() => setSym(h.sym)}><Mark id={h.sym} size={30} /><span><b>{h.sym}</b><small>{units(h.balance, 18)} {h.sym === "ETH" ? "spendable" : "held"}</small></span></button>)}
      </div>
      <dl className="co-quote">
        <dt>You pay</dt><dd className="lg-row">{sym && <Mark id={sym} size={16} />}<b className="num">{q ? units(q.assetIn, 18, 6) : "…"}</b> {sym}</dd>
        <dt>Chainlink price</dt><dd>{q ? `$${usd8(q.priceUsd8)}` : "…"}</dd>
        {q?.marketClosed && <><dt>US markets</dt><dd><span className="co-closed" title="Saturday, Sunday and Monday before 06:00 UTC the stock feeds pause, so makers add 3% to their spread">markets closed: wider spread</span></dd></>}
        <dt>Best execution</dt><dd>{!q ? "…" : q.route !== "aqua-maker" ? `Noren vault · ${(q.spreadBps / 100).toFixed(2)}% spread` : via === "v4" ? "Uniswap v4 → USDG" : "1inch Aqua maker · SwapVM, Chainlink-pegged"}</dd>
        <dt>{shop} receives</dt><dd className="lg-row"><Mark id="USDG" size={16} />{usdc(mirror.amountUsdg)} USDG on Robinhood Chain</dd>
      </dl>
      {q?.route === "aqua-maker" && sym !== "ETH" && (
        <div className="co-routes" role="radiogroup" aria-label="Route">
          <button role="radio" aria-checked={via === "aqua"} onClick={() => setVia("aqua")}><Mark id="1INCH" size={20} /><span><b>1inch Aqua maker</b><small>SwapVM order pegged to Chainlink, pays {shop} directly</small></span><b className="num">{units(q.assetIn, 18, 6)} {sym}</b></button>
          <button role="radio" aria-checked={via === "v4"} disabled={!v4ok} onClick={() => setVia("v4")}><Mark id="UNISWAP" size={20} /><span><b>Uniswap v4</b><small>{v4ok ? `${(v4ok.route.id === "v4" ? v4ok.route.key.fee / 10000 : 0).toFixed(2)}% pool → USDG, then pays ${shop}; includes 0.5% slippage room` : v4 && "error" in v4 ? v4.error : "Quoting…"}</small></span><b className="num">{v4ok ? `${units(v4ok.need, 18, 6)} ${sym}` : "–"}</b></button>
        </div>
      )}
      <ol className="co-settle" aria-label="How the merchant gets paid">
        <li data-on="true"><b>{shop} gets USDG</b><span>on Robinhood Chain, in the payment tx</span></li>
        <li><b>Settle to Arc</b><span>Chainlink CRE approves a live Relay or Across quote</span></li>
        <li><b>USDC on Arc</b><span>filled by a real relayer (none on a local fork)</span></li>
      </ol>
      <div className="co-privacy light">
        <Icon.chart />
        <p><b>Not private.</b> The payment comes from your Robinhood wallet. A 1inch Aqua maker (or Noren's vault) buys your shares or ETH at the Chainlink price and {shop} gets USDG.</p>
      </div>
      {note && <p className={note.bad ? "err" : "note"} role="status">{note.t}</p>}
      <button className="btn kaki full xl" disabled={!!busy || !!tx || !enough || eth === 0n} onClick={pay}>
        {busy === "pay" ? <><span className="spin" /> Paying on Robinhood…</> : !enough ? `Not enough ${sym}` : eth === 0n ? "No ETH for gas on Robinhood" : <><Icon.chart /> Pay with {needIn ? units(needIn, 18, 4) : ""} {sym}</>}
      </button>
      <p className="faint sm center">NorenGateway.pay on a local Robinhood Chain fork, signed by your test key in this browser.</p>
      <p className="co-attrib mono">Powered by SwapVM — © Degensoft Ltd 2025</p>
    </div>
  );
}
