/**
 * Pay later's credit line: lock Stock Tokens on NorenCredit (Robinhood), Chainlink CRE carries the limit to
 * NorenCreditLine on Arc, spend it at any Noren checkout, repay in USDC on Arc.
 */
import { useEffect, useMemo, useState } from "react";
import { api, short, usdc } from "../api";
import { msgOf } from "../ui";
import { STOCKS, usd8, units, type Line } from "../onchain";
import { creditActions, type Position, type Quote } from "../credit-actions";
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
      <div className="nk-card-h"><div><b>{line ? "Your credit line" : "Open a credit line"}</b><p>{line ? "Spend it with “Pay later” at any Noren checkout" : "Lock Stock Tokens on Robinhood Chain, spend USDC on Arc"}</p></div><span className={`nk-pill ${pos?.live ? "live" : ""}`}>{pos?.live ? "Live on Arc" : line ? "Bridging" : "Robinhood → Arc"}</span></div>
      {!lines ? <div className="nk-pad"><Skel rows={2} /></div> : line ? (
        <>
          <div className="nk-stats" style={{ margin: "0 0 6px" }}>
            <div className="nk-stat"><small>Limit</small><b>{usdc(line.limit)} USDC</b></div>
            <div className="nk-stat"><small>Available on Arc</small><b className="ok">{pos?.live ? usdc(pos.available) : "…"}</b></div>
            <div className="nk-stat"><small>Owed</small><b className={line.drawn - line.repaid > 0n ? "warn" : ""}>{usdc(line.drawn - line.repaid)}</b></div>
            <div className="nk-stat"><small>Expires</small><b>{day(line.expiry)}</b></div>
          </div>
          <div className="nk-box"><Bridge line={line} pos={pos} log={log} /></div>
          <Repay w={w} line={line} actions={actions} busy={busy} run={run} />
        </>
      ) : <Lock w={w} actions={actions} busy={busy} run={run} say={(t) => setNote({ t })} />}
      {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
    </section>
  );
}

function Lock({ w, actions, busy, run, say }: { w: Wallet; actions: ReturnType<typeof creditActions>; busy: string | null; run: (k: string, f: () => Promise<ReactNode | void>) => void; say: (t: string) => void }) {
  const [sym, setSym] = useState("NVDA");
  const [amt, setAmt] = useState("1");
  const [q, setQ] = useState<Quote | null>(null);
  const [qe, setQe] = useState<string | null>(null);
  const s = w.hold?.stocks.find((x) => x.sym === sym);
  useEffect(() => {
    if (!s || !(Number(amt) > 0)) { setQ(null); return; }
    let on = true; setQe(null);
    actions.quote(s, amt).then((x) => on && setQ(x)).catch((x) => on && (setQ(null), setQe(msgOf(x))));
    return () => { on = false; };
  }, [actions, sym, amt, s?.price8, s?.balance]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!w.hold) return <div className="nk-pad"><Skel rows={2} /></div>;
  const tooMuch = s ? Number(amt) > Number(s.balance) / 1e18 : true;
  const stockTokens = TOKENS.filter((t) => STOCKS.some((x) => x.sym === t.sym));
  const tok = stockTokens.find((t) => t.sym === sym)!;
  return (
    <>
      <div className="nk-box">
        <label htmlFor="nk-lock">You lock</label>
        <div className="nk-row"><input id="nk-lock" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} /><TokenButton t={tok} label="Stock to lock" only={(t: Token) => t.kind === "stock"} onPick={(t: Token) => setSym(t.sym)} /></div>
        <div className="nk-sub"><span>{s ? `$${usd8(s.price8)} per share · Chainlink` : " "}</span><span>Balance {s ? units(s.balance, 18) : "–"}</span></div>
      </div>
      <div className="nk-box">
        <span className="nk-l"><span>You can spend</span><span>{q ? `${q.termDays}-day line` : ""}</span></span>
        <div className="nk-row"><output className={q ? "" : "dim"}>{q ? usdc(q.limitUsdc6) : "0"}</output><span className="nk-token" data-static="true"><Coin t={{ sym: "USDC" }} />USDC</span></div>
        <div className="nk-sub"><span>on Arc, after one Chainlink CRE run</span><span>{q?.needsAttestation ? "estimate: the signed attestation sets the final terms" : ""}</span></div>
      </div>
      {qe ? <div className="nk-err">{qe}</div> : (
        <dl className="nk-rows">
          <dt>Collateral value</dt><dd>{q ? `$${usd8(q.collateral8)}` : "–"}</dd>
          <dt>Your tier lends</dt><dd>{q ? `${q.ltvBps / 100}% of value` : "–"}</dd>
          <dt>Liquidates if {sym} falls below</dt><dd className="warn">{q?.liquidation8 ? `$${usd8(q.liquidation8)}` : "–"}</dd>
        </dl>
      )}
      <button className="nk-cta" disabled={!!busy || !q || tooMuch} onClick={() => run("lock", async () => { const r = await actions.open(s!, amt, say); return <>{r.text} (tx <TxLink chain="robinhood" hash={r.hash} />). Chainlink CRE is bringing it to Arc.</>; })}>
        {busy === "lock" ? <><Spin /> Locking on Robinhood…</> : tooMuch ? `Not enough ${sym}` : `Lock ${amt || 0} ${sym} and open the line`}
      </button>
      {tooMuch && <p className="nk-fine">No stock yet? The wallet menu (top right) moves test NVDA to you on the fork.</p>}
    </>
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
      {line.drawn === 0n ? <p className="nk-fine">Nothing drawn yet. Choose <b>Pay later</b> at any Noren checkout; the merchant is paid upfront from the Arc credit pool. Paying on credit is not private: the line is tied to this wallet.</p> : (
        <div className="nk-btns">
          {short6 && <button className="nk-btn" disabled={!!busy} onClick={() => run("arcfaucet", async () => { await api.faucet(w.oc.address); return "Arc fork faucet: test USDC and gas sent."; })}>{busy === "arcfaucet" ? "Sending…" : "Get test USDC"}</button>}
          <button className="nk-btn ink" disabled={!!busy || due <= 0n || short6} onClick={() => run("repay", async () => { const h = await w.oc.repay(line.lineId, due); return <>Repaid {usdc(due)} USDC on Arc (tx <TxLink chain="arc" cfg={w.cfg} hash={h} />). Chainlink CRE reports it to NorenCredit.</>; })}>{busy === "repay" ? "Repaying…" : due > 0n ? `Repay ${usdc(due)} USDC` : "All paid"}</button>
        </div>
      )}
    </>
  );
}
