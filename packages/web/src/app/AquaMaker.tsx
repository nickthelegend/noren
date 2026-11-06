/**
 * "This money is 1inch Aqua liquidity": the maker address, its strategies, the Aqua balances they allocate (the tokens
 * stay in the maker's own contract) and the trading fees it has realised, all read from NorenLiquidity and its
 * MakerFill / MakerSale logs on the Robinhood fork. Used by Earn (deposit vaults) and Borrow (the lender pool).
 */
import { useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { msgOf } from "../ui";
import type { Wallet } from "./NorenApp";
import { readMaker, type MakerView } from "./aqua-maker";
import { TOKENS, fmtUnits } from "./tokens";
import { Skel, SetupCard, shortHex } from "./kit";
import { TxLink } from "../tx";
import { Copy } from "../ui";
import { Mark } from "../logos";

const symOf = (a: Address) => TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase())?.sym ?? shortHex(a, 4);
const decOf = (a: Address) => TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase())?.decimals ?? 18;

/** The three jobs one balance does, in Noren's words. `uses` marks which ones apply to this maker. */
export function ThreeJobs({ uses }: { uses: { loans: ReactNode; fees: ReactNode; liquidations: ReactNode } }) {
  return (
    <ol className="nk-jobs" aria-label="What the same balance does">
      <li><i aria-hidden>1</i><div><b>Backs loans</b><small>{uses.loans}</small></div></li>
      <li><i aria-hidden>2</i><div><b>Earns trading fees</b><small>{uses.fees}</small></div></li>
      <li><i aria-hidden>3</i><div><b>Runs liquidations</b><small>{uses.liquidations}</small></div></li>
    </ol>
  );
}

export function AquaMakerPanel({ w, maker, title, sub, jobs }: { w: Wallet; maker: Address; title: string; sub: string; jobs: { loans: ReactNode; fees: ReactNode; liquidations: ReactNode } }) {
  const [m, setM] = useState<MakerView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true; readMaker(w, maker).then((x) => on && (setM(x), setErr(null))).catch((e) => on && setErr(msgOf(e))); return () => { on = false; }; }, [w.tick, maker]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = m?.strategies.filter((s) => s.active) ?? [];
  return (
    <section className="nk-card nk-aqua" aria-label={title}>
      <div className="nk-card-h">
        <div><b className="lg-row"><Mark id="1INCH" size={20} />{title}</b><p>{sub}</p></div>
        <span className={`nk-pill ${active.length ? "live" : ""}`}>{m ? `${active.length} live strateg${active.length === 1 ? "y" : "ies"}` : "…"}</span>
      </div>
      <div className="nk-pad">
        <div className="nk-maker">
          <small>Aqua maker</small>
          <span className="nk-mono">{shortHex(maker, 10)}</span>
          <Copy text={maker} />
        </div>
        <ThreeJobs uses={jobs} />
        {err ? <SetupCard title="Can't read the Aqua maker" text={err} /> : !m ? <Skel rows={2} /> : (
          <>
            <div className="nk-stats">
              <div className="nk-stat"><small>Trading fees realised</small><b className={m.feesUsdg > 0n ? "ok" : ""}>{fmtUnits(m.feesUsdg, 6, 4)} USDG</b></div>
              <div className="nk-stat"><small>Fills</small><b>{m.strategies.reduce((n, s) => n + s.fills, 0)}</b></div>
            </div>
            {m.strategies.length === 0 ? <p className="nk-fine">This maker hasn't shipped an Aqua strategy yet, so it earns nothing from fills.</p> : (
              <ul className="nk-items nk-strats" aria-label="Aqua strategies">
                {m.strategies.map((s) => (
                  <li key={s.hash}>
                    <Mark id={symOf(s.asset)} size={28} />
                    <div>
                      <b>{symOf(s.asset)} ⇄ USDG · {s.active ? "live" : "docked"}</b>
                      <small>Buys at Chainlink −{(s.bidBps / 100).toFixed(2)}%{s.askBps && s.askBps < 65535 ? ` · sells at +${(s.askBps / 100).toFixed(2)}%` : " · buy-only"} · strategy <span className="nk-mono">{shortHex(s.hash, 6)}</span></small>
                      <small>Aqua allocation: {fmtUnits(s.aquaAsset, decOf(s.asset), 4)} {symOf(s.asset)} + {fmtUnits(s.aquaUsdg, 6, 2)} USDG, still in the maker's contract</small>
                    </div>
                    <div className="r"><b className={s.feesUsdg > 0n ? "ok-t" : ""}>{fmtUnits(s.feesUsdg, 6, 4)}</b><small>fees · {s.fills} fill{s.fills === 1 ? "" : "s"}</small></div>
                  </li>
                ))}
              </ul>
            )}
            {m.fills.length > 0 && (
              <details className="nk-fills">
                <summary>Last fills ({m.fills.length})</summary>
                <ul className="nk-items">
                  {m.fills.slice(0, 6).map((f) => (
                    <li key={`${f.tx}-${f.kind}`}>
                      <div><b>{f.kind === "buy" ? "Bought" : "Sold"} {fmtUnits(f.amount, decOf(f.asset), 5)} {symOf(f.asset)} for {fmtUnits(f.usdg, 6, 2)} USDG</b><small>fee {fmtUnits(f.feeUsdg, 6, 4)} USDG vs Chainlink · taker {shortHex(f.taker, 4)}</small></div>
                      <div className="r"><TxLink chain="robinhood" hash={f.tx} n={4} /></div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        <p className="nk-attrib">Powered by Aqua and SwapVM — © Degensoft Ltd 2025</p>
      </div>
    </section>
  );
}
