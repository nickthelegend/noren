/**
 * "Raise your limit": the tasks that each raise this wallet's credit limit, with real state and the limit before and
 * after each one. Nothing here is a made-up number:
 * - NorenReputation (Robinhood Chain): points, milestones, tierTable (LTV 66/70/75/80%), the World ID nullifier and the
 *   starter line; NorenBorrow.securedCapacityUsdg(me, ltv) prices this wallet's deposits at any tier's LTV, so "after"
 *   is the contract's own math at the tier the task unlocks (the same rule as NorenReputation.breakdownOf).
 * - The history underwriter's /score: the Pay-in-3 line it would sign now and with a verified Reclaim proof.
 * - The Noren server's /reclaim routes: whether Reclaim is configured, the QR request and the verified claim.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import qrcode from "qrcode-generator";
import { parseAbi, type Address, type Hex } from "viem";
import { VerifyHuman } from "@noren/world-id/react";
import { SERVER } from "../api";
import { msgOf } from "../ui";
import { Mark } from "../logos";
import type { Underwriting } from "../credit-actions";
import type { Wallet } from "./NorenApp";
import { reputationAbi } from "./earn";
import { fmtUnits } from "./tokens";
import { SetupCard, Skel, Spin, pop } from "./kit";

const extraAbi = parseAbi([
  "function nullifierOf(address account) view returns (bytes32)",
  "function securedCapacityUsdg(address who, uint16 ltvBps) view returns (uint256)",
]);
const POINTS_HUMAN = 50n, POINTS_ON_TIME = 10n, POINTS_LOAN = 25n;
const M_HUMAN = 1n, M_ON_TIME_3 = 1n << 3n, M_LOAN_1 = 1n << 4n;

type TierRow = { ltvBps: number; minPoints: number; needsHuman: boolean; needsRepayment: boolean };
type Rep = { points: bigint; tier: number; ltvBps: number; human: boolean; nullifier: Hex; onTime: number; repaidLoans: number; milestones: bigint; tiers: TierRow[]; caps: bigint[]; starter: bigint; total: bigint; secured: bigint };

/** NorenReputation.breakdownOf's tier rule, applied to hypothetical points/milestones. */
function tierFor(r: Rep, points: bigint, human: boolean, milestones: bigint) {
  for (let t = 3; t > 0; t--) {
    const x = r.tiers[t];
    if (points < BigInt(x.minPoints)) continue;
    if (x.needsHuman && !human) continue;
    if (x.needsRepayment && (milestones & (M_LOAN_1 | M_ON_TIME_3)) === 0n) continue;
    return t;
  }
  return 0;
}
const limitAt = (r: Rep, tier: number, human: boolean) => r.caps[tier] + (human ? r.starter : 0n);

async function readRep(w: Wallet, rep: Address, borrow: Address): Promise<Rep> {
  const { pub } = w.oc.robinhood();
  const me = w.oc.address;
  const [b, limit, starter, nullifier, ...tiers] = await Promise.all([
    pub.readContract({ address: rep, abi: reputationAbi, functionName: "breakdownOf", args: [me] }),
    pub.readContract({ address: rep, abi: reputationAbi, functionName: "creditLimitOf", args: [me] }),
    pub.readContract({ address: rep, abi: reputationAbi, functionName: "starterUsdc6" }),
    pub.readContract({ address: rep, abi: extraAbi, functionName: "nullifierOf", args: [me] }),
    ...[0, 1, 2, 3].map((t) => pub.readContract({ address: rep, abi: reputationAbi, functionName: "tierTable", args: [t] })),
  ]) as [any, readonly [bigint, bigint, bigint], bigint, Hex, ...any[]];
  const rows: TierRow[] = tiers.map((t) => ({ ltvBps: Number(t.ltvBps), minPoints: Number(t.minPoints), needsHuman: t.needsHuman, needsRepayment: t.needsRepayment }));
  const caps = await Promise.all(rows.map((t) => pub.readContract({ address: borrow, abi: extraAbi, functionName: "securedCapacityUsdg", args: [me, t.ltvBps] })));
  return { points: b.points, tier: Number(b.tier), ltvBps: Number(b.ltvBps), human: b.verifiedHuman, nullifier, onTime: Number(b.onTime), repaidLoans: Number(b.repaidLoans), milestones: b.milestones, tiers: rows, caps, starter, total: limit[0], secured: limit[1] };
}

