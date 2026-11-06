/**
 * The Noren app: the customer's side of Noren. Private balance, stocks, the credit line ("pay later") and repayments.
 * Stock Tokens on a Robinhood Chain fork back a credit line that a Chainlink CRE workflow mirrors onto Arc, where it
 * pays Noren invoices. Every number on this page is read from one of the two forks
 * (or the underwriter's signed attestation); anything not yet deployed shows "Setup required".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, short, usdc, SERVER } from "./api";
import { VerifyHuman } from "@noren/world-id/react";
import { Icon, Logo, Setup, msgOf, useConfig } from "./ui";
import { STOCKS, usd8, units, type Holding, type Line, type Onchain } from "./onchain";
import { creditActions, type AiCheck, type Quote, type Underwriting, type Position } from "./credit-actions";

const ago = (t: number) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const day = (t: number) => new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" });

export function NorenApp() {
  const { cfg, err } = useConfig();
  const [tk, setTk] = useState<Onchain | null>(null);
  const [hold, setHold] = useState<{ stocks: Holding[]; usdg: bigint; eth: bigint } | null>(null);
  const [holdErr, setHoldErr] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [linesErr, setLinesErr] = useState<string | null>(null);
  const [arcUsdc, setArcUsdc] = useState<bigint | null>(null);
  const [arcPos, setArcPos] = useState<Position | null>(null);
  const [bridgeLog, setBridgeLog] = useState<{ source: string; written?: string; event: string; ms: number }[] | null>(null);
  const [priv, setPriv] = useState<{ approved: bigint; pending: bigint } | null>(null);
  const [privErr, setPrivErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: string; bad?: boolean } | null>(null);

  useEffect(() => { if (cfg) import("./onchain").then((m) => setTk(m.makeOnchain(cfg))).catch((e) => setNote({ t: msgOf(e), bad: true })); }, [cfg]);
  const actions = useMemo(() => (tk && cfg ? creditActions(cfg, tk) : null), [tk, cfg]);

  const load = useCallback(async () => {
    if (!tk) return;
    tk.holdings().then((h) => { setHold(h); setHoldErr(null); }).catch((e) => setHoldErr(msgOf(e)));
    tk.lines().then(async (l) => {
      setLines(l); setLinesErr(null);
      const last = l.filter((x) => !x.closed).at(-1);
      if (last) setArcPos(await tk.arcLine(last.lineId).catch(() => null));
      api.bridgeLog().then(setBridgeLog).catch(() => setBridgeLog(null));
    }).catch((e) => { setLines(null); setLinesErr(msgOf(e)); });
    tk.arcUsdc().then(setArcUsdc).catch(() => setArcUsdc(null));
  }, [tk]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  // The private balance comes from the same in-browser Kohaku wallet the checkout uses (loaded lazily: it carries the prover).
  useEffect(() => {
    if (!cfg) return;
    let on = true, timer: ReturnType<typeof setInterval> | undefined;
    import("./wallet").then((m) => { const w = m.makeWallet(cfg); const read = () => w.balances().then((b) => on && (setPriv(b), setPrivErr(null))).catch((e) => on && setPrivErr(msgOf(e))); read(); timer = setInterval(read, 10000); }).catch((e) => setPrivErr(msgOf(e)));
    return () => { on = false; if (timer) clearInterval(timer); };
  }, [cfg]);

  const run = async (key: string, f: () => Promise<string | void>) => {
    setBusy(key); setNote(null);
    try { const t = await f(); if (t) setNote({ t }); await load(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); }
  };

  if (err) return <div className="na-page"><Setup err={err} /></div>;
  const credit = tk?.credit ?? null;
  const live = lines?.filter((l) => !l.closed) ?? [];
  const line = live[live.length - 1];
  const owed = line ? line.drawn - line.repaid : 0n;
  const collateral8 = hold?.stocks.reduce((a, s) => a + s.value8, 0n) ?? 0n;

  return (
    <div className="na-page">
      <header className="na-top">
        <a className="site-brand" href="#/"><Logo /><span>Noren</span></a>
        <span className="na-crumb"><span>/</span><b>App</b></span>
        <nav className="na-chains mono" aria-label="Networks">
          <span title={credit?.robinhoodRpc ?? "not running"}><i className={credit?.robinhoodRpc ? "on" : ""} />Robinhood fork</span>
          <span title={cfg?.rpcUrl}><i className={cfg ? "on" : ""} />Arc fork</span>
        </nav>
        <span className="na-who mono" title="Test key kept in this browser; same address on both chains">{tk ? short(tk.address, 6) : "…"}</span>
      </header>

      <main className="na-main">
        <section className="na-intro">
          <span className="eyebrow">Noren app</span>
          <h1>Pay privately. Pay with stocks. <em>Pay later.</em></h1>
          <p>Your private balance, your stock and your credit line in one place. Lock Stock Tokens on Robinhood Chain to get a USDC credit line on Arc, then pay any Noren checkout with it and repay when you like. A Chainlink CRE workflow keeps both chains in step.</p>
        </section>

        <section className="na-strip" aria-label="Your balances and credit line">
          <div><span>Private balance</span><b><i>$</i>{priv ? usdc(priv.approved) : "–"}</b><small>{privErr ? "Couldn't read the pool" : priv ? (priv.pending > 0n ? `+${usdc(priv.pending)} being screened` : "USDC in the privacy pool, Arc") : "Loading…"}</small></div>
          <div><span>Credit limit</span><b><i>$</i>{line ? usdc(line.limit) : "0.00"}</b><small>{line ? `Opened on Robinhood · expires ${day(line.expiry)}` : lines ? "No line yet" : linesErr ? "Setup required" : "Loading…"}</small></div>
          <div><span>Available on Arc</span><b><i>$</i>{arcPos?.live ? usdc(arcPos.available) : "0.00"}</b><small>{line && !arcPos?.live ? "Waiting for Chainlink CRE…" : "Spend it at any Noren checkout"}</small></div>
          <div><span>Owed</span><b className={owed > 0n ? "kaki" : ""}><i>$</i>{usdc(owed)}</b><small>{line ? `${usdc(line.drawn)} drawn · ${usdc(line.repaid)} repaid` : "Nothing drawn"}</small></div>
          <div><span>Stock you hold</span><b><i>$</i>{hold ? usd8(collateral8) : "–"}</b><small>At live Chainlink prices on the fork</small></div>
        </section>

        {note && <p className={note.bad ? "err na-note" : "note na-note"} role="status">{note.t}</p>}

        <div className="na-grid">
          <div className="na-col">
            <Panel n="1" title="Your stock on Robinhood Chain" sub="Real Stock Token contracts and Chainlink feeds, on a local fork of mainnet">
              {holdErr ? <SetupLine text={holdErr} /> : !hold ? <Skel rows={3} /> : (
                <>
                  <ul className="na-hold">
                    {hold.stocks.filter((s) => s.balance > 0n || s.sym === "NVDA" || s.sym === "TSLA").map((s) => (
                      <li key={s.sym}>
                        <span className="na-tick" aria-hidden>{s.sym.slice(0, 1)}</span>
                        <div><b>{s.sym}</b><small>{s.name}</small></div>
                        <div className="r"><b className="num">{units(s.balance, 18)}</b><small>shares</small></div>
                        <div className="r"><b className="num">${usd8(s.price8)}</b><small title="Chainlink round updatedAt">{ago(s.updatedAt)}</small></div>
                        <div className="r hide-s"><b className="num">${usd8(s.value8)}</b><small>value</small></div>
                      </li>
                    ))}
                  </ul>
                  <div className="na-hold-f">
                    <span>USDG <b className="num">{units(hold.usdg, 6, 2)}</b></span>
                    <span>ETH <b className="num">{units(hold.eth, 18, 4)}</b></span>
                    <button className="btn line sm" disabled={!!busy} onClick={() => run("faucet", async () => { const r = await api.robinhoodFaucet(tk!.address); return `Fork faucet: 3 NVDA and 120 USDG moved from real mainnet holders (tx ${short(r.NVDA, 6)}).`; })}>
                      {busy === "faucet" ? <><span className="spin" /> Moving tokens…</> : "Get test stock"}
                    </button>
                  </div>
                  <p className="na-fine">Fork faucet: impersonates real holders on your local Anvil fork. Nothing touches mainnet.</p>
                </>
              )}
            </Panel>

            <Panel n="2" title="Lock stock, open a credit line" sub="NorenCredit on Robinhood Chain">
              {actions ? <LockForm actions={actions} hold={hold} busy={busy} run={run} hasLine={!!line} say={(t) => setNote({ t })} /> : <Skel rows={2} />}
            </Panel>

            <Panel n="4" title="Repay" sub="USDC on Arc; the CRE workflow carries each repayment back to Robinhood">
              {!line ? <p className="na-empty">Your repayment plan appears after your first pay-later payment.</p> : <Installments line={line} tk={tk!} actions={actions} arcUsdc={arcUsdc} busy={busy} run={run} />}
            </Panel>
          </div>

          <div className="na-col">
            <Panel title="Your credit score" sub="From this wallet's Robinhood Chain history, signed with EIP-712">
              {actions ? <><Score key={`${collateral8}-${line?.lineId ?? ''}`} actions={actions} /><AiDecision actions={actions} /></> : <Skel rows={3} />}
            </Panel>
            <Panel title="No stock? Start with a small line" sub="World ID: one unsecured starter line per unique human. Noren keeps only the nullifier, never who you are.">
              <VerifyHuman serverUrl={SERVER} wallet={tk?.address} />
            </Panel>
            <Panel n="3" title="Bridged to Arc by Chainlink CRE" sub="CreditLineOpened on Robinhood → workflow → NorenCreditLine on Arc">
              {linesErr ? <SetupLine text={linesErr} /> : !lines ? <Skel rows={2} /> : <Bridge line={line} pos={arcPos} log={bridgeLog} />}
            </Panel>
            <Panel title="Pay later at any Noren checkout">
              <p className="na-p">Open any Noren payment link and choose <b>Pay later</b>. The merchant is paid in full, upfront, from the Arc credit pool. Paying on credit is <b>not private</b>: the line is tied to your Robinhood wallet. For a private payment, use your shielded balance instead.</p>
              {line && line.draws.length > 0 && (
                <ul className="na-draws">{line.draws.map((d) => <li key={d.tx}><span className="mono">{short(d.invoiceId, 6)}</span><span>to <span className="mono">{short(d.merchant, 4)}</span></span><b className="num">{usdc(d.amount)} USDC</b></li>)}</ul>
              )}
            </Panel>
          </div>
        </div>
        <p className="na-foot">Test networks only. Robinhood Chain and Arc run as local Anvil forks; prices come from the real Chainlink feeds at the fork block. The CRE workflow runs in the CRE CLI simulator.</p>
      </main>
    </div>
  );
}

function Panel({ n, title, sub, children }: { n?: string; title: string; sub?: string; children: React.ReactNode }) {
  return <section className="na-panel"><header>{n && <span className="na-n">{n}</span>}<div><h2>{title}</h2>{sub && <p>{sub}</p>}</div></header>{children}</section>;
}
const Skel = ({ rows }: { rows: number }) => <div className="na-skel">{Array.from({ length: rows }, (_, i) => <i key={i} />)}</div>;
const SetupLine = ({ text }: { text: string }) => <div className="na-setup"><span className="eyebrow">Setup required</span><p>{text.replace(/^Setup required:\s*/, "")}</p></div>;

