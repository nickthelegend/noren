/** "Arc testnet (live)": the public deployment and its recorded payments, with explorer links and live reads. */
import { useEffect, useState } from "react";
import { LIVE, addrUrl, liveFacts, liveOracleFreshness, useNet, type Net, type OracleFreshness } from "./network";
import { TxLink } from "./tx";
import { Mark } from "./logos";
import { AQUA_LIVE, CCTP_CHAINS, CCTP_RUNS, CCIP_MESSAGES, CHAIN_MARK, runLabel, ccipMsgUrl, shortChain } from "./crosschain";
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
  const [fx, setFx] = useState<OracleFreshness | null>(null);
  useEffect(() => { let on = true; liveFacts().then((x) => on && setF(x)).catch((e) => on && setErr(String(e?.message ?? e))); liveOracleFreshness().then((x) => on && setFx(x)); return () => { on = false; }; }, []);
  const e2e = LIVE.e2e;
  const pick = (re: RegExp) => e2e.steps.find((s) => re.test(s.step));
  const pay = pick(/^pay \d/i), refund = pick(/^refund \d/i), shield = pick(/^shield/i);
  return (
    <section className="la" aria-label="Noren live on Arc testnet">
      <header><span className="la-dot" aria-hidden /><Mark id="ARC" size={24} /><div><b>Live on Arc testnet</b><small>chain {LIVE.chainId} · real testnet USDC · {f ? `block ${f.block.toString()}` : err ? "RPC unreachable" : "reading…"}</small></div></header>
      {context === "checkout" && <p className="la-note">This hosted checkout runs on the local fork. On Arc testnet the same flow ran end to end from the SDK and the merchant server (<code>scripts/live/e2e-live.ts</code>): a private 2.50 USDC payment, then a 1.00 USDC refund into the shielded inbox.</p>}
      {context === "app" && <p className="la-note">Arc, the CCTP rail, the CCIP gateways and 1inch Aqua on Arc are live on public testnets (below). Swap, Earn, Borrow and the Robinhood side of credit run on the Robinhood Chain fork; switch back to “Local fork” to use them.</p>}
      <dl className="la-grid">
        <div><dt>NorenCheckout</dt><dd><a href={addrUrl(LIVE.checkout)} target="_blank" rel="noreferrer">{short(LIVE.checkout)}</a></dd></div>
        <div><dt>Privacy pool (USDC)</dt><dd><a href={addrUrl(LIVE.pool)} target="_blank" rel="noreferrer">{short(LIVE.pool)}</a>{f && <small>{usdc(f.poolBal)} USDC shielded now</small>}</dd></div>
        <div><dt>NorenRateOracle (CRE)</dt><dd><a href={addrUrl(LIVE.oracle)} target="_blank" rel="noreferrer">{short(LIVE.oracle)}</a><small>{!fx ? "checking freshness…" : fx.state === "fresh" ? <>€100 = {usdc(fx.usdcFor100Eur)} USDC now · rounds {Math.round(fx.ageSec / 3600)} h old</> : fx.state === "stale" ? <span className="la-stale">Price stale: the Chainlink round is older than {Math.round(fx.maxAge / 3600)} h, so quotes are refused until the next CRE run (<code>scripts/live/cre-live.ts</code>)</span> : <>€100 = {usdc(LIVE.pricing.quoteEur100)} USDC at the written rounds</>}</small></dd></div>
        <div><dt>NorenCreditLine (CRE)</dt><dd><a href={addrUrl(LIVE.creditLine)} target="_blank" rel="noreferrer">{short(LIVE.creditLine)}</a></dd></div>
      </dl>
      <ul className="la-tx">
        {shield && <li><span>Shield 5 USDC into the pool</span><TxLink chain="arc-live" hash={shield.tx} n={8} /></li>}
        {pay && <li><span><b>Private payment, {usdc(e2e.invoice.amountUsdc6)} USDC</b> · proof {e2e.proofSeconds} s · {f ? (f.paid ? "NorenCheckout.paid = true now" : "not paid?") : "checking…"}</span><TxLink chain="arc-live" hash={pay.tx} n={8} /></li>}
        {refund && <li><span>Refund 1.00 USDC to the shielded inbox</span><TxLink chain="arc-live" hash={refund.tx} n={8} /></li>}
        <li><span>CRE pricing report → NorenRateOracle</span><TxLink chain="arc-live" hash={LIVE.pricing.simulateTx} n={8} /></li>
        <li><span>CRE credit-line report → NorenCreditLine</span><TxLink chain="arc-live" hash={LIVE.credit.starterTx} n={8} /></li>
      </ul>
      <h3 className="la-sub">From other chains into Arc</h3>
      <ul className="la-tx">
        {CCTP_RUNS.filter((r) => r.to === "arc-testnet").map((r) => (
          <li key={r.burnTx}><span className="la-x"><Mark id={CHAIN_MARK[r.from]} size={16} /><b>{shortChain(r.from)} → Arc</b> · CCTP V2 · {runLabel(r)} · {usdc(r.minted)} USDC</span><span className="la-pair"><TxLink explorer={CCTP_CHAINS[r.from].explorer} hash={r.burnTx} n={4}>burn</TxLink><TxLink chain="arc-live" hash={r.mintTx} n={4}>mint</TxLink></span></li>
        ))}
        <li><span className="la-x"><Mark id="1INCH" size={16} /><b>1inch Aqua on Arc</b> · USDC → EURC from a Chainlink-pegged maker</span><TxLink chain="arc-live" hash={AQUA_LIVE.directSwap} n={4} /></li>
        {AQUA_LIVE.fills.map((f) => <li key={f.fill}><span className="la-x"><Mark id={CHAIN_MARK[f.from]} size={16} /><b>{shortChain(f.from)} → Arc</b> · CCTP + Aqua order, filled by CRE</span><span className="la-pair"><TxLink explorer={CCTP_CHAINS[f.from].explorer} hash={f.burn} n={4}>burn</TxLink><TxLink chain="arc-live" hash={f.fill} n={4}>fill</TxLink></span></li>)}
        {CCIP_MESSAGES.map((m) => (
          <li key={m.id}><span className="la-x"><Mark id="CHAINLINK" size={16} /><b>{m.route}</b> · CCIP · {m.action} · delivered</span><a href={ccipMsgUrl(m.id)} target="_blank" rel="noreferrer" className="tx-link">{short(m.id, 4)}</a></li>
        ))}
      </ul>
      <p className="la-fine">The payer's address appears in neither the payment nor the refund transaction. The live pool is new, so its anonymity set is tiny: timing can still link a payment to a deposit. Robinhood Chain, fiat-priced invoices and this browser checkout are fork-only. {err ? `Live reads failed: ${err}` : f ? `Payout now holds ${usdc(f.payoutBal)} USDC.` : ""}</p>
    </section>
  );
}