const usd = (v: bigint) => `$${fmtUnits(v, 6, 2)}`;
const ltv = (bps: number) => `${(bps / 100).toFixed(0)}%`;

export function RaiseLimit({ w, u, nonce, onVerified }: { w: Wallet; u: Underwriting | null; nonce: number; onVerified: () => void }) {
  const repAddr = w.oc.credit?.reputation as Address | undefined, borrow = w.oc.credit?.borrow as Address | undefined;
  const [r, setR] = useState<Rep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!repAddr || !borrow) return;
    let on = true;
    readRep(w, repAddr, borrow).then((x) => on && (setR(x), setErr(null))).catch((e) => on && setErr(msgOf(e)));
    return () => { on = false; };
  }, [w.tick, nonce, repAddr, borrow]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!repAddr || !borrow) return <section className="nk-card" aria-label="Raise your limit"><div className="nk-card-h"><div><b>Raise your limit</b><p>Tasks that each raise your credit limit</p></div></div><div className="nk-pad"><SetupCard title="NorenReputation isn't deployed on this stack" text="The tasks read NorenReputation and NorenBorrow on the Robinhood fork. Start everything with pnpm dev:all." code="pnpm dev:all" /></div></section>;

  const human = r ? (() => { const pts = r.points + (r.human ? 0n : POINTS_HUMAN); const t = tierFor(r, pts, true, r.milestones | M_HUMAN); return { done: r.human, after: limitAt(r, t, true), tier: t }; })() : null;
  // Repay on time: three on-time Pay-in-3 installments (+10 each) and one NorenBorrow loan repaid in full (+25).
  const ontime = r ? (() => {
    const add = (r.onTime >= 3 ? 0n : BigInt(3 - r.onTime) * POINTS_ON_TIME) + (r.repaidLoans >= 1 ? 0n : POINTS_LOAN);
    const t = tierFor(r, r.points + add, r.human, r.milestones | M_ON_TIME_3 | M_LOAN_1);
    return { done: r.onTime >= 3 && r.repaidLoans >= 1, add, after: limitAt(r, t, r.human), tier: t };
  })() : null;
  const lockAdd = r ? (100_000_000n * BigInt(r.ltvBps)) / 10_000n : 0n; // $100 of collateral at this tier's LTV (USD6)
  const done = r ? [human?.done, ontime?.done, u?.reclaim?.verified, r.secured > 0n].filter(Boolean).length : 0;

  return (
    <section className="nk-card nk-raise" id="nk-raise" aria-label="Raise your limit">
      <div className="nk-card-h">
        <div><b>Raise your limit</b><p>Each task raises your credit limit. Limits are read live from NorenReputation and NorenBorrow; “after” is the contract's own math at the tier the task unlocks.</p></div>
        {r && <span className="nk-pill">{done} of 4 done</span>}
      </div>
      {err ? <div className="nk-pad"><div className="nk-err">{err}</div></div> : !r ? <div className="nk-pad"><Skel rows={4} /></div> : (
        <>
          <div className="nk-raise-now" aria-label="Your credit limit now">
            <div><small>Credit limit now</small><b>{usd(r.total)}</b></div>
            <div><small>Tier · LTV</small><b>{r.tier} · {ltv(r.ltvBps)}</b></div>
            <div><small>Points</small><b>{r.points.toString()}</b></div>
            <div><small>Starter line</small><b>{r.human ? usd(r.starter) : "–"}</b></div>
          </div>
          <ol className="nk-tasks">
            <Task id="world" open={open} setOpen={setOpen} mark="WORLD" done={!!human?.done}
              title="Verify you're human with World ID" sub={human?.done ? `Verified · nullifier ${r.nullifier.slice(0, 10)}…${r.nullifier.slice(-4)} in NorenReputation` : `+50 points, unlocks tier ${human?.tier} (${ltv(r.tiers[human?.tier ?? 0].ltvBps)} LTV) and a ${usd(r.starter)} starter line on Arc`}
              before={usd(r.total)} after={human?.done ? null : usd(human!.after)} afterNote={human?.done ? undefined : `LTV ${ltv(r.ltvBps)} → ${ltv(r.tiers[human!.tier].ltvBps)}`} cta={human?.done ? undefined : "Verify"}>
              <p className="nk-fine" style={{ margin: "0 0 10px" }}>Production World ID: tap <b>Verify with World ID</b>; on a computer a QR code appears. Scan it with <b>World App</b> and finish the check on your phone. Noren keeps only the nullifier.</p>
              <VerifyHuman serverUrl={SERVER} wallet={w.oc.address} onResult={() => { onVerified(); w.refresh(); }} />
            </Task>
            <Task id="ontime" open={open} setOpen={setOpen} mark="ROBINHOOD" done={!!ontime?.done}
              title="Repay on time" sub={ontime?.done ? `${r.onTime} on-time installments · ${r.repaidLoans} loans repaid (NorenReputation milestones)` : `${Math.min(r.onTime, 3)} of 3 on-time Pay-in-3 installments (+10 each) · ${Math.min(r.repaidLoans, 1)} of 1 loan repaid (+25). Unlocks tier ${ontime?.tier} (${ltv(r.tiers[ontime?.tier ?? 0].ltvBps)} LTV)${!r.human ? "; after World ID it reaches the top tier" : ""}`}
              before={usd(r.total)} after={ontime?.done || ontime!.after === r.total ? null : usd(ontime!.after)} afterNote={ontime?.done || ontime!.after === r.total ? undefined : `LTV ${ltv(r.ltvBps)} → ${ltv(r.tiers[ontime!.tier].ltvBps)}`} cta={ontime?.done ? undefined : "How"}>
              <p className="nk-fine" style={{ margin: 0 }}>Choose <b>Pay in 3</b> at a Noren checkout and pay each installment by its due date (NorenCredit records it). A NorenBorrow loan repaid in full adds 25 points. Late payments cost 15 points, liquidations 60.{ontime && ontime.after === r.total && !ontime.done ? " At your current points this milestone alone doesn't move your tier yet; it is required for the top tier (80% LTV)." : ""}</p>
              <button type="button" className="nk-cta soft" onClick={() => { location.hash = "#/app/pay"; }}>Go to Pay</button>
            </Task>
            <ReclaimTask w={w} u={u} open={open} setOpen={setOpen} />
            <Task id="lock" open={open} setOpen={setOpen} mark="NVDA" done={r.secured > 0n}
              title="Lock collateral" sub={r.secured > 0n ? `Your deposits back ${usd(r.secured)} at ${ltv(r.ltvBps)} LTV` : `Deposit Stock Tokens or ETH in Earn: each $100 adds ${usd(lockAdd)} at your ${ltv(r.ltvBps)} LTV`}
              before={usd(r.total)} after={`${usd(r.total + lockAdd)}`} afterNote={`per $100 locked at ${ltv(r.ltvBps)}`} cta="Deposit">
              <p className="nk-fine" style={{ margin: 0 }}>Collateral stays yours and earns in a 1inch Aqua maker vault; NorenBorrow lends against it at your tier's LTV, priced by Chainlink.</p>
              <button type="button" className="nk-cta soft" onClick={() => { location.hash = "#/app/earn"; }}>Go to Earn</button>
            </Task>
          </ol>
        </>
      )}
    </section>
  );
}

