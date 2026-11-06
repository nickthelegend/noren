/**
 * Cross-chain swap: sell a Stock Token on Robinhood Chain, receive USDC on Arc from a 1inch Aqua maker's
 * Chainlink-pegged strategy (packages/xchain-aqua). The taker locks the token in NorenCrossChainEscrow; Chainlink CRE
 * carries the order and the price round to Arc, the maker's Aqua strategy pays; CRE carries the fill back and the
 * escrow releases the token to the maker. On this stack every leg is a local fork (Robinhood mainnet snapshot, Arc
 * testnet fork), and the UI says "fork demo".
 */
import { HOSTED } from "../network";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { buildCrossChainOrder, crossChainSwapStatus, openCrossChainSwap, quoteCrossChainSwap, withSlippage, type CrossChainOrder, type CrossChainQuote, type CrossChainSwapStatus, type Pc, type Wc } from "@noren/xchain-aqua";
import { SERVER } from "../api";
import { msgOf } from "../ui";
import type { Wallet } from "./NorenApp";
import { Band, Coin, Result, SetupCard, Spin, Track, shortHex } from "./kit";
import { fmtUnits, parseAmount, tokenBy } from "./tokens";
import { TxLink } from "../tx";
import { Mark } from "../logos";
import { SWAPVM_ATTRIBUTION } from "./SwapTab";

type XCfg = { settler: Address; escrow: Address; strategyHash: Hex; maker: Address; tokenIn: Address; srcChainId: string | number };
type Relay = { chain: "robinhood" | "arc"; kind?: string; orderId?: Hex; source: Hex; written?: Hex; skipped?: string; error?: string; ms: number };
type Order = { id: number; order: CrossChainOrder; orderId: Hex; openTx?: Hex; status?: CrossChainSwapStatus; error?: string; quoted: bigint; at: number };

