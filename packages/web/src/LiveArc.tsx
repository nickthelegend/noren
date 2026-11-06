/** "Arc testnet (live)": the public deployment and its recorded payments, with explorer links and live reads. */
import { useEffect, useState } from "react";
import { LIVE, addrUrl, liveFacts, txUrl, useNet, type Net } from "./network";
import "./live.css";

const short = (h: string, n = 6) => `${h.slice(0, n + 2)}…${h.slice(-4)}`;
const usdc = (v: bigint | string) => (Number(BigInt(v)) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function NetSwitch({ dark }: { dark?: boolean }) {
  const [n, set] = useNet();
  const opt = (v: Net, t: string, s: string) => <button type="button" role="radio" aria-checked={n === v} aria-label={t} onClick={() => set(v)}>{v === "live" && <i aria-hidden />}<span className="la-long">{t}</span><span className="la-short" aria-hidden>{s}</span></button>;
  return <div className={`la-switch ${dark ? "dark" : ""}`} role="radiogroup" aria-label="Network">{opt("fork", "Local fork", "Fork")}{opt("live", "Arc testnet (live)", "Live")}</div>;
}

export function LiveArc({ context }: { context: "app" | "checkout" | "merchant" }) {
  const [f, setF] = useState<Awaited<ReturnType<typeof liveFacts>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true; liveFacts().then((x) => on && setF(x)).catch((e) => on && setErr(String(e?.message ?? e))); return () => { on = false; }; }, []);
  const e2e = LIVE.e2e;
  const pick = (re: RegExp) => e2e.steps.find((s) => re.test(s.step));
  const pay = pick(/^pay \d/i), refund = pick(/^refund \d/i), shield = pick(/^shield/i);
  return (
    <section className="la" aria-label="Noren live on Arc testnet">
      <header><span className="la-dot" aria-hidden /><div><b>Live on Arc testnet</b><small>chain {LIVE.chainId} · real testnet USDC · {f ? `block ${f.block.toString()}` : err ? "RPC unreachable" : "reading…"}</small></div></header>
      {context === "checkout" && <p className="la-note">This hosted checkout runs on the local fork. On Arc testnet the same flow ran end to end from the SDK and the merchant server (<code>scripts/live/e2e-live.ts</code>): a private 2.50 USDC payment, then a 1.00 USDC refund into the shielded inbox.</p>}
      {context === "app" && <p className="la-note">Only Arc has a live deployment. Swap, Earn, Borrow and the Robinhood side of credit run on the Robinhood Chain fork; switch back to “Local fork” to use them.</p>}
      <dl className="la-grid">
        <div><dt>NorenCheckout</dt><dd><a href={addrUrl(LIVE.checkout)} target="_blank" rel="noreferrer">{short(LIVE.checkout)}</a></dd></div>
        <div><dt>Privacy pool (USDC)</dt><dd><a href={addrUrl(LIVE.pool)} target="_blank" rel="noreferrer">{short(LIVE.pool)}</a>{f && <small>{usdc(f.poolBal)} USDC shielded now</small>}</dd></div>
        <div><dt>NorenRateOracle (CRE)</dt><dd><a href={addrUrl(LIVE.oracle)} target="_blank" rel="noreferrer">{short(LIVE.oracle)}</a><small>€100 = {usdc(LIVE.pricing.quoteEur100)} USDC at the written rounds</small></dd></div>
        <div><dt>NorenCreditLine (CRE)</dt><dd><a href={addrUrl(LIVE.creditLine)} target="_blank" rel="noreferrer">{short(LIVE.creditLine)}</a></dd></div>
      </dl>
      <ul className="la-tx">
        {shield && <li><span>Shield 5 USDC into the pool</span><a href={txUrl(shield.tx)} target="_blank" rel="noreferrer">{short(shield.tx, 8)} ↗</a></li>}
        {pay && <li><span><b>Private payment, {usdc(e2e.invoice.amountUsdc6)} USDC</b> · proof {e2e.proofSeconds} s · {f ? (f.paid ? "NorenCheckout.paid = true now" : "not paid?") : "checking…"}</span><a href={txUrl(pay.tx)} target="_blank" rel="noreferrer">{short(pay.tx, 8)} ↗</a></li>}
        {refund && <li><span>Refund 1.00 USDC to the shielded inbox</span><a href={txUrl(refund.tx)} target="_blank" rel="noreferrer">{short(refund.tx, 8)} ↗</a></li>}
        <li><span>CRE pricing report → NorenRateOracle</span><a href={txUrl(LIVE.pricing.simulateTx)} target="_blank" rel="noreferrer">{short(LIVE.pricing.simulateTx, 8)} ↗</a></li>
        <li><span>CRE credit-line report → NorenCreditLine</span><a href={txUrl(LIVE.credit.starterTx)} target="_blank" rel="noreferrer">{short(LIVE.credit.starterTx, 8)} ↗</a></li>
      </ul>
      <p className="la-fine">The payer's address appears in neither the payment nor the refund transaction. The live pool is new, so its anonymity set is tiny: timing can still link a payment to a deposit. Robinhood Chain, fiat-priced invoices and this browser checkout are fork-only. {err ? `Live reads failed: ${err}` : f ? `Payout now holds ${usdc(f.payoutBal)} USDC.` : ""}</p>
    </section>
  );
}