function Task({ id, open, setOpen, mark, done, title, sub, before, after, afterNote, cta, children }: { id: string; open: string | null; setOpen: (v: string | null) => void; mark: string; done: boolean; title: string; sub: ReactNode; before: string; after: string | null; afterNote?: string; cta?: string; children?: ReactNode }) {
  const isOpen = open === id;
  return (
    <li className="nk-task" data-done={done} data-open={isOpen}>
      <div className="nk-task-row">
        <span className="nk-task-m"><Mark id={mark} size={30} />{done && <i aria-label="done">✓</i>}</span>
        <div className="nk-task-t"><b>{title}</b><small>{sub}</small></div>
        <div className="nk-task-l" aria-label={after ? `Limit ${before} to ${after}` : done ? "Done" : `Limit ${before}`}>
          {done ? <span className="nk-task-done">Done</span> : after ? <><s>{before}</s><b>{after}</b>{afterNote && <small>{afterNote}</small>}</> : <b>{before}</b>}
        </div>
        {children && (cta || done) && <button type="button" className="nk-task-go" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}>{isOpen ? "Close" : done ? "Details" : cta}</button>}
      </div>
      <AnimatePresence initial={false}>
        {isOpen && <motion.div className="nk-task-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}><div>{children}</div></motion.div>}
      </AnimatePresence>
    </li>
  );
}

