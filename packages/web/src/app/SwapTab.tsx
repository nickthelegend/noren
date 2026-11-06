/**
 * Swap: best price via Uniswap v4; Noren's 1inch Aqua maker fills only when its Chainlink-pegged quote beats it.
 * Three markets: USDC → EURC on the public Arc testnet (ArcSwap, real transactions), Stock Tokens, ETH and USDG on
 * the Robinhood Chain fork, and "Cross-chain", which sells a Stock Token on Robinhood for USDC on Arc from an Arc
 * Aqua maker (XChainSwap, fork demo). Swaps are public.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { msgOf } from "../ui";
import type { Wallet } from "./NorenApp";
import { swapper, type RouteMiss, type RouteQuote, type SwapQuote } from "./swap";
import { TOKENS, USDG_TOKEN, fmtUnits, parseAmount, tokenBy, type Token } from "./tokens";
import { Band, Card, Result, Spin, TokenButton, shortHex } from "./kit";
import { XChainSwap } from "./XChainSwap";
import { ArcSwap } from "./ArcSwap";
import { TxLink } from "../tx";
import { Mark } from "../logos";

type Done = { id: number; route: RouteQuote; other: RouteQuote | null; tin: Token; tout: Token; amountIn: bigint; hash?: string; received?: bigint; gasWei?: bigint; error?: string; step?: string };
export const SWAPVM_ATTRIBUTION = "Powered by SwapVM — © Degensoft Ltd 2025";

export function SwapTab({ w }: { w: Wallet }) {
  const sw = useMemo(() => swapper(w.cfg, w.oc), [w.cfg, w.oc]);
  const [tin, setTin] = useState<Token>(tokenBy("NVDA"));
  const [tout, setTout] = useState<Token>(USDG_TOKEN);
  const [amount, setAmount] = useState("0.5");
  const [slip, setSlip] = useState(50);
  const [q, setQ] = useState<SwapQuote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [market, setMarket] = useState<"arc" | "rh" | "xc">("arc");
  const xc = market === "xc";
  const seq = useRef(0);
  const amountIn = useMemo(() => parseAmount(amount, tin.decimals), [amount, tin.decimals]);

  const balances = useMemo(() => {
    const h = w.hold; if (!h) return undefined;
    const b: Record<string, bigint> = { USDG: h.usdg, ETH: h.eth };
    for (const s of h.stocks) b[s.sym] = s.balance;
    return b;
  }, [w.hold]);
  const have = balances?.[tin.sym];
  const insufficient = !!amountIn && have !== undefined && amountIn > have;

  // One side is always USDG: Aqua makers and the v4 pools both pair every asset with USDG.
  const pickIn = (t: Token) => { setTin(t); if (t.sym === "USDG" && tout.sym === "USDG") setTout(tokenBy("NVDA")); else if (t.sym !== "USDG") setTout(USDG_TOKEN); };
  const pickOut = (t: Token) => { setTout(t); if (t.sym === "USDG" && tin.sym === "USDG") setTin(tokenBy("NVDA")); else if (t.sym !== "USDG") setTin(USDG_TOKEN); };
  const flip = () => { setTin(tout); setTout(tin); setAmount(""); setQ(null); };

  useEffect(() => {
    if (!amountIn) { setQ(null); setQErr(null); return; }
    const id = ++seq.current; setLoading(true); setQErr(null);
    const t = setTimeout(() => {
      sw.quote(tin, tout, amountIn).then((x) => { if (id === seq.current) setQ(x); }).catch((e) => { if (id === seq.current) { setQ(null); setQErr(msgOf(e)); } }).finally(() => id === seq.current && setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [sw, tin, tout, amountIn, w.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const best = q?.best ?? null;
  const other = q ? (q.routes.find((r): r is RouteQuote => "out" in r && r !== best) ?? null) : null;
  const stale = !!q && !!amountIn && Date.now() - q.at > 30_000;

  const swap = async () => {
    if (!best || !amountIn) return;
    setBusy(true);
    const d: Done = { id: Date.now(), route: best, other, tin, tout, amountIn, step: "Starting…" };
    setDone(d);
    try {
      const r = await sw.execute(best, tin, tout, amountIn, slip, (s) => setDone((x) => (x && x.id === d.id ? { ...x, step: s } : x)));
      setDone({ ...d, hash: r.hash, received: r.received, gasWei: r.gasWei, step: undefined });
      w.refresh();
    } catch (e) { setDone({ ...d, error: msgOf(e), step: undefined }); }
    finally { setBusy(false); }
  };

  const fairUnit = q?.fair ?? null;
  const vsFair = (out: bigint) => (fairUnit && fairUnit > 0n ? (Number(out - fairUnit) / Number(fairUnit)) * 100 : null);

  return (
    <div className="nk-col">
      <section className="nk-card" aria-label="Swap">
        <div className="nk-card-h"><div><b>Swap</b><p>Best price via Uniswap v4; Noren's Aqua maker fills when it beats it.</p></div>{market === "arc" ? <span className="nk-pill live"><Mark id="ARC" size={16} />Arc testnet</span> : xc ? <span className="nk-pill fork"><Mark id="ROBINHOOD" size={16} />→<Mark id="ARC" size={16} />fork demo</span> : <span className={`nk-pill ${q?.marketClosed ? "warn" : "fork"}`}>{q?.marketClosed ? "US market closed" : <><Mark id="ROBINHOOD" size={16} />Robinhood fork</>}</span>}</div>
        <div className="nk-band nk-markets" role="tablist" aria-label="Market">
          {([["arc", "USDC → EURC on Arc"], ["rh", "Stocks on Robinhood"], ["xc", "Stock → USDC on Arc"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={market === k} aria-pressed={market === k} onClick={() => setMarket(k)}>{l}</button>)}
        </div>
        {market === "arc" ? <ArcSwap /> : xc ? <XChainSwap w={w} /> : <>
        <div className="nk-box">
          <label htmlFor="nk-in"><span>You pay</span></label>
          <div className="nk-row">
            <input id="nk-in" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            <TokenButton t={tin} onPick={pickIn} exclude={undefined} balances={balances} label="You pay" />
          </div>
          <div className="nk-sub">
            <span>{fairUnit && tout.sym === "USDG" ? `≈ $${fmtUnits(fairUnit, 6, 2)} at Chainlink` : fairUnit && tin.sym === "USDG" ? `≈ ${fmtUnits(fairUnit, tout.decimals, 5)} ${tout.sym} at Chainlink` : " "}</span>
            <span>Balance {have !== undefined ? <button type="button" onClick={() => setAmount(String(Number(have) / 10 ** tin.decimals))}>{fmtUnits(have, tin.decimals, 4)}</button> : "–"}</span>
          </div>
        </div>
        <button className="nk-flip" aria-label="Switch direction" onClick={flip}>↓</button>
        <div className="nk-box">
          <span className="nk-l"><span>You receive</span><span>{best ? (best.id === "aqua" ? "via 1inch Aqua" : "via Uniswap v4") : ""}</span></span>
          <div className="nk-row">
            <output className={best ? "" : "dim"} aria-live="polite">{best ? fmtUnits(best.out, tout.decimals, tout.decimals === 6 ? 2 : 5) : loading ? "…" : "0"}</output>
            <TokenButton t={tout} onPick={pickOut} balances={balances} label="You receive" />
          </div>
          <div className="nk-sub"><span>{best && vsFair(best.out) !== null ? `${vsFair(best.out)! >= 0 ? "+" : ""}${vsFair(best.out)!.toFixed(2)}% vs Chainlink` : " "}</span><span>Balance {balances?.[tout.sym] !== undefined ? fmtUnits(balances[tout.sym], tout.decimals, 4) : "–"}</span></div>
        </div>

        {amountIn !== null && (q || loading) && (
          <div className="nk-routes" aria-label="Routes">
            {loading && !q ? <div className="nk-skel"><i /><i /></div> : [...(q?.routes ?? [])].sort((a, b) => (a.id === "v4" ? -1 : b.id === "v4" ? 1 : 0)).map((r) => <RouteRow key={r.id} r={r} best={best} tout={tout} fair={q?.fair ?? null} />)}
            {q?.routes.some((r) => r.id === "aqua") && <p className="nk-attrib">{SWAPVM_ATTRIBUTION}</p>}
          </div>
        )}
        {qErr && <div className="nk-err" role="alert">{qErr}</div>}
        <Band label="Max slippage" value={slip} options={[30, 50, 100]} onChange={setSlip} fmt={(b) => `${(b / 100).toFixed(1)}%`} />

        {w.holdErr ? <div className="nk-err" role="alert">{w.holdErr}</div> : null}
        <button className="nk-cta" disabled={busy || !amountIn || !best || insufficient || stale} onClick={swap}>
          {busy ? <><Spin /> {done?.step ?? "Swapping…"}</> : !amountIn ? "Enter an amount" : insufficient ? `Not enough ${tin.sym}` : loading && !q ? "Finding the best price…" : !best ? "No route can fill this" : stale ? "Refreshing the quote…" : `Swap on ${best.id === "aqua" ? "1inch Aqua" : "Uniswap v4"}`}
        </button>
        {insufficient && <p className="nk-fine">Short on {tin.sym}? Your wallet menu (top right) has a test faucet for NVDA and USDG; ETH comes with it for gas.</p>}
        </>}
      </section>

      <AnimatePresence mode="popLayout">{market === "rh" && done && <SwapDone key={done.id} d={done} />}</AnimatePresence>
    </div>
  );
}

function RouteRow({ r, best, tout, fair }: { r: RouteQuote | RouteMiss; best: RouteQuote | null; tout: Token; fair: bigint | null }) {
  const name = r.id === "aqua" ? "Noren's Aqua maker" : "Uniswap v4";
  if (!("out" in r)) return (
    <div className="nk-route" data-dead="true"><Mark id={r.id === "aqua" ? "1INCH" : "UNISWAP"} size={32} /><div><b>{name}</b><small>{r.error}</small></div><div className="r"><b>–</b></div></div>
  );
  const isBest = best === r;
  const diff = best && !isBest ? best.out - r.out : 0n;
  const detail = r.id === "aqua" ? `Fills only when it beats Uniswap · pegged to Chainlink · maker ${shortHex(r.maker, 4)} · ${(r.spreadBps / 100).toFixed(2)}% spread` : `Default route · pool ${(r.key.fee / 10_000).toFixed(2)}% fee · tick spacing ${r.key.tickSpacing} · no hooks`;
  return (
    <div className="nk-route" data-best={isBest}>
      <Mark id={r.id === "aqua" ? "1INCH" : "UNISWAP"} size={32} />
      <div><b>{name}</b><small>{detail}</small></div>
      <div className="r"><b>{fmtUnits(r.out, tout.decimals, tout.decimals === 6 ? 2 : 5)}</b><small>{isBest ? <span className="tag">Best price</span> : `−${fmtUnits(diff, tout.decimals, tout.decimals === 6 ? 2 : 5)} ${tout.sym}`}{fair ? "" : ""}</small></div>
    </div>
  );
}

function SwapDone({ d }: { d: Done }) {
  const pending = !d.hash && !d.error;
  const venue = d.route.id === "aqua" ? "1inch Aqua maker" : "Uniswap v4";
  const saved = d.other && d.received !== undefined ? d.route.out - d.other.out : null;
  return (
    <Result
      tone={pending ? "" : d.error ? "bad" : "good"}
      tag={`${venue} · Robinhood fork`}
      link={d.hash ? <TxLink chain="robinhood" hash={d.hash} n={8} /> : undefined}
      title={pending ? d.step ?? "Swapping…" : d.error ? "Swap did not complete" : `Received ${fmtUnits(d.received ?? 0n, d.tout.decimals, d.tout.decimals === 6 ? 2 : 6)} ${d.tout.sym}`}
      body={d.error ? d.error : pending ? `Selling ${fmtUnits(d.amountIn, d.tin.decimals, 5)} ${d.tin.sym}` : undefined}
      kv={[["Quoted", `${fmtUnits(d.route.out, d.tout.decimals, 5)} ${d.tout.sym}`], ["Received", d.received !== undefined ? `${fmtUnits(d.received, d.tout.decimals, 5)} ${d.tout.sym}` : pending ? "…" : "—"], ["Gas", d.gasWei !== undefined ? `${(Number(d.gasWei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 7 })} ETH` : "…"]]}
    >
      {saved !== null && saved > 0n && !d.error && (
        <div className="nk-saved"><small>Better than {d.other!.id === "aqua" ? "the Aqua maker" : "Uniswap v4"} quoted for the same size</small><b>+{fmtUnits(saved, d.tout.decimals, d.tout.decimals === 6 ? 2 : 5)} {d.tout.sym}</b></div>
      )}
      {d.route.id === "aqua" && <p className="nk-attrib">{SWAPVM_ATTRIBUTION}</p>}
    </Result>
  );
}

export { TOKENS };
