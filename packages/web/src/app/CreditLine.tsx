/**
 * Pay later's credit line: lock Stock Tokens on NorenCredit (Robinhood), Chainlink CRE carries the limit to
 * NorenCreditLine on Arc, spend it at any Noren checkout, repay in USDC on Arc.
 */
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { api, short, usdc } from "../api";
import { msgOf } from "../ui";
import { STOCKS, usd8, units, type Line } from "../onchain";
import { creditActions, type Collateral, type LineYield, type Position, type Quote } from "../credit-actions";
import { Mark } from "../logos";
import type { Wallet } from "./NorenApp";
import { Coin, Skel, Spin, SetupCard, TokenButton, Track } from "./kit";
import { TOKENS, type Token } from "./tokens";
import type { ReactNode } from "react";
import { TxLink } from "../tx";

const day = (t: number) => new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" });

export function useLines(w: Wallet) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [log, setLog] = useState<{ source: string; written?: string; event: string; ms: number }[] | null>(null);
  useEffect(() => {
    let on = true;
    w.oc.lines().then(async (l) => {
      if (!on) return; setLines(l); setErr(null);
      const last = l.filter((x) => !x.closed).at(-1);
      if (last) setPos(await w.oc.arcLine(last.lineId).catch(() => null));
      api.bridgeLog().then((x) => on && setLog(x)).catch(() => on && setLog(null));
    }).catch((e) => on && (setLines(null), setErr(msgOf(e))));
    return () => { on = false; };
  }, [w.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = lines?.filter((l) => !l.closed).at(-1);
  return { lines, err, pos, log, line };
}

export function CreditLineCard({ w }: { w: Wallet }) {
  const actions = useMemo(() => creditActions(w.cfg, w.oc), [w.cfg, w.oc]);
  const { lines, err, pos, log, line } = useLines(w);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: ReactNode; bad?: boolean } | null>(null);
  const run = async (k: string, f: () => Promise<ReactNode | void>) => { setBusy(k); setNote(null); try { const t = await f(); if (t) setNote({ t }); w.refresh(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); } };

  if (err) return <section className="nk-card"><div className="nk-card-h"><b>Credit line</b></div><div className="nk-pad"><SetupCard title="The credit line contracts aren't reachable" text={err} code="pnpm dev:all" /></div></section>;
  return (
    <section className="nk-card" aria-label="Credit line">
      <div className="nk-card-h"><div><b>{line ? "Your credit line" : "Open a credit line"}</b><p>{line ? "Spend it with “Pay later” at any Noren checkout" : "Lock Earn shares or Stock Tokens on Robinhood Chain, spend USDC on Arc"}</p></div><span className={`nk-pill ${pos?.live ? "live" : ""}`}>{pos?.live ? "Live on Arc" : line ? "Bridging" : "Robinhood → Arc"}</span></div>
      {!lines ? <div className="nk-pad"><Skel rows={2} /></div> : line ? (
        <>
          <div className="nk-stats" style={{ margin: "0 0 6px" }}>
            <div className="nk-stat"><small>Limit</small><b>{usdc(line.limit)} USDC</b></div>
            <div className="nk-stat"><small>Available on Arc</small><b className="ok">{pos?.live ? usdc(pos.available) : "…"}</b></div>
            <div className="nk-stat"><small>Owed on Arc</small><b className={line.drawn - line.repaid > 0n ? "warn" : ""}>{usdc(line.drawn - line.repaid)}</b></div>
            <div className="nk-stat"><small>Expires</small><b>{day(line.expiry)}</b></div>
          </div>
          <div className="nk-box"><Bridge line={line} pos={pos} log={log} /></div>
          <LineYieldCard w={w} line={line} actions={actions} busy={busy} run={run} />
          <Repay w={w} line={line} actions={actions} busy={busy} run={run} />
        </>
      ) : <Lock w={w} actions={actions} busy={busy} run={run} say={(t) => setNote({ t })} />}
      {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
    </section>
  );
}

const parseUnitsSafe = (v: string, d: number) => { try { return parseUnits(v || "0", d); } catch { return 0n; } };

function Lock({ w, actions, busy, run, say }: { w: Wallet; actions: ReturnType<typeof creditActions>; busy: string | null; run: (k: string, f: () => Promise<ReactNode | void>) => void; say: (t: string) => void }) {
  const [cols, setCols] = useState<Collateral[] | null>(null);
  const [colErr, setColErr] = useState<string | null>(null);
  const [sym, setSym] = useState<string | null>(null);
  const [amt, setAmt] = useState("1");
  const [q, setQ] = useState<Quote | null>(null);
  const [qe, setQe] = useState<string | null>(null);
  useEffect(() => { let on = true; actions.collaterals().then((c) => on && (setCols(c), setColErr(null))).catch((e) => on && setColErr(msgOf(e))); return () => { on = false; }; }, [actions, w.tick]);
  // Shares first: deposit NVDA in Earn, lock the nNVDA shares here, and they keep earning.
  useEffect(() => { if (!sym && cols?.length) setSym((cols.find((c) => c.balance > 0n) ?? cols[0]).sym); }, [cols, sym]);
  const s = cols?.find((x) => x.sym === sym);
  useEffect(() => { if (s?.kind === "shares" && s.balance > 0n) setAmt(formatUnits(s.balance, s.decimals)); }, [s?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!s || !(Number(amt) > 0)) { setQ(null); return; }
    let on = true; setQe(null);
    actions.quote(s, amt).then((x) => on && setQ(x)).catch((x) => on && (setQ(null), setQe(msgOf(x))));
    return () => { on = false; };
  }, [actions, sym, amt, s?.balance, w.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (colErr) return <div className="nk-pad"><div className="nk-err">{colErr}</div></div>;
  if (!cols) return <div className="nk-pad"><Skel rows={2} /></div>;
  const tooMuch = s ? (() => { try { return parseUnits(amt || "0", s.decimals) > s.balance; } catch { return true; } })() : true;
  return (
    <>
      <div className="nk-chains" role="radiogroup" aria-label="Collateral to lock">
        {cols.filter((c) => c.kind === "shares" || c.balance > 0n).map((c) => (
          <button key={c.token} type="button" role="radio" aria-checked={c.sym === sym} className="nk-chain" data-on={c.sym === sym} onClick={() => setSym(c.sym)} aria-label={`${c.sym}${c.kind === "shares" ? ", Earn shares that keep earning" : ""}`}>
            <Mark id={c.kind === "shares" ? (TOKENS.find((t) => t.address.toLowerCase() === c.underlying?.toLowerCase())?.sym ?? "ETH") : c.sym} size={20} /><span>{c.sym}</span>{c.kind === "shares" && <small className="nk-earning">earning</small>}
          </button>
        ))}
      </div>
      <div className="nk-box">
        <label htmlFor="nk-lock">You lock</label>
        <div className="nk-row"><input id="nk-lock" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} /><span className="nk-token" data-static="true">{s?.sym ?? "–"}</span></div>
        <div className="nk-sub"><span>{s?.kind === "shares" ? "Aqua pool shares: they keep earning while locked" : s?.price8 ? `$${usd8(s.price8)} per share · Chainlink` : " "}</span><span>Balance {s ? (s.balance > 0n ? <button type="button" onClick={() => setAmt(formatUnits(s.balance, s.decimals))}>{units(s.balance, s.decimals)}</button> : "0") : "–"}</span></div>
      </div>
      <div className="nk-box">
        <span className="nk-l"><span>Credit limit</span><span>{q ? `${q.ltvBps / 100}% of $${usd8(q.collateral8)}` : ""}</span></span>
        <div className="nk-row"><output className={q ? "" : "dim"}>{q ? usdc(q.limitUsdc6) : "0"}</output><span className="nk-token" data-static="true"><Coin t={{ sym: "USDC" }} />USDC</span></div>
        <div className="nk-sub"><span>on Arc, after one Chainlink CRE run</span><span>{q?.needsAttestation ? "estimate at your reputation tier; the signed terms set it" : "NorenCreditLens.maxCreditLimit"}</span></div>
      </div>
      {qe ? <div className="nk-err">{qe}</div> : (
        <dl className="nk-rows">
          <dt>Collateral value (risk)</dt><dd>{q ? `$${usd8(q.collateral8)}` : "–"}</dd>
          <dt>Your tier lends</dt><dd>{q ? `${q.ltvBps / 100}% of value${q.repLtvBps ? ` · reputation cap ${q.repLtvBps / 100}%` : ""}` : "–"}</dd>
          {s?.kind === "stock" && <><dt>Liquidates if {sym} falls below</dt><dd className="warn">{q?.liquidation8 ? `$${usd8(q.liquidation8)}` : "–"}</dd></>}
          {s?.kind === "shares" && <><dt>If it goes underwater</dt><dd className="warn">the shares are sold to 1inch Aqua makers</dd></>}
        </dl>
      )}
      <button className="nk-cta" disabled={!!busy || !q || tooMuch || !s} onClick={() => run("lock", async () => { const r = await actions.open(s!, amt, say); return <>{r.text} (tx <TxLink chain="robinhood" hash={r.hash} />). Chainlink CRE is bringing it to Arc.</>; })}>
        {busy === "lock" ? <><Spin /> Locking on Robinhood…</> : !s ? "Nothing to lock yet" : tooMuch ? `Not enough ${sym}` : `Lock ${units(parseUnitsSafe(amt, s.decimals), s.decimals)} ${sym} and open the line`}
      </button>
      {(!s || tooMuch) && <p className="nk-fine">Deposit NVDA, TSLA, AAPL or ETH in <a href="#/app/earn">Earn</a> to get shares that keep earning while they back the line. No stock yet? The wallet menu (top right) moves test NVDA to you on the fork.</p>}
    </>
  );
}

/** "Your NVDA earned Y in fees → paid down your line": NorenCreditLens.lineYield and NorenCredit.harvestLineToRepay. */
function LineYieldCard({ w, line, actions, busy, run }: { w: Wallet; line: Line; actions: ReturnType<typeof creditActions>; busy: string | null; run: (k: string, f: () => Promise<ReactNode | void>) => void }) {
  const [y, setY] = useState<LineYield | null | undefined>(undefined);
  useEffect(() => { let on = true; actions.lineYield(line.lineId).then((x) => on && setY(x)).catch(() => on && setY(null)); return () => { on = false; }; }, [actions, line.lineId, w.tick]);
  if (y === undefined) return <Skel rows={1} />;
  if (y === null) return null;
  const owed = y.outstandingUsdc6;
  return (
    <div className="nk-yield" aria-label="Fees earned by the locked shares">
      <div className="nk-stats" style={{ margin: "6px 0" }}>
        <div className="nk-stat"><small>{y.sym} earned, not yet used</small><b className="ok">{usdc(y.pendingUsdg)} USDG</b></div>
        <div className="nk-stat"><small>Fees already paid your line</small><b>{usdc(y.paidUsdc6)} USDC</b></div>
        <div className="nk-stat"><small>Owed on Robinhood</small><b className={owed > 0n ? "warn" : ""}>{usdc(owed)}</b></div>
      </div>
      <p className="nk-fine" style={{ margin: "0 4px 8px" }}>Your {y.sym} stays 1inch Aqua liquidity while it backs the line, and its trading fees are yours: they pay the line down, or you claim them when nothing is owed. A fee repayment lowers what NorenCredit counts as owed on Robinhood at once; Arc shows the gross debt until the Chainlink CRE bridge relays it.</p>
      <div className="nk-btns">
        <button className="nk-btn ink" disabled={!!busy || owed === 0n || y.pendingUsdg === 0n} onClick={() => run("harvest", async () => { const h = await actions.harvest(line.lineId); return <>Your {y.sym} fees paid down the line (tx <TxLink chain="robinhood" hash={h} />).</>; })}>{busy === "harvest" ? "Paying down…" : y.pendingUsdg === 0n ? "No fees yet" : owed === 0n ? "Nothing owed" : `Pay down with ${usdc(y.pendingUsdg)} USDG of fees`}</button>
        <button className="nk-btn" disabled={!!busy || owed > 0n || y.pendingUsdg === 0n} onClick={() => run("claim", async () => { const h = await actions.claim(line.lineId); return <>Fees claimed (tx <TxLink chain="robinhood" hash={h} />).</>; })}>{busy === "claim" ? "Claiming…" : "Claim fees"}</button>
      </div>
    </div>
  );
}

function Bridge({ line, pos, log }: { line: Line; pos: Position | null; log: { source: string; written?: string; event: string; ms: number }[] | null }) {
  const run = log?.find((e) => e.source.toLowerCase() === line.openedTx.toLowerCase());
  const live = !!pos?.live;
  return (
    <Track steps={[
      { k: "Locked", on: true, d: <TxLink chain="robinhood" hash={line.openedTx} n={4} /> },
      { k: "Chainlink CRE", on: live || !!run?.written, d: run?.written ? `${(run.ms / 1000).toFixed(1)} s` : "reporting…" },
      { k: "Live on Arc", on: live, d: live ? `${usdc(pos!.limit)} USDC` : "" },
    ]} />
  );
}

function Repay({ w, line, actions, busy, run }: { w: Wallet; line: Line; actions: ReturnType<typeof creditActions>; busy: string | null; run: (k: string, f: () => Promise<ReactNode | void>) => void }) {
  const [plan, setPlan] = useState<{ due: number; amount: bigint; paid: boolean }[] | null>(null);
  useEffect(() => { actions.schedule(line).then(setPlan).catch(() => setPlan([])); }, [actions, line.lineId, line.drawn, line.repaid]); // eslint-disable-line react-hooks/exhaustive-deps
  const owed = line.drawn - line.repaid;
  const next = plan?.find((p) => !p.paid);
  const due = owed <= 0n ? 0n : next ? (next.amount > owed ? owed : next.amount) : owed;
  const short6 = w.arcUsdc !== null && due > 0n && w.arcUsdc < due;
  return (
    <>
      {line.drawn > 0n && plan && plan.length > 0 && (
        <ul className="nk-items" style={{ marginTop: 6 }} aria-label="Repayment plan">
          {plan.map((p, i) => <li key={i} data-done={p.paid}><span className="nk-check">{p.paid ? "✓" : i + 1}</span><div><b>{usdc(p.amount)} USDC</b><small>{p.paid ? "Paid" : p === next ? `Next · suggested by ${day(p.due)}` : `Suggested by ${day(p.due)}`}</small></div></li>)}
        </ul>
      )}
      {line.drawn === 0n ? <p className="nk-fine">Nothing drawn yet. At any Noren checkout, <b>Pay later, privately</b> tops up your private balance from this line, so the merchant never learns who paid. <b>Pay in 3</b> pays the merchant straight from the line, publicly. Either way your lender knows it's you.</p> : (
        <>
        <div className="nk-btns">
          {short6 && <button className="nk-btn" disabled={!!busy} onClick={() => run("arcfaucet", async () => { await api.faucet(w.oc.address); return "Arc test faucet: test USDC and gas sent."; })}>{busy === "arcfaucet" ? "Sending…" : "Get test USDC"}</button>}
          <button className="nk-btn ink" disabled={!!busy || due <= 0n || short6} onClick={() => run("repay", async () => { const h = await w.oc.repay(line.lineId, due); return <>Repaid {usdc(due)} USDC on Arc (tx <TxLink chain="arc" cfg={w.cfg} hash={h} />). Chainlink CRE reports it to NorenCredit.</>; })}>{busy === "repay" ? "Repaying…" : due > 0n ? `Repay ${usdc(due)} USDC` : "All paid"}</button>
        </div>
        <p className="nk-fine"><b>Public.</b> A repayment comes from this wallet and names your line, so anyone reading Arc can see it. Only the merchant side of “Pay later, privately” is private.</p>
        </>
      )}
    </>
  );
}
