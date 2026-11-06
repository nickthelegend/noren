/**
 * Swap on the public Arc testnet: USDC → EURC. Uniswap v4 is the default route (the v4 PoolManager, V4Quoter and
 * Universal Router at Arc mainnet's addresses also run on Arc testnet, with a USDC/EURC 0.05% pool). Noren's live
 * 1inch Aqua maker (a Chainlink-pegged SwapVM strategy) fills only when its quote beats Uniswap. Real transactions,
 * signed by this browser's test key; it needs testnet USDC on Arc (which is also Arc's gas).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { msgOf } from "../ui";
import { customerAccount } from "../onchain";
import { TxLink } from "../tx";
import { Mark } from "../logos";
import { Copy } from "../ui";
import { arcBalances, executeArcSwap, quoteArcSwap, type ArcQuote, type ArcRoute } from "./arc-swap";
import { Band, Result, Spin } from "./kit";
import { fmtUnits, parseAmount } from "./tokens";

const NAME = { uniswap: "Uniswap v4", aqua: "Noren's Aqua maker" } as const;
type Done = { id: number; route: "uniswap" | "aqua"; amountIn: bigint; quoted: bigint; hash?: string; received?: bigint; error?: string; step?: string };

export function ArcSwap() {
  const me = useMemo(() => customerAccount(), []);
  const [amount, setAmount] = useState("0.05");
  const [slip, setSlip] = useState(50);
  const [q, setQ] = useState<ArcQuote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [bal, setBal] = useState<{ usdc: bigint; eurc: bigint; gas: bigint } | null>(null);
  const [pick, setPick] = useState<"uniswap" | "aqua" | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const amt = useMemo(() => parseAmount(amount, 6), [amount]);

  useEffect(() => { let on = true; arcBalances(me.address).then((b) => on && setBal(b)).catch(() => on && setBal(null)); return () => { on = false; }; }, [me.address, tick]);
  useEffect(() => {
    if (!amt) { setQ(null); return; }
    const id = ++seq.current; setLoading(true); setQErr(null);
    const t = setTimeout(() => quoteArcSwap(amt, me.address).then((x) => id === seq.current && setQ(x)).catch((e) => id === seq.current && (setQ(null), setQErr(msgOf(e)))).finally(() => id === seq.current && setLoading(false)), 350);
    return () => clearTimeout(t);
  }, [amt, me.address, tick]);

  const quotedRoutes = (q?.routes ?? []).filter((r): r is ArcRoute & { out: bigint } => "out" in r);
  const chosen = (pick ? quotedRoutes.find((r) => r.id === pick) : null) ?? q?.best ?? null;
  const uni = quotedRoutes.find((r) => r.id === "uniswap");
  // Arc's gas token is USDC: keep a little for the approval and the swap.
  const gasReserve = 30_000n;
  const short = !!amt && !!bal && bal.usdc < amt + gasReserve;
  const busy = !!done && !done.hash && !done.error;

  const swap = async () => {
    if (!chosen || !amt) return;
    const minOut = (chosen.out * BigInt(10_000 - slip)) / 10_000n;
    const d: Done = { id: Date.now(), route: chosen.id, amountIn: amt, quoted: chosen.out, step: "Starting…" };
    setDone(d);
    try {
      const r = await executeArcSwap({ route: chosen.id, amountIn: amt, minOut, account: me, onStep: (s) => setDone((x) => (x && x.id === d.id ? { ...x, step: s } : x)) });
      setDone({ ...d, hash: r.hash, received: r.received, step: undefined });
    } catch (e) { setDone({ ...d, error: msgOf(e), step: undefined }); }
    setTick((t) => t + 1);
  };

  return (
    <>
      <div className="nk-box">
        <label htmlFor="nk-arc-in"><span>You pay · Arc testnet</span></label>
        <div className="nk-row">
          <input id="nk-arc-in" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="nk-token" data-static="true"><Mark id="USDC" size={28} />USDC</span>
        </div>
        <div className="nk-sub"><span>{q?.fairEurc && amt ? `≈ ${fmtUnits(q.fairEurc, 6, 4)} EURC at Chainlink EUR/USD` : " "}</span><span>Balance {bal ? fmtUnits(bal.usdc, 6, 4) : "–"}</span></div>
      </div>
      <div className="nk-flip" aria-hidden style={{ cursor: "default" }}>↓</div>
      <div className="nk-box">
        <span className="nk-l"><span>You receive</span><span>{chosen ? `via ${NAME[chosen.id]}` : ""}</span></span>
        <div className="nk-row">
          <output className={chosen ? "" : "dim"} aria-live="polite">{chosen ? fmtUnits(chosen.out, 6, 4) : loading ? "…" : "0"}</output>
          <span className="nk-token" data-static="true"><Mark id="EURC" size={28} />EURC</span>
        </div>
        <div className="nk-sub"><span>{chosen && q?.fairEurc ? `${(((Number(chosen.out) - Number(q.fairEurc)) / Number(q.fairEurc)) * 100).toFixed(2)}% vs Chainlink` : " "}</span><span>Balance {bal ? fmtUnits(bal.eurc, 6, 4) : "–"}</span></div>
      </div>

      {amt && (q || loading) && (
        <div className="nk-routes" role="radiogroup" aria-label="Routes">
          {loading && !q ? <div className="nk-skel"><i /><i /></div> : q?.routes.map((r) => {
            const ok = "out" in r;
            const isBest = q.best?.id === r.id;
            const isOn = chosen?.id === r.id;
            return (
              <button key={r.id} type="button" role="radio" aria-checked={isOn} className="nk-route" data-best={isOn} data-dead={!ok} disabled={!ok} onClick={() => setPick(r.id)} style={{ cursor: ok ? "pointer" : "default" }}>
                <Mark id={r.id === "aqua" ? "1INCH" : "UNISWAP"} size={32} />
                <div><b>{NAME[r.id]}</b><small>{ok ? (r.id === "uniswap" ? "Default route · USDC/EURC pool, 0.05% fee, no hooks" : `Chainlink-pegged SwapVM strategy${r.source === "oracle" ? " · quoted from its on-chain oracle" : ""} · fills only when it beats Uniswap`) : r.error}</small></div>
                <div className="r"><b>{ok ? fmtUnits(r.out, 6, 4) : "–"}</b><small>{ok && isBest ? <span className="tag">Best price</span> : ok && uni && r.id === "aqua" ? `${fmtUnits(uni.out - r.out, 6, 4)} below Uniswap` : ok && q.best ? `−${fmtUnits(q.best.out - r.out, 6, 4)}` : ""}</small></div>
              </button>
            );
          })}
          {q?.routes.some((r) => r.id === "aqua") && <p className="nk-attrib">Powered by Aqua and SwapVM — © Degensoft Ltd 2025</p>}
        </div>
      )}
      {qErr && <div className="nk-err" role="alert">{qErr}</div>}
      <Band label="Max slippage" value={slip} options={[30, 50, 100]} onChange={setSlip} fmt={(b) => `${(b / 100).toFixed(1)}%`} />
      {short && (
        <div className="nk-setup" role="status"><span className="nk-tag">Setup required</span><b>Needs {fmtUnits(amt! + gasReserve, 6, 2)} USDC on Arc testnet (amount + gas).</b><p>This is the test key kept in this browser. Fund it at <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a> (Arc Testnet, USDC) or bridge USDC in from the Bridge tab, then <button type="button" className="nk-linkbtn" onClick={() => setTick((t) => t + 1)}>check again</button>.</p><p className="nk-addr"><code>{me.address}</code><Copy text={me.address} /></p></div>
      )}
      <button className="nk-cta" disabled={busy || !amt || !chosen || short || !bal} onClick={swap}>
        {busy ? <><Spin /> {done?.step ?? "Swapping…"}</> : !amt ? "Enter an amount" : loading && !q ? "Finding the best price…" : !chosen ? "No route can fill this" : short ? "Fund the test key first" : `Swap on ${NAME[chosen.id]}`}
      </button>
      {done && (
        <Result tone={done.error ? "bad" : done.hash ? "good" : ""} tag={`${NAME[done.route]} · Arc testnet`} link={done.hash ? <TxLink chain="arc-live" hash={done.hash} n={8} /> : undefined}
          title={done.error ? "Swap did not complete" : done.hash ? `Received ${fmtUnits(done.received ?? 0n, 6, 4)} EURC` : done.step ?? "Swapping…"}
          body={done.error}
          kv={[["Paid", `${fmtUnits(done.amountIn, 6, 4)} USDC`], ["Quoted", `${fmtUnits(done.quoted, 6, 4)} EURC`], ["Received", done.received !== undefined ? `${fmtUnits(done.received, 6, 4)} EURC` : "…"]]} />
      )}
    </>
  );
}
