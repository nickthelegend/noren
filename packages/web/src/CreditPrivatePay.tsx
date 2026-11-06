/**
 * Pay later, privately. The credit line draws into the Kohaku privacy pool under this browser's own precommitment
 * (NorenCreditLine.drawToPool), the compliance check (ASP) clears the deposit, and then the ordinary private checkout
 * pays the merchant from the pool. The merchant never learns which customer paid; the lender still knows its borrower.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, short, usdc, type Config, type InvoiceView } from "./api";
import { Icon, msgOf } from "./ui";
import { surfaceHref } from "./hosted";
import type { Line, Onchain } from "./onchain";
import type { Wallet } from "./wallet";
import { TxLink } from "./tx";
import { Mark } from "./logos";

type Phase = "idle" | "drawing" | "screening" | "paying";
type PayStep = "idle" | "binding" | "proving" | "relaying" | "paid" | "error";

export function CreditPrivatePay({ cfg, view, shop, wallet, bal, payStep, proofSec, onFunded, onDrawn }: {
  cfg: Config; view: InvoiceView; shop: string; wallet: Wallet | null; bal: { approved: bigint; pending: bigint } | null;
  payStep: PayStep; proofSec: number | null; onFunded: () => Promise<void>; onDrawn: (d: { lineId: string; tx: string; amount: bigint }) => void;
}) {
  const [tk, setTk] = useState<Onchain | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [pool, setPool] = useState<{ on: boolean; minimum: bigint } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gas, setGas] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: ReactNode; bad?: boolean } | null>(null);
  const [drawTx, setDrawTx] = useState<string | null>(null);

  useEffect(() => { import("./onchain").then((m) => setTk(m.makeOnchain(cfg))).catch((e) => setErr(msgOf(e))); }, [cfg]);
  const load = useCallback(async () => {
    if (!tk) return;
    try { const [l, p] = await Promise.all([tk.lines(), tk.poolDraw()]); setLines(l); setPool(p); setErr(null); } catch (e) { setErr(msgOf(e)); }
    try { setGas(await tk.arcGas()); } catch { setGas(null); }
  }, [tk]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const amount = BigInt(view.invoice.amount);
  if (err) return <div className="co-setup"><span className="eyebrow">Setup required</span><p>{err.replace(/^Setup required:\s*/, "")}</p></div>;
  if (!lines || !pool) return <div className="co-setup quiet"><span className="spin xs" /> Reading your credit line on Robinhood and Arc…</div>;
  const line = lines.filter((l) => !l.closed).at(-1);
  if (!line) return (
    <div className="co-credit-empty">
      <p><b>You don't have a credit line yet.</b> Lock Stock Tokens on Robinhood Chain to open a credit line. It reaches Arc through a Chainlink CRE workflow in a few seconds.</p>
      <a className="btn line full" href={surfaceHref("#/app")}>Open a credit line in the Noren app <Icon.arrow /></a>
    </div>
  );
  if (!pool.on) return <div className="co-setup"><span className="eyebrow">Setup required</span><p>This credit line can't draw into the privacy pool yet: its owner hasn't called NorenCreditLine.setPrivacyPool. Pay in 3 still works, publicly.</p></div>;

  const owed = line.drawn - line.repaid;
  const available = line.limit > owed ? line.limit - owed : 0n;
  // The pool takes deposits of at least its minimum; a smaller invoice draws the minimum and keeps the rest private.
  const draw = amount < pool.minimum ? pool.minimum : amount;
  const funded = !!bal && bal.approved >= amount;
  const needGas = gas !== null && gas === 0n;
  const working = phase !== "idle" || busy !== null;

  const go = async () => {
    if (!wallet || !tk) return;
    setNote(null);
    try {
      if (!funded) {
        setPhase("drawing");
        const precommitment = await wallet.nextPrecommitment();
        const r = await tk.drawToPool(line.lineId, draw, precommitment);
        setDrawTx(r.hash); onDrawn({ lineId: line.lineId, tx: r.hash, amount: draw });
        setPhase("screening");
        for (let i = 0; ; i++) {
          const b = await wallet.balances();
          if (b.approved >= amount) break;
          if (i === 45) throw new Error("The compliance check hasn't cleared the draw yet. It stays in your private balance; press the button again once it shows as available.");
          await new Promise((ok) => setTimeout(ok, 2000));
        }
      }
      setPhase("paying");
      await onFunded();
    } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setPhase("idle"); load(); }
  };

  // Where the four steps are: 0 draw, 1 compliance check, 2 prove (incl. binding), 3 relay, 4 all done.
  const cur = payStep === "paid" ? 4 : phase === "drawing" ? 0 : phase === "screening" ? 1 : phase === "paying" ? (payStep === "relaying" ? 3 : 2) : funded ? 2 : -1;
  const steps: [string, string][] = [
    ["Draw on your credit line", funded ? "your private balance already covers it" : `${usdc(draw)} USDC into your private balance, under your own key`],
    ["Compliance check", "the pool's screening clears the deposit"],
    ["Prove on this device", proofSec ? `done in ${proofSec.toFixed(2)} s` : "zero-knowledge; nothing leaves your browser"],
    [`${shop} relays it`, "from the pool: no wallet, no credit line"],
  ];

  return (
    <div className="co-credit">
      <div className="co-bal">
        <div><span>Available credit</span><b>{usdc(available)}<em className="lg-row"><Mark id="USDC" size={16} />USDC</em></b></div>
        <div><span>Private balance</span><b>{bal ? usdc(bal.approved) : <span className="skel-t sm" />}<em>USDC</em></b>{bal && bal.pending > 0n && <small className="pend"><span className="spin xs" /> +{usdc(bal.pending)} being screened</small>}</div>
      </div>
      <div className="co-privacy light">
        <Icon.eyeOff />
        <p><b>{shop} never learns who paid.</b> Your credit line tops up your private balance, and {shop} is paid from the pool. Your lender still knows you: the draw and your repayments are public and tied to line <span className="mono">{short(line.lineId, 4)}</span>.</p>
      </div>
      {draw > amount && !funded && <p className="faint sm">Draws {usdc(draw)} USDC: the pool's minimum deposit is {usdc(pool.minimum)} USDC. The {usdc(draw - amount)} USDC left over stays in your private balance.</p>}
      <ol className="co-steps">
        {steps.map(([t, d], i) => {
          const state = i < cur ? "done" : i === cur && phase !== "idle" ? "now" : "todo";
          return <li key={t} data-state={state}><i>{state === "done" ? <Icon.check /> : state === "now" ? <span className="spin xs" /> : i + 1}</i><div><b>{t}</b><span>{d}</span></div></li>;
        })}
      </ol>
      {needGas && (
        <button className="btn line full" disabled={working} onClick={async () => { setBusy("gas"); try { await api.faucet(tk!.address); await load(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); } }}>
          {busy === "gas" ? <><span className="spin" /> Sending…</> : "Get test gas on Arc"}
        </button>
      )}
      {drawTx && <p className="note sm">Drawn into your private balance: tx <TxLink chain="arc" cfg={cfg} hash={drawTx} /></p>}
      {note && <p className={note.bad ? "err" : "note"} role="status">{note.t}</p>}
      <button className="btn ink full xl" disabled={!wallet || working || needGas || (!funded && available < draw) || (view.status !== "open" && view.status !== "draft")} onClick={go}>
        {phase === "drawing" ? <><span className="spin" /> Drawing on your line…</> : phase === "screening" ? <><span className="spin" /> Compliance check…</> : phase === "paying" ? <><span className="spin" /> {payStep === "proving" ? "Proving on this device…" : payStep === "relaying" ? `${shop} is relaying…` : "Binding invoice…"}</>
          : !funded && available < draw ? `Not enough credit (${usdc(available)} USDC)` : <><Icon.lock /> Pay {usdc(amount)} USDC later, privately</>}
      </button>
      <p className="faint sm center">NorenCreditLine.drawToPool, then NorenCheckout.pay from the Kohaku pool. Repay later in the <a href={surfaceHref("#/app/credit")}>Noren app</a>; repayments are public.</p>
    </div>
  );
}