export function XChainSwap({ w }: { w: Wallet }) {
  const x = (w.oc.credit as unknown as { xchain?: XCfg } | null)?.xchain ?? null;
  const nvda = tokenBy("NVDA");
  const [amount, setAmount] = useState("1");
  const [slip, setSlip] = useState(50);
  const [q, setQ] = useState<CrossChainQuote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [o, setO] = useState<Order | null>(null);
  const seq = useRef(0);
  const amountIn = useMemo(() => parseAmount(amount, 18), [amount]);
  const have = w.hold?.stocks.find((s) => s.sym === "NVDA")?.balance;
  const clients = useMemo(() => {
    if (!x || !w.oc.credit?.robinhoodRpc) return null;
    const { pub, wallet } = w.oc.robinhood();
    return { source: pub as unknown as Pc, wallet: wallet as unknown as Wc, arc: createPublicClient({ transport: http(w.cfg.rpcUrl) }) as unknown as Pc };
  }, [x, w.oc, w.cfg.rpcUrl]);

  useEffect(() => {
    if (!x || !clients || !amountIn) { setQ(null); return; }
    const id = ++seq.current; setQErr(null);
    const t = setTimeout(() => quoteCrossChainSwap({ source: clients.source, arc: clients.arc, escrow: x.escrow, settler: x.settler, tokenIn: x.tokenIn, strategyHash: x.strategyHash, amountIn })
      .then((r) => id === seq.current && setQ(r)).catch((e) => id === seq.current && (setQ(null), setQErr(msgOf(e)))), 350);
    return () => clearTimeout(t);
  }, [x, clients, amountIn, w.tick]);

  // Follow an open order on both chains until the escrow releases (or refunds).
  useEffect(() => {
    if (!o || !x || !clients || o.error || o.status?.next === "done" || o.status?.next === "refunded") return;
    const t = setInterval(() => crossChainSwapStatus({ source: clients.source, arc: clients.arc, escrow: x.escrow, settler: x.settler, order: o.order })
      .then((s) => { setO((v) => (v && v.id === o.id ? { ...v, status: s } : v)); if (s.next === "done") w.refresh(); }).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [o, x, clients, w]);

  if (!x) return <div className="nk-pad"><SetupCard title="Cross-chain Aqua isn't deployed on this stack" text="pnpm dev:all deploys the escrow on the Robinhood Chain mainnet snapshot and the settler with an Aqua maker on the Arc fork, then relays orders through the Chainlink CRE simulator. It was skipped or failed; its log line says why." code="pnpm dev:all" /></div>;

  const insufficient = !!amountIn && have !== undefined && amountIn > have;
  const blocked = q && (!q.fresh || !q.makerCanPay);
  const open = async () => {
    if (!clients || !amountIn || !q) return;
    setBusy("Building the order…");
    const id = Date.now();
    try {
      const order = await buildCrossChainOrder({ source: clients.source, arc: clients.arc, escrow: x.escrow, settler: x.settler, taker: w.oc.address, recipient: w.oc.address, tokenIn: x.tokenIn, amountIn, maker: q.maker, strategyHash: x.strategyHash, minAmountOut: withSlippage(q.amountOut, slip) });
      setBusy("Locking NVDA in the Robinhood escrow…");
      const r = await openCrossChainSwap({ source: clients.source, wallet: clients.wallet, escrow: x.escrow, order });
      setO({ id, order, orderId: r.orderId, openTx: r.txHash, quoted: q.amountOut, at: Date.now() });
      w.refresh();
    } catch (e) { setO({ id, order: {} as CrossChainOrder, orderId: "0x" as Hex, error: msgOf(e), quoted: q.amountOut, at: Date.now() }); }
    finally { setBusy(null); }
  };

  return (
    <>
      <div className="nk-box">
        <label htmlFor="nk-xin"><span>You sell · <span className="lg-row" style={{ display: "inline-flex" }}><Mark id="ROBINHOOD" size={14} />Robinhood Chain</span></span></label>
        <div className="nk-row"><input id="nk-xin" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span className="nk-token" data-static="true"><Coin t={nvda} />NVDA</span></div>
        <div className="nk-sub"><span>{q ? `≈ $${(Number(q.priceUsd8) / 1e8).toFixed(2)} at Chainlink NVDA/USD` : " "}</span><span>Balance {have !== undefined ? <button type="button" onClick={() => setAmount(String(Number(have) / 1e18))}>{fmtUnits(have, 18, 4)}</button> : "–"}</span></div>
      </div>
      <div className="nk-flip" aria-hidden style={{ cursor: "default" }}>↓</div>
      <div className="nk-box">
        <span className="nk-l"><span>You receive · <span className="lg-row" style={{ display: "inline-flex" }}><Mark id="ARC" size={14} />Arc</span></span><span>to {shortHex(w.oc.address, 4)}</span></span>
        <div className="nk-row"><output className={q ? "" : "dim"} aria-live="polite">{q ? fmtUnits(q.amountOut, 6, 2) : amountIn && !qErr ? "…" : "0"}</output><span className="nk-token" data-static="true"><Coin t={{ sym: "USDC" }} />USDC</span></div>
        <div className="nk-sub"><span>{q ? `${(q.spreadBps / 100).toFixed(2)}% maker spread${q.marketClosed ? " (US market closed)" : ""}` : " "}</span><span>min {q ? fmtUnits(withSlippage(q.amountOut, slip), 6, 2) : "–"}</span></div>
      </div>
      {amountIn !== null && (
        <div className="nk-routes" aria-label="Cross-chain route">
          {qErr ? <div className="nk-err">{qErr}</div> : !q ? <div className="nk-skel"><i /><i /></div> : (
            <div className="nk-route" data-best={!blocked}>
              <Mark id="1INCH" size={32} />
              <div><b>1inch Aqua maker on Arc</b><small>Maker {shortHex(q.maker, 4)} · Chainlink round {q.priceAgeSec.toString()} s old (max {q.maxAgeSec.toString()} s) · carried to Arc by Chainlink CRE{q.problems.length ? ` · ${q.problems.join("; ")}` : ""}</small></div>
              <div className="r"><b>{fmtUnits(q.amountOut, 6, 2)}</b><small>{blocked ? <span className="tag" style={{ color: "var(--nk-bad)" }}>Can't fill</span> : <span className="tag">USDC on Arc</span>}</small></div>
            </div>
          )}
          <p className="nk-attrib">{SWAPVM_ATTRIBUTION}</p>
        </div>
      )}
      <Band label="Max slippage" value={slip} options={[30, 50, 100]} onChange={setSlip} fmt={(b) => `${(b / 100).toFixed(1)}%`} />
      <button className="nk-cta" disabled={!!busy || !amountIn || !q || !!blocked || insufficient} onClick={open}>
        {busy ? <><Spin /> {busy}</> : !amountIn ? "Enter an amount" : insufficient ? "Not enough NVDA" : !q ? "Quoting the Arc maker…" : blocked ? "The maker can't fill this now" : `Sell ${amount} NVDA for USDC on Arc`}
      </button>
      <p className="nk-fine">{HOSTED ? <><b>Snapshot demo.</b> Robinhood Chain · mainnet snapshot. The NVDA route needs Robinhood's mainnet stock feeds, so its Robinhood leg runs on the snapshot.</> : <><b>Fork demo.</b> Robinhood runs as a local snapshot of mainnet and Arc as a local testnet fork; The NVDA route needs Robinhood's mainnet stock feeds, so it runs on forks.</>} Aqua itself is live on Arc testnet (official v1.0.0 at <code>0x550C…895B</code>, USDC → EURC and CCTP orders, docs/AQUA-LIVE.md). The CRE workflow runs in the simulator with <code>--broadcast</code>.</p>
      <AnimatePresence initial={false}>{o && <XOrder key={o.id} o={o} />}</AnimatePresence>
    </>
  );
}

function XOrder({ o }: { o: Order }) {
  const [relay, setRelay] = useState<Relay[]>([]);
  useEffect(() => {
    if (o.error) return;
    let on = true;
    const load = () => fetch(`${SERVER}/xchain/orders`).then((r) => (r.ok ? r.json() : [])).then((j: Relay[] | { orders?: Relay[] }) => on && setRelay(Array.isArray(j) ? j : j.orders ?? [])).catch(() => {});
    load(); const t = setInterval(load, 2500);
    return () => { on = false; clearInterval(t); };
  }, [o.error]);
  const s = o.status;
  const mine = relay.filter((r) => r.orderId?.toLowerCase() === o.orderId.toLowerCase());
  const fillTx = mine.find((r) => r.chain === "robinhood" && r.written)?.written;
  const releaseTx = mine.find((r) => r.chain === "arc" && r.written)?.written;
  const done = s?.next === "done";
  return (
    <Result tone={o.error ? "bad" : done ? "good" : ""} tag="Cross-chain · mainnet snapshot" link={o.openTx ? <TxLink chain="robinhood" hash={o.openTx} n={6} /> : undefined}
      title={o.error ? "Order did not open" : done ? `Received ${fmtUnits(s!.fill?.amountOut ?? o.quoted, 6, 2)} USDC on Arc` : s?.arc === "Filled" ? "Filled on Arc. Releasing NVDA to the maker…" : "Locked on Robinhood. Waiting for the Arc maker…"}
      body={o.error ?? (s?.next === "expire-on-arc" ? "The fill deadline passed: the order can be expired on Arc and refunded on Robinhood." : undefined)}
      kv={[["Quoted", `${fmtUnits(o.quoted, 6, 2)} USDC`], ["Paid on Arc", s?.fill ? `${fmtUnits(s.fill.amountOut, 6, 2)} USDC` : "…"], ["Escrow", s?.escrow ?? "…"]]}>
      {!o.error && <div style={{ marginTop: 16 }}><Track steps={[
        { k: "Locked on Robinhood", on: !!o.openTx, d: <TxLink chain="robinhood" hash={o.openTx} n={4} /> },
        { k: "Paid by the Aqua maker", on: s?.arc === "Filled", d: fillTx ? <TxLink chain="arc" hash={fillTx} n={4} /> : "via Chainlink CRE" },
        { k: "NVDA to the maker", on: done, d: releaseTx ? <TxLink chain="robinhood" hash={releaseTx} n={4} /> : "" },
      ]} /></div>}
    </Result>
  );
}
