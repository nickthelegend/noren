/**
 * Credit: your reputation (the history underwriter's score from real Robinhood Chain history, signed with EIP-712),
 * your credit limit (NorenCredit's terms on-chain), milestones, and a World ID boost (one starter line per human).
 */
import { useEffect, useMemo, useState } from "react";
import { VerifyHuman } from "@noren/world-id/react";
import { SERVER, short, usdc } from "../api";
import { msgOf } from "../ui";
import { creditActions, type AiCheck, type Underwriting } from "../credit-actions";
import type { Wallet } from "./NorenApp";
import { rhSdk, type Positions } from "./rh";
import { Card, SetupCard, Skel, Spin } from "./kit";
import { useReputation } from "./reputation";
import { CreditLineCard } from "./CreditLine";

export function CreditTab({ w }: { w: Wallet }) {
  const actions = useMemo(() => creditActions(w.cfg, w.oc), [w.cfg, w.oc]);
  const [u, setU] = useState<Underwriting | null>(null);
  const [uErr, setUErr] = useState<string | null>(null);
  const [pos, setPos] = useState<Positions | null>(null);
  const [posErr, setPosErr] = useState<string | null>(null);
  const [verified, setVerified] = useState(0);
  const rep = useReputation(w, verified);

  useEffect(() => { let on = true; actions.underwrite().then((x) => on && (setU(x), setUErr(null))).catch((e) => on && setUErr(msgOf(e))); return () => { on = false; }; }, [actions, w.hold?.stocks.reduce((a, s) => a + s.value8, 0n)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { let on = true; try { rhSdk(w).readPositions(w.oc.address).then((p) => on && (setPos(p), setPosErr(null))).catch((e) => on && setPosErr(msgOf(e))); } catch (e) { setPosErr(msgOf(e)); } return () => { on = false; }; }, [w.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const terms = pos?.terms;
  const h = pos?.history;
  return (
    <div className="nk-col">
      <div className="nk-hero" aria-label="Your credit limit">
        <small>Credit limit · NorenCredit on Robinhood Chain</small>
        <b>{terms ? <><i>$</i>{usdc(terms.limitUsdg)}</> : posErr ? "–" : "…"}</b>
        <p>{posErr ? posErr : !terms ? "Reading your terms…" : terms.tier === 0 ? "No tier yet. Your first credit line applies the underwriter's signed attestation." : `Tier ${terms.tier} · ${(terms.ratioBps / 100).toFixed(0)}% collateral · ${usdc(terms.availableUsdg)} USDG available`}</p>
      </div>

      <CreditLineCard w={w} />

      <Card title="Reputation" sub="Scored from this wallet's real Robinhood Chain history, signed with EIP-712 and checked on-chain by NorenCredit" pill={u ? <span className="nk-pill">{u.tier}</span> : undefined}>
        <div className="nk-pad">
          {uErr ? <SetupCard title="The history underwriter isn't reachable" text={uErr} code="pnpm dev:all" /> : !u ? <Skel rows={3} /> : <Score u={u} />}
          {h && (
            <div className="nk-stats" aria-label="Repayment history on NorenCredit">
              <div className="nk-stat"><small>On-time payments</small><b className={h.onTime ? "ok" : ""}>{h.onTime}</b></div>
              <div className="nk-stat"><small>Late payments</small><b className={h.late ? "warn" : ""}>{h.late}</b></div>
              <div className="nk-stat"><small>Plans completed</small><b>{h.completed}</b></div>
              <div className="nk-stat"><small>Defaults</small><b className={h.defaults ? "bad" : ""}>{h.defaults}</b></div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Milestones" sub={rep.source}>
        <div className="nk-pad">
          {rep.error ? <SetupCard title="Reputation milestones aren't live on this stack" text={rep.error} /> : !rep.items ? <Skel rows={3} /> : (
            <ul className="nk-items">{rep.items.map((m) => <li key={m.id} data-done={m.done}><span className="nk-check">{m.done ? "✓" : ""}</span><div><b>{m.title}</b><small>{m.detail}</small></div>{m.boost && <span className="r nk-mono">{m.boost}</span>}</li>)}</ul>
          )}
        </div>
      </Card>

      <Card title="Verify you're human with World ID" sub="A boost for wallets without stock: one unsecured starter line per unique human, opened on Arc by Chainlink CRE">
        <div className="nk-pad nk-world">
          <p className="nk-fine" style={{ margin: "0 4px 10px" }}>Production World ID: tap <b>Verify with World ID</b>, then scan the QR code with <b>World App</b> and finish the Selfie Check on your phone. The request stays open for 5 minutes; if it expires, start again.</p>
          <VerifyHuman serverUrl={SERVER} wallet={w.oc.address} onResult={() => { setVerified((n) => n + 1); w.refresh(); }} />
        </div>
      </Card>

      <Card title="Second opinion" sub="A sealed AI credit check on 0G Private Computer (no address in the prompt)">
        <div className="nk-pad"><AiDecision actions={actions} /></div>
      </Card>
    </div>
  );
}

function Score({ u }: { u: Underwriting }) {
  const segs = u.tiers.length, R = 70, cx = 90, cy = 86, gap = 4;
  const arc = (i: number) => { const a0 = Math.PI + (i * Math.PI) / segs + gap / R / 2, a1 = Math.PI + ((i + 1) * Math.PI) / segs - gap / R / 2; const p = (a: number) => `${cx + R * Math.cos(a)},${cy + R * Math.sin(a)}`; return `M${p(a0)} A${R},${R} 0 0 1 ${p(a1)}`; };
  return (
    <>
      <div className="nk-gauge">
        <svg viewBox="0 0 180 100" role="img" aria-label={`Score ${u.score} of 100, ${u.tier}`}>{u.tiers.map((t, i) => <path key={t.name} d={arc(i)} className={i <= u.tierIndex ? "on" : ""} />)}</svg>
        <div><b>{u.score}</b><small>of 100 · {u.tierIndex < 0 ? "30 needed for tier 1" : `${u.ltvBps / 100}% collateral`}</small></div>
      </div>
      <ul className="nk-items">
        {u.factors.map((f) => (
          <li key={f.label} data-done={false}>
            <div><b>{f.label}</b><small>{f.note}</small>{f.max ? <div className="nk-meter" aria-hidden><i style={{ width: `${Math.min(100, ((f.points ?? 0) / f.max) * 100)}%` }} /></div> : null}</div>
            <span className="r nk-mono">{f.value}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function AiDecision({ actions }: { actions: ReturnType<typeof creditActions> }) {
  const [r, setR] = useState<(AiCheck & { at?: number; cached?: boolean }) | null>(null);
  const [e, setE] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A stored decision is shown first: each live check is a paid 0G call, so nothing calls 0G on page load.
  useEffect(() => { actions.lastAiDecision().then((d) => d && setR({ ...d, cached: true })).catch(() => {}); }, [actions]);
  const run = async () => {
    if (!confirm("Run a live credit check on 0G Private Computer? Each check is a paid 0G call.")) return;
    setBusy(true); setE(null);
    try { setR(await actions.aiCheck()); } catch (x) { setE(msgOf(x)); } finally { setBusy(false); }
  };
  const providerDown = (t?: string) => !!t && /502|EOF|fetch provider|unavailable|provider quote|timed? ?out/i.test(t);
  if (e) return providerDown(e) ? <div className="nk-err">0G provider unavailable, decision not made. {e}</div> : <SetupCard title="0G credit check unavailable" text={e} />;
  if (!r) return <><button className="nk-cta soft" disabled={busy} onClick={run}>{busy ? <><Spin /> Asking 0G…</> : "Run the AI credit check"}</button><p className="nk-fine">One paid call to a model inside a TEE on 0G. The result is stored by the Noren server and shown here next time.</p></>;
  if (r.status === "refused") return r.setupRequired ? <SetupCard title="0G Private Computer key missing" text={r.reason ?? "ZG_PC_API_KEY"} /> : providerDown(r.reason) ? <div className="nk-err">0G provider unavailable, decision not made. {r.reason}</div> : <div className="nk-err">Refused, no decision: {r.reason}</div>;
  return (
    <>
      <dl className="nk-rows">
        <dt>Decision</dt><dd className={r.status === "approved" ? "ok" : "bad"}>{r.status === "approved" ? `Approved · tier ${r.tier}` : "Declined"}</dd>
        {r.status === "approved" && <><dt>Limit · collateral</dt><dd>{r.limitUsdg} USDG · {(r.collateralRatioBps ?? 0) / 100}%</dd></>}
        <dt>Why</dt><dd>{r.rationale}</dd>
        <dt>0G request</dt><dd className="nk-mono">{short(r.requestId, 8)}</dd>
        <dt>TEE verified</dt><dd>{r.teeVerified === true ? "yes" : r.teeVerified === false ? "no" : "not checked"}</dd>
        {r.model && <><dt>Model</dt><dd className="nk-mono">{r.model}</dd></>}
      </dl>
      {r.cached && <p className="nk-fine">Stored decision{r.at ? ` from ${new Date(Number(r.at) * (Number(r.at) < 1e12 ? 1000 : 1)).toLocaleString()}` : ""}; not a new 0G call.</p>}
    </>
  );
}