/* ------------------------------------------------------------------ Reclaim Protocol (zkTLS) */

type ReclaimStatus = { configured: boolean; missing: string[]; error?: string; provider: { id: string; name: string } | null; verified: { proofId: string; provider: string; claim: { proved: boolean; parameters: string[]; provedAt?: number }; verifiedAt: number } | null };
type ReclaimReq = { sessionId: string; requestUrl: string; statusUrl: string; provider: { id: string; name: string }; expiresAt: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(`${SERVER}${path}`, init); } catch { throw new Error(`Setup required: can't reach the Noren server at ${SERVER} (pnpm dev:all)`); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !j.status) throw new Error("Setup required: this Noren server has no /reclaim routes (restart pnpm dev:all on the v4 branch)");
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

function ReclaimTask({ w, u, open, setOpen }: { w: Wallet; u: Underwriting | null; open: string | null; setOpen: (v: string | null) => void }) {
  const [s, setS] = useState<ReclaimStatus | null>(null);
  const [e, setE] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [modal, setModal] = useState(false);
  useEffect(() => { let on = true; api<ReclaimStatus>(`/reclaim/status?address=${w.oc.address}`).then((x) => on && (setS(x), setE(null))).catch((x) => on && setE(msgOf(x))); return () => { on = false; }; }, [w.oc.address, tick]);
  const b = u?.reclaim;
  const done = !!s?.verified || !!b?.verified;
  const before = u ? usd(u.limitUsdg) : "…";
  const after = b && !b.verified && b.ifVerified.limitUsdg > (u?.limitUsdg ?? 0n) ? usd(b.ifVerified.limitUsdg) : null;
  const name = s?.provider?.name ?? "a credit-relevant account";
  const sub = done ? `Proved with ${s?.verified?.provider ?? b?.provider ?? "Reclaim"} · +${b?.points ?? 10} points on the history score` : s && !s.configured ? `Setup required: ${s.missing.join(", ")}` : `Prove ${name} from its own website with a zkTLS proof. +${b?.points ?? 10} points on the history score${b ? ` (${u?.score} → ${b.ifVerified.score})` : ""}`;
  return (
    <Task id="reclaim" open={open} setOpen={setOpen} mark="RECLAIM" done={done} title="Prove an off-chain fact with Reclaim" sub={sub}
      before={before} after={done ? null : after} afterNote="Pay-in-3 line · LTV unchanged" cta="Prove">
      {e ? <div className="nk-err">{e}</div> : !s ? <Skel rows={2} /> : !s.configured ? (
        <SetupCard title={`Setup required: ${s.missing.join(", ")}`} text="Reclaim needs an app and a provider from the Reclaim developer console. Add the three values to the Noren .env and restart pnpm dev:all; docs/RECLAIM.md has the steps. No proof is faked in the meantime." code={s.missing.map((m) => `${m}=…`).join("\n")} />
      ) : s.verified ? (
        <dl className="nk-rows">
          <dt>Provider</dt><dd>{s.verified.provider}</dd>
          <dt>Proof</dt><dd className="nk-mono" title={s.verified.proofId}>{s.verified.proofId.slice(0, 14)}…</dd>
          <dt>Fields proved</dt><dd>{s.verified.claim.parameters.length ? s.verified.claim.parameters.join(", ") : "–"} (values not stored)</dd>
          <dt>Verified</dt><dd>{new Date(s.verified.verifiedAt * (s.verified.verifiedAt < 1e12 ? 1000 : 1)).toLocaleString()}</dd>
        </dl>
      ) : (
        <>
          <p className="nk-fine" style={{ margin: "0 0 10px" }}>Reclaim Protocol proves a fact from a website you already log in to (zkTLS): the Noren server verifies the proof with Reclaim's SDK and keeps only its ID, the provider and the names of the proved fields. The history underwriter then adds {b?.points ?? 10} points, which flows into the EIP-712 credit attestation NorenCredit checks.{b?.decidedBy === "0g" ? " On this stack the 0G credit check sets the signed terms, and it does not read the proof yet, so the limit shown is the history score's." : ""}</p>
          <button type="button" className="nk-cta" onClick={() => setModal(true)}>Prove with Reclaim</button>
        </>
      )}
      <AnimatePresence>{modal && <ReclaimModal w={w} provider={name} onClose={() => setModal(false)} onDone={() => { setTick((t) => t + 1); w.refresh(); }} />}</AnimatePresence>
    </Task>
  );
}

