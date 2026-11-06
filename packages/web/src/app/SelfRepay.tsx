/**
 * Loans that pay themselves down. Locked Earn shares stay 1inch Aqua liquidity; the trading fees they earn on real
 * fills can be harvested into the loan (NorenBorrow.harvestToRepay through the SDK's createNorenEarn). Every number
 * here is read from the chain: the pending yield from NorenBorrow.yieldOf, what was already paid from YieldRepaid
 * events. Nothing is projected; with no fills the card says nothing was earned.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { createNorenEarn, USDG, WETH } from "@noren/robinhood/sdk";
import { msgOf } from "../ui";
import type { Wallet } from "./NorenApp";
import { TOKENS, fmtUnits } from "./tokens";
import { Card, Empty, Skel, Spin, shortHex } from "./kit";
import { TxLink } from "../tx";

type Earn = ReturnType<typeof createNorenEarn>;
type Data = { preview: Awaited<ReturnType<Earn["previewYieldRepay"]>>; paid: Awaited<ReturnType<Earn["loanPaidByYield"]>> };
const symOf = (a: Address) => (a.toLowerCase() === WETH.toLowerCase() ? "nETH" : `n${TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase())?.sym ?? shortHex(a, 4)}`);

function earnSdk(w: Wallet): Earn {
  const c = w.oc.credit;
  if (!c?.borrow || !c.depositVaults) throw new Error("Setup required: NorenBorrow isn't in this stack's config (pnpm dev:all)");
  const { pub, wallet } = w.oc.robinhood();
  return createNorenEarn({
    publicClient: pub as never, walletClient: wallet as never,
    addresses: { oracle: c.stockOracle as Address, vault: c.vault as Address, gateway: c.gateway as Address, credit: c.creditContract as Address, usdg: USDG, weth: WETH, liquidity: c.aquaLiquidity as Address | undefined, borrow: c.borrow as Address, depositVaults: c.depositVaults as { asset: Address; vault: Address }[] },
  });
}

export function SelfRepayCard({ w }: { w: Wallet }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ t: ReactNode; bad?: boolean } | null>(null);
  const [poll, setPoll] = useState(0);
  const from = w.oc.credit?.robinhoodFromBlock ? BigInt(w.oc.credit.robinhoodFromBlock) : undefined;

  useEffect(() => {
    let on = true;
    try {
      const e = earnSdk(w); const me = w.oc.address as Address;
      Promise.all([e.previewYieldRepay(me), e.loanPaidByYield(me, { fromBlock: from })])
        .then(([preview, paid]) => on && (setD({ preview, paid }), setErr(null)))
        .catch((x) => on && setErr(msgOf(x)));
    } catch (x) { setErr(msgOf(x)); }
    return () => { on = false; };
  }, [w.tick, poll]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fills land while you watch (dev:all's demo trader, or real traders): re-read this card every few seconds.
  useEffect(() => { const t = setInterval(() => setPoll((n) => n + 1), 6000); return () => clearInterval(t); }, []);

  const harvest = async () => {
    setBusy(true); setNote({ t: "Taking your collateral's fees out of the vault and repaying…" });
    try {
      const r = await earnSdk(w).harvestToRepay();
      setNote({ t: <>Paid {fmtUnits(r.repaidUsdg, 6, 4)} USDG from {r.fills} Aqua fill{r.fills === 1 ? "" : "s"}: debt {fmtUnits(r.debtBeforeUsdg, 6, 4)} → <b>{fmtUnits(r.debtAfterUsdg, 6, 4)}</b> USDG (tx <TxLink chain="robinhood" hash={r.hash} />).</> });
      w.refresh();
    } catch (x) { setNote({ t: msgOf(x), bad: true }); } finally { setBusy(false); }
  };

  const p = d?.preview, paid = d?.paid;
  const locked = p ? p.vaults.length > 0 : false;
  return (
    <Card label="Your collateral keeps earning" title="Your collateral keeps earning" sub="Locked shares stay 1inch Aqua liquidity. The trading fees they earn pay your loan down.">
      <div className="nk-pad">
        {err ? <div className="nk-err">{err}</div> : !p || !paid ? <Skel rows={3} /> : !locked && paid.totalUsdg === 0n ? (
          <Empty title="No collateral locked yet" text="Lock nETH or stock shares below and borrow. Every fill against their vault earns a fee that can pay the loan down." />
        ) : (
          <>
            <div className="nk-stats">
              <div className="nk-stat"><small>Paid by your collateral's trading fees</small><b className={paid.totalUsdg > 0n ? "ok" : ""}>{fmtUnits(paid.totalUsdg, 6, 4)} USDG</b><small style={{ marginTop: 6 }}>{paid.fills > 0 ? `from ${paid.fills} Aqua fill${paid.fills === 1 ? "" : "s"} · ${paid.harvests} harvest${paid.harvests === 1 ? "" : "s"}` : "nothing harvested yet"}</small></div>
              <div className="nk-stat"><small>Earned, not used yet</small><b className={p.yieldUsdg > 0n ? "ok" : ""}>{fmtUnits(p.yieldUsdg, 6, 4)} USDG</b><small style={{ marginTop: 6 }}>{p.yieldUsdg > 0n ? `from ${p.fills} Aqua fill${p.fills === 1 ? "" : "s"}` : "No fills yet, so nothing earned yet"}</small></div>
              <div className="nk-stat"><small>Debt now</small><b>{fmtUnits(paid.debtNowUsdg, 6, 4)} USDG</b>{p.yieldUsdg > 0n && <small style={{ marginTop: 6 }}>{fmtUnits(p.debtAfterUsdg, 6, 4)} after using earnings</small>}</div>
              <div className="nk-stat"><small>Debt without earnings</small><b>{fmtUnits(paid.debtWithoutEarningsUsdg, 6, 4)} USDG</b><small style={{ marginTop: 6 }}>debt now + fees already applied</small></div>
            </div>
            {p.vaults.length > 0 && (
              <dl className="nk-rows">
                {p.vaults.map((v) => (
                  <Fragment key={v.vault}><dt>{symOf(v.asset)} locked</dt><dd className={v.yieldUsdg > 0n ? "ok" : ""}>{v.yieldUsdg > 0n ? `${fmtUnits(v.yieldUsdg, 6, 4)} USDG from ${v.fills} fill${v.fills === 1 ? "" : "s"} · ${v.path === "usdg" ? "already in USDG" : "sold to Aqua makers"}` : "no fills since it was locked"}</dd></Fragment>
                ))}
              </dl>
            )}
            {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
            <button className="nk-cta" disabled={busy || p.yieldUsdg === 0n || p.debtUsdg === 0n} onClick={harvest}>
              {busy ? <><Spin /> Paying down…</> : p.debtUsdg === 0n ? "No loan to pay down" : p.yieldUsdg === 0n ? "Nothing earned yet" : `Use earnings to pay down loan · ${fmtUnits(p.yieldUsdg, 6, 4)} USDG`}
            </button>
            <p className="nk-attrib">Fees come only from real fills against your vault's Aqua strategy; nothing here is projected. Anyone can trigger this as a keeper: the USDG only ever repays your loan, and only shares worth the fees leave your collateral.</p>
          </>
        )}
      </div>
    </Card>
  );
}