/* ------------------------------------------------------------------ score gauge */
function Score({ actions }: { actions: ReturnType<typeof creditActions> }) {
  const [u, setU] = useState<Underwriting | null>(null);
  const [e, setE] = useState<string | null>(null);
  useEffect(() => { let on = true; actions.underwrite().then((x) => on && setU(x)).catch((x) => on && setE(msgOf(x))); return () => { on = false; }; }, [actions]);
  if (e) return <SetupLine text={e} />;
  if (!u) return <Skel rows={3} />;
  const segs = u.tiers.length, R = 70, cx = 90, cy = 86, gap = 4;
  const arc = (i: number) => { const a0 = Math.PI + (i * Math.PI) / segs + (gap / R) / 2, a1 = Math.PI + ((i + 1) * Math.PI) / segs - (gap / R) / 2; const p = (a: number) => `${cx + R * Math.cos(a)},${cy + R * Math.sin(a)}`; return `M${p(a0)} A${R},${R} 0 0 1 ${p(a1)}`; };
  return (
    <div className="na-score">
      <div className="na-gauge">
        <svg viewBox="0 0 180 100" role="img" aria-label={`${u.tier} of ${segs} tiers`}>{u.tiers.map((t, i) => <path key={t.name} d={arc(i)} className={i <= u.tierIndex ? `on t${i}` : ""} />)}</svg>
        <div><b>{u.tier}</b><small>{u.tierIndex < 0 ? `score ${u.score} of 100 · 30 needed` : `score ${u.score} of 100 · ${u.ltvBps / 100}% collateral`}</small></div>
      </div>
      <ul className="na-factors">{u.factors.map((f) => <li key={f.label} data-missing={f.missing}><span>{f.label}</span><b className="num">{f.value}</b>{f.max ? <i className="na-bar" aria-hidden><i style={{ width: `${Math.min(100, ((f.points ?? 0) / f.max) * 100)}%` }} /></i> : null}{f.note && <small>{f.note}</small>}</li>)}</ul>
      <p className="na-fine">{u.onchainTier ? `NorenCredit holds tier ${u.onchainTier} for this wallet. ` : ""}Read from this wallet's Robinhood Chain history. The underwriter signs an EIP-712 attestation and NorenCredit checks the signature on-chain; a better history means less collateral and a higher limit.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ 0G Private Computer credit check */
function AiDecision({ actions }: { actions: ReturnType<typeof creditActions> }) {
  const [r, setR] = useState<AiCheck | null>(null);
  const [e, setE] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setE(null); try { setR(await actions.aiCheck()); } catch (x) { setE(msgOf(x)); } finally { setBusy(false); } };
  return (
    <div className="na-ai">
      <header><b>Second opinion: sealed AI credit check</b><span className="mono">0G Private Computer</span></header>
      {e ? <SetupLine text={e} /> : !r ? (
        <><p className="na-fine">Sends this wallet's history features (no address in the prompt) to a model running inside a TEE on 0G Private Computer, and shows its decision with the 0G request ID.</p>
          <button className="btn line sm" disabled={busy} onClick={run}>{busy ? <><span className="spin" /> Asking 0G…</> : "Run the AI credit check"}</button></>
      ) : r.status === "refused" ? (
        r.setupRequired ? <SetupLine text={r.reason ?? "ZG_PC_API_KEY"} /> : <div className="na-setup"><span className="eyebrow">Refused, no terms</span><p>{r.reason}</p></div>
      ) : (
        <dl className="na-rows">
          <dt>Decision</dt><dd><b>{r.status === "approved" ? `Approved · tier ${r.tier}` : "Declined"}</b></dd>
          {r.status === "approved" && <><dt>Limit · collateral</dt><dd>{r.limitUsdg} USDG · {(r.collateralRatioBps ?? 0) / 100}%</dd></>}
          <dt>Why</dt><dd className="wrap">{r.rationale}</dd>
          <dt>0G request ID</dt><dd className="mono">{short(r.requestId, 8)}</dd>
          <dt>TEE verified</dt><dd>{r.teeVerified === true ? "yes" : r.teeVerified === false ? "no" : "not checked"}</dd>
          {r.model && <><dt>Model</dt><dd className="mono">{r.model}</dd></>}
        </dl>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ lock form (order-panel layout) */
function LockForm({ actions, hold, busy, run, hasLine, say }: { actions: ReturnType<typeof creditActions>; hold: { stocks: Holding[] } | null; busy: string | null; run: (k: string, f: () => Promise<string | void>) => void; hasLine: boolean; say: (t: string) => void }) {
  const owned = hold?.stocks.filter((s) => s.balance > 0n) ?? [];
  const [sym, setSym] = useState("NVDA");
  const [amt, setAmt] = useState("1");
  const [q, setQ] = useState<Quote | null>(null);
  const [qe, setQe] = useState<string | null>(null);
  const s = hold?.stocks.find((x) => x.sym === sym);
  useEffect(() => {
    if (!s || !(Number(amt) > 0)) { setQ(null); return; }
    let on = true; setQe(null);
    actions.quote(s, amt).then((x) => on && setQ(x)).catch((x) => on && (setQ(null), setQe(msgOf(x))));
    return () => { on = false; };
  }, [actions, sym, amt, s?.price8, s?.balance]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hold) return <Skel rows={2} />;
  const tooMuch = s ? Number(amt) > Number(s.balance) / 1e18 : true;
  return (
    <div className="na-order">
      <div className="na-legs">
        <label className="na-leg"><span>You lock</span>
          <div><input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Shares to lock" />
            <select value={sym} onChange={(e) => setSym(e.target.value)} aria-label="Stock Token">{(owned.length ? owned : STOCKS.slice(0, 1)).map((x) => <option key={x.sym}>{x.sym}</option>)}</select></div>
          <small>{s ? `${units(s.balance, 18)} available` : ""}</small>
        </label>
        <span className="na-knob" aria-hidden><Icon.arrow /></span>
        <div className="na-leg out"><span>You can spend</span><div><b className="num">{q ? usdc(q.limitUsdc6) : "–"}</b><em>USDC on Arc</em></div><small>{q ? `${q.termDays}-day line${q.needsAttestation ? ` · tier ${q.tier} attestation first` : ""}` : qe ? "" : " "}</small></div>
      </div>
      {qe ? <SetupLine text={qe} /> : (
        <dl className="na-rows">
          <dt>Chainlink price</dt><dd>{s ? `$${usd8(s.price8)} · ${ago(s.updatedAt)}` : "–"}</dd>
          <dt>Collateral value</dt><dd>{q ? `$${usd8(q.collateral8)}` : "–"}</dd>
          <dt>Your tier allows</dt><dd>{q ? `${q.ltvBps / 100}% of value` : "–"}</dd>
          <dt>Liquidation if price falls below</dt><dd>{q?.liquidation8 ? `$${usd8(q.liquidation8)}` : "–"}</dd>
        </dl>
      )}
      <button className="btn kaki full lg" disabled={!!busy || !q || tooMuch || hasLine} onClick={() => run("lock", () => actions.open(s!, amt, say))}>
        {busy === "lock" ? <><span className="spin" /> Locking on Robinhood…</> : hasLine ? "You have an open credit line" : tooMuch ? `Not enough ${sym}` : <>Lock {amt || 0} {sym} and open a credit line</>}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ bridge status */
function Bridge({ line, pos, log }: { line?: Line; pos: Position | null; log: { source: string; written?: string; event: string; ms: number }[] | null }) {
  const run = line ? log?.find((e) => e.source.toLowerCase() === line.openedTx.toLowerCase()) : undefined;
  const live = !!line && !!pos?.live;
  const steps: [string, string, boolean][] = [
    ["CreditLineOpened on Robinhood", line ? `tx ${short(line.openedTx, 6)} · block ${line.openedBlock}` : "Lock stock to open a line", !!line],
    ["Chainlink CRE workflow", line ? (run?.written ? `report written through the forwarder in ${(run.ms / 1000).toFixed(1)} s · tx ${short(run.written, 6)}` : live ? "report written" : "waiting for the workflow to report…") : "Listens for CreditLineOpened", live],
    ["Live on Arc: NorenCreditLine", live ? `limit ${usdc(pos!.limit)} USDC · line ${short(line!.lineId, 4)}` : "Not yet", live],
  ];
  return <ol className="na-bridge">{steps.map(([t, d, on], i) => <li key={t} data-on={on} data-now={!on && (i === 0 || steps[i - 1][2])}><i>{on ? <Icon.check /> : i + 1}</i><div><b>{t}</b><span>{d}</span></div></li>)}</ol>;
}

/* ------------------------------------------------------------------ installments */
function Installments({ line, tk, actions, arcUsdc, busy, run }: { line: Line; tk: Onchain; actions: ReturnType<typeof creditActions> | null; arcUsdc: bigint | null; busy: string | null; run: (k: string, f: () => Promise<string | void>) => void }) {
  const [plan, setPlan] = useState<{ due: number; amount: bigint; paid: boolean }[] | null>(null);
  const [pe, setPe] = useState<string | null>(null);
  useEffect(() => { if (!actions) return; actions.schedule(line).then(setPlan).catch((e) => setPe(msgOf(e))); }, [actions, line.lineId, line.drawn, line.repaid]); // eslint-disable-line react-hooks/exhaustive-deps
  const owed = line.drawn - line.repaid;
  const next = plan?.find((p) => !p.paid);
  // The next suggested part when NorenCredit publishes an installment count; otherwise the whole balance.
  const due = owed <= 0n ? 0n : next ? (next.amount > owed ? owed : next.amount) : owed;
  return (
    <div className="na-inst">
      {pe ? <SetupLine text={pe} /> : !plan ? <Skel rows={2} /> : line.drawn === 0n ? <p className="na-empty">Nothing drawn yet.</p> : plan.length === 0 ? (
        <p className="na-empty">Owe {usdc(owed)} USDC. Repay any amount, any time, before the line expires on {day(line.expiry)}.</p>
      ) : (
        <ol>{plan.map((p, i) => <li key={i} data-paid={p.paid}><span className="na-n sm">{i + 1}</span><span>{day(p.due)}</span><b className="num">{usdc(p.amount)} USDC</b><em>{p.paid ? "Paid" : p === next ? "Next" : "Suggested"}</em></li>)}</ol>
      )}
      <div className="na-repay">
        <span>Arc USDC <b className="num">{arcUsdc === null ? "–" : usdc(arcUsdc)}</b></span>
        {arcUsdc !== null && due > 0n && arcUsdc < due && <button className="btn line sm" disabled={!!busy} onClick={() => run("arcfaucet", async () => { await api.faucet(tk.address); return "Arc fork faucet: test USDC and gas sent."; })}>{busy === "arcfaucet" ? <><span className="spin" /> Sending…</> : "Get test USDC"}</button>}
        <button className="btn ink sm" disabled={!!busy || due <= 0n || (arcUsdc ?? 0n) < due} onClick={() => run("repay", async () => { const h = await tk.repay(line.lineId, due); return `Repaid ${usdc(due)} USDC on Arc (tx ${short(h, 6)}). The CRE workflow reports it to NorenCredit.`; })}>
          {busy === "repay" ? <><span className="spin" /> Repaying…</> : due > 0n ? `Repay · ${usdc(due)} USDC` : "All paid"}
        </button>
      </div>
    </div>
  );
}
