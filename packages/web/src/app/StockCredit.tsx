/**
 * "Deposit stock on Aqua pools, get credit." Shared by Earn, Borrow and Credit:
 * - StockLtv: the pitch, the worked example ($100 of NVDA → borrow at today's LTV, up to the top tier) and the LTV
 *   ladder. Every percentage is read live from NorenReputation.tierTable(0..3) and this wallet's breakdownOf; the
 *   unlock rules shown are the contract's own (minPoints, needsHuman, needsRepayment). Nothing is hard-coded.
 * - StockCreditFlow (Credit tab): the five steps from a deposit to a line that pays itself down, each with live state.
 *   Today the deposit backs NorenBorrow (USDG) and the World ID starter line; locked shares' Aqua fees pay a loan down
 *   with harvestToRepay. Step 5 says so until NorenCredit takes share collateral (contracts-audit branch).
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { msgOf } from "../ui";
import { Mark } from "../logos";
import type { Wallet } from "./NorenApp";
import { reputationAbi } from "./earn";
import { fmtUnits } from "./tokens";
import { Skel } from "./kit";

type Tier = { ltvBps: number; minPoints: number; needsHuman: boolean; needsRepayment: boolean };
export type LtvState = { tiers: Tier[]; tier: number; ltvBps: number; points: bigint; human: boolean; totalUsd6: bigint; securedUsdg: bigint; starterUsdc: bigint };

export function useLtv(w: Wallet, nonce = 0) {
  const rep = w.oc.credit?.reputation as Address | undefined;
  const [s, setS] = useState<LtvState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!rep) { setErr("Setup required: NorenReputation isn't deployed on this stack (pnpm dev:all)"); return; }
    let on = true;
    const { pub } = w.oc.robinhood();
    Promise.all([
      Promise.all([0, 1, 2, 3].map((t) => pub.readContract({ address: rep, abi: reputationAbi, functionName: "tierTable", args: [t] }))),
      pub.readContract({ address: rep, abi: reputationAbi, functionName: "breakdownOf", args: [w.oc.address] }),
      pub.readContract({ address: rep, abi: reputationAbi, functionName: "creditLimitOf", args: [w.oc.address] }),
    ]).then(([tt, b, l]: any) => on && (setErr(null), setS({
      tiers: tt.map((t: any) => ({ ltvBps: Number(t.ltvBps), minPoints: Number(t.minPoints), needsHuman: t.needsHuman, needsRepayment: t.needsRepayment })),
      tier: Number(b.tier), ltvBps: Number(b.ltvBps), points: b.points, human: b.verifiedHuman, totalUsd6: l[0], securedUsdg: l[1], starterUsdc: l[2],
    }))).catch((e) => on && setErr(msgOf(e)));
    return () => { on = false; };
  }, [rep, w.tick, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return { s, err };
}

const pct = (bps: number) => `${(bps / 100).toFixed(0)}%`;
const unlock = (t: Tier, i: number) => i === 0 ? "Any deposit" : [t.minPoints ? `${t.minPoints} points` : "", t.needsHuman ? "World ID" : "", t.needsRepayment ? "a repayment milestone" : ""].filter(Boolean).join(" + ");

/** The pitch, the $100-of-NVDA example and the ladder, all from the contract. */
export function StockLtv({ w, compact }: { w: Wallet; compact?: boolean }) {
  const { s, err } = useLtv(w);
  const lo = s?.tiers[0].ltvBps, hi = s?.tiers[s.tiers.length - 1].ltvBps;
  return (
    <section className="nk-card nk-stockltv" aria-label="Deposit stock, get credit">
      <div className="nk-card-h">
        <div>
          <b className="lg-row nk-stockltv-t"><span className="co-stack" aria-hidden><Mark id="NVDA" size={22} /><Mark id="TSLA" size={22} /><Mark id="AAPL" size={22} /><Mark id="ETH" size={22} /></span>Deposit stock, get credit</b>
          <p>Deposit NVDA, TSLA, AAPL or ETH into Noren's 1inch Aqua pools instead of selling. Borrow up to {hi !== undefined ? pct(hi) : "80%"} of their value. The fees they earn pay the loan back.</p>
        </div>
        <span className="nk-pill"><Mark id="1INCH" size={16} />Aqua pools</span>
      </div>
      {err ? <div className="nk-err">{err}</div> : !s ? <Skel rows={2} /> : (
        <>
          <div className="nk-example" aria-label="Worked example">
            <div><small>You deposit</small><b className="lg-row"><Mark id="NVDA" size={20} />$100 of NVDA</b></div>
            <span aria-hidden>→</span>
            <div><small>Borrow today</small><b>${fmtUnits(BigInt(lo!) * 10_000n, 6, 0)}</b><em>{pct(lo!)} LTV</em></div>
            <span aria-hidden>→</span>
            <div><small>Up to, at the top tier</small><b className="ok">${fmtUnits(BigInt(hi!) * 10_000n, 6, 0)}</b><em>{pct(hi!)} LTV</em></div>
          </div>
          {!compact && (
            <ol className="nk-ladder" aria-label="LTV by reputation tier (NorenReputation.tierTable)">
              {s.tiers.map((t, i) => (
                <li key={i} data-on={s.tier >= i} data-here={s.tier === i}>
                  <b>{pct(t.ltvBps)}</b>
                  <small>{unlock(t, i)}</small>
                  {s.tier === i && <i>you are here</i>}
                </li>
              ))}
            </ol>
          )}
          <p className="nk-fine" style={{ margin: "10px 2px 0" }}>Read live from NorenReputation on Robinhood Chain: tier {s.tier}, {s.points.toString()} points, your LTV {pct(s.ltvBps)}. Prices are Chainlink's; below the liquidation point the collateral is sold to 1inch Aqua makers.</p>
        </>
      )}
    </section>
  );
}