function ReclaimModal({ w, provider, onClose, onDone }: { w: Wallet; provider: string; onClose: () => void; onDone: () => void }) {
  const [req, setReq] = useState<ReclaimReq | null>(null);
  const [state, setState] = useState<"starting" | "pending" | "verified" | "failed">("starting");
  const [err, setErr] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  useEffect(() => {
    let on = true;
    api<ReclaimReq>("/reclaim/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: w.oc.address }) })
      .then((r) => on && (setReq(r), setState("pending"))).catch((x) => on && (setErr(msgOf(x)), setState("failed")));
    return () => { on = false; };
  }, [w.oc.address]);
  useEffect(() => {
    if (!req || state !== "pending") return;
    let on = true;
    const t = setInterval(() => {
      api<{ status: "pending" | "verified" | "failed"; error?: string }>(`/reclaim/session/${req.sessionId}`).then((x) => {
        if (!on || x.status === "pending") return;
        setState(x.status); if (x.error) setErr(x.error); if (x.status === "verified") onDone();
      }).catch((x) => on && (setErr(msgOf(x)), setState("failed")));
    }, 3000);
    return () => { on = false; clearInterval(t); };
  }, [req, state]); // eslint-disable-line react-hooks/exhaustive-deps
  const svg = useMemo(() => { if (!req) return ""; const q = qrcode(0, "M"); q.addData(req.requestUrl); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }, [req]);
  return (
    <motion.div className="nk-modal" role="dialog" aria-modal="true" aria-label="Prove with Reclaim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="nk-sheet nk-reclaim" {...pop}>
        <div className="nk-sheet-h"><b>Prove with Reclaim</b><button ref={closeRef} className="nk-x" onClick={onClose} aria-label="Close">×</button></div>
        <p className="nk-fine" style={{ margin: "0 0 14px" }}>Scan with your phone to prove {provider}. Reclaim opens the provider's own site; the proof says only what the provider shows, and Noren stores none of the values.</p>
        {state === "starting" ? <div className="nk-reclaim-qr"><Spin /></div> : req && state === "pending" ? (
          <>
            <div className="nk-reclaim-qr" role="img" aria-label="QR code for the Reclaim proof request" dangerouslySetInnerHTML={{ __html: svg }} />
            <p className="nk-reclaim-s" aria-live="polite"><Spin /> Waiting for the proof from your phone…</p>
            <a className="nk-linkbtn" href={req.requestUrl} target="_blank" rel="noreferrer">On this phone? Open the request</a>
            <small className="nk-fine">Request expires {new Date(req.expiresAt * (req.expiresAt < 1e12 ? 1000 : 1)).toLocaleTimeString()}</small>
          </>
        ) : state === "verified" ? (
          <div className="nk-reclaim-ok" role="status"><b>Verified</b><p>The Noren server checked the proof with Reclaim's SDK. Your history score now counts it.</p><button type="button" className="nk-cta" onClick={onClose}>Done</button></div>
        ) : (
          <div className="nk-err" role="alert">{err ?? "The proof was not verified."}</div>
        )}
      </motion.div>
    </motion.div>
  );
}