/** Credit tab: deposit → limit → open the line → spend → fees pay it down. */
export function StockCreditFlow({ w, nonce, go }: { w: Wallet; nonce: number; go: (hash: string) => void }) {
  const { s, err } = useLtv(w, nonce);
  const hi = s?.tiers[s.tiers.length - 1].ltvBps;
  // The same deposits at the top tier's LTV (scaled from the contract's own secured capacity at today's LTV).
  const topSecured = s && hi && s.ltvBps ? (s.securedUsdg * BigInt(hi)) / BigInt(s.ltvBps) : 0n;
  const steps = s ? [
    { k: "Deposit NVDA into the Aqua pool", d: s.securedUsdg > 0n ? `Your deposits back $${fmtUnits(s.securedUsdg, 6, 2)} at ${pct(s.ltvBps)}` : "Earn: NVDA, TSLA, AAPL or ETH; it stays yours and earns trading fees", on: s.securedUsdg > 0n, act: ["Deposit", "#/app/earn"] },
    { k: `Credit limit: $${fmtUnits(s.totalUsd6, 6, 2)} (${pct(s.ltvBps)})`, d: s.tier >= s.tiers.length - 1 ? `Top tier reached: ${pct(hi!)} LTV` : `Complete the tasks below → up to ${pct(hi!)}${topSecured > 0n ? ` ($${fmtUnits(topSecured + s.starterUsdc, 6, 2)})` : ""}`, on: s.totalUsd6 > 0n, act: ["Raise it", "#nk-raise"] },
    { k: "Open the credit line", d: "Lock collateral on NorenCredit; Chainlink CRE carries the limit to Arc", on: false, act: ["Open", "#nk-line"] },
    { k: "Spend with Pay later", d: "Pay in 3, or Pay later, privately, at any Noren checkout", on: false, act: ["Pay", "#/app/pay"] },
    { k: "Your NVDA's fees pay the line down", d: "Locked shares stay Aqua liquidity; their trading fees repay what you owe (harvestToRepay on loans today)", on: false, act: ["See fees", "#/app/borrow"] },
  ] : [];
  return (
    <section className="nk-card nk-flow5" aria-label="From stock to credit">
      <div className="nk-card-h"><div><b>Stock → credit, in five steps</b><p>Deposit stock into the Aqua pool, and up to {hi !== undefined ? pct(hi) : "80%"} of it becomes your credit limit. Underwater collateral is liquidated through Aqua makers.</p></div></div>
      {err ? <div className="nk-err">{err}</div> : !s ? <Skel rows={3} /> : (
        <ol className="nk-flow5-l">
          {steps.map((x, i) => (
            <li key={x.k} data-on={x.on}>
              <span className="nk-flow5-n">{x.on ? "✓" : i + 1}</span>
              <div><b>{x.k}</b><small>{x.d}</small></div>
              <button type="button" className="nk-task-go" onClick={() => go(x.act[1])}>{x.act[0]}</button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
