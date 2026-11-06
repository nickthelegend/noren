/**
 * Bridge: USDG on Robinhood Chain → USDC on Arc. The customer escrows USDG in NorenSettlementDesk; the Chainlink CRE
 * settlement workflow fetches live Relay and Across quotes, checks them against Chainlink USDG/USD and USDC/USD and
 * approves or rejects on-chain; a keeper then deposits into the approved bridge. On a local fork no real relayer
 * fills on Arc, and the UI says so. There is no CCIP lane between Robinhood Chain and Arc, so CCIP isn't offered.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { erc20Abi, parseAbi, type Address } from "viem";
import { SERVER, usdc, type Settlement } from "../api";
import { msgOf } from "../ui";
import { USDG } from "../onchain";
import type { Wallet } from "./NorenApp";
import { Coin, Card, Result, SetupCard, Skel, Spin, Track, shortHex } from "./kit";
import { fmtUnits, parseAmount, USDG_TOKEN } from "./tokens";
import { TxLink } from "../tx";
import { Mark } from "../logos";

const deskAbi = parseAbi(["function requestSettlement(uint256 amountUsdg6, address arcRecipient, uint16 maxSlippageBps) returns (bytes32 id)"]);
type Quote = { relay: { outUsdc6: string; seconds: number; feeUsd?: string } | { error: string }; across: { outUsdc6: string; seconds: number } | { error: string } };

async function get<T>(path: string): Promise<T> {
  let r: Response;
  try { r = await fetch(`${SERVER}${path}`); } catch { throw new Error(`Setup required: can't reach the Noren server at ${SERVER} (pnpm dev:all)`); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) throw new Error("Setup required: this server has no consumer bridge routes (restart pnpm dev:all on the app-dex branch)");
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export function BridgeTab({ w }: { w: Wallet }) {
  const desk = (w.oc.credit?.settlementDesk as Address | undefined) ?? null;
  const [amount, setAmount] = useState("10");
  const [slip, setSlip] = useState(100);
  const amt = useMemo(() => parseAmount(amount, 6), [amount]);
  const [q, setQ] = useState<Quote | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [list, setList] = useState<Settlement[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const have = w.hold?.usdg;

  useEffect(() => {
    if (!amt || !desk) { setQ(null); return; }
    const id = ++seq.current; setQErr(null);
    const t = setTimeout(() => get<Quote>(`/bridge/quote?amountUsdg6=${amt}&recipient=${w.oc.address}`).then((x) => id === seq.current && setQ(x)).catch((e) => id === seq.current && (setQ(null), setQErr(msgOf(e)))), 400);
    return () => clearTimeout(t);
  }, [amt, desk, w.oc.address]);
  useEffect(() => {
    if (!desk) return;
    let on = true;
    const load = () => get<{ settlements: Settlement[] }>(`/bridge/settlements/${w.oc.address}`).then((x) => on && setList(x.settlements)).catch((e) => on && setErr(msgOf(e)));
    load(); const t = setInterval(load, 3000);
    return () => { on = false; clearInterval(t); };
  }, [desk, w.oc.address]);

  const outs = q ? ([["relay", "Relay", q.relay], ["across", "Across", q.across]] as const) : [];
  const bestOut = outs.reduce<bigint | null>((m, [, , x]) => ("outUsdc6" in x && (m === null || BigInt(x.outUsdc6) > m) ? BigInt(x.outUsdc6) : m), null);

  const send = async () => {
    if (!amt || !desk) return;
    setBusy("Approving USDG…"); setErr(null);
    try {
      const { pub, wallet, chain, account } = w.oc.robinhood();
      const allowance = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [account.address, desk] });
      if (allowance < amt) { const h = await wallet.writeContract({ address: USDG, abi: erc20Abi, functionName: "approve", args: [desk, amt], chain, account }); if ((await pub.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error(`USDG approval reverted: ${h}`); }
      setBusy("Escrowing USDG in the settlement desk…");
      await pub.simulateContract({ account, address: desk, abi: deskAbi, functionName: "requestSettlement", args: [amt, account.address, slip] });
      const h = await wallet.writeContract({ address: desk, abi: deskAbi, functionName: "requestSettlement", args: [amt, account.address, slip], chain, account });
      if ((await pub.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error(`requestSettlement reverted: ${h}`);
      w.refresh();
    } catch (e) { setErr(msgOf(e)); } finally { setBusy(null); }
  };

  if (!desk) return <div className="nk-col"><Card title="Bridge"><div className="nk-pad"><SetupCard title="NorenSettlementDesk isn't deployed on this stack" text="The bridge needs the settlement desk on the Robinhood fork and its Chainlink CRE workflow. Start everything with pnpm dev:all." code="pnpm dev:all" /></div></Card></div>;

  return (
    <div className="nk-col">
      <section className="nk-card" aria-label="Bridge">
        <div className="nk-card-h"><b>Bridge</b><span className="nk-pill"><Mark id="ROBINHOOD" size={16} />Robinhood → <Mark id="ARC" size={16} />Arc</span></div>
        <div className="nk-box">
          <label htmlFor="nk-br"><span>You send · Robinhood Chain</span></label>
          <div className="nk-row"><input id="nk-br" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span className="nk-token" data-static="true"><Coin t={USDG_TOKEN} />USDG</span></div>
          <div className="nk-sub"><span>Escrowed in NorenSettlementDesk</span><span>Balance {have !== undefined ? <button type="button" onClick={() => setAmount(String(Number(have) / 1e6))}>{fmtUnits(have, 6, 2)}</button> : "–"}</span></div>
        </div>
        <div className="nk-flip" aria-hidden style={{ cursor: "default" }}>↓</div>
        <div className="nk-box">
          <span className="nk-l"><span>You receive · Arc</span><span>to {shortHex(w.oc.address, 4)}</span></span>
          <div className="nk-row"><output className={bestOut ? "" : "dim"}>{bestOut !== null ? fmtUnits(bestOut, 6, 2) : amt && !q && !qErr ? "…" : "0"}</output><span className="nk-token" data-static="true"><Coin t={{ sym: "USDC" }} />USDC</span></div>
          <div className="nk-sub"><span>Best live quote; the CRE workflow re-quotes and sets the minimum</span><span /></div>
        </div>
        {amt !== null && (
          <div className="nk-routes" aria-label="Live bridge quotes">
            {qErr ? <div className="nk-err">{qErr}</div> : !q ? <div className="nk-skel"><i /><i /></div> : outs.map(([id, name, x]) => (
              <div key={id} className="nk-route" data-best={"outUsdc6" in x && BigInt(x.outUsdc6) === bestOut} data-dead={!("outUsdc6" in x)}>
                <Mark id={id === "relay" ? "RELAY" : "ACROSS"} size={32} />
                <div><b>{name}</b><small>{"outUsdc6" in x ? `live quote · ~${x.seconds || "?"} s${"feeUsd" in x && x.feeUsd ? ` · relayer fee $${Number(x.feeUsd).toFixed(4)}` : ""}` : x.error}</small></div>
                <div className="r"><b>{"outUsdc6" in x ? fmtUnits(BigInt(x.outUsdc6), 6, 4) : "–"}</b>{"outUsdc6" in x && BigInt(x.outUsdc6) === bestOut ? <small><span className="tag">Best</span></small> : null}</div>
              </div>
            ))}
          </div>
        )}
        <div className="nk-band" role="group" aria-label="Max slippage vs Chainlink"><span>Max vs Chainlink</span>{[50, 100, 200].map((b) => <button key={b} aria-pressed={slip === b} onClick={() => setSlip(b)}>{(b / 100).toFixed(1)}%</button>)}</div>
        {err && <div className="nk-err" role="alert">{err}</div>}
        <button className="nk-cta" disabled={!!busy || !amt || (have !== undefined && !!amt && amt > have)} onClick={send}>
          {busy ? <><Spin /> {busy}</> : !amt ? "Enter an amount" : have !== undefined && amt > have ? "Not enough USDG" : "Bridge with Chainlink CRE approval"}
        </button>
        <p className="nk-fine">Quotes are live from Relay and Across (fetched by the Noren server, so your browser talks to no third party). On this local fork no real relayer fills on Arc, so the last step stays pending. CCIP has no lane between Robinhood Chain and Arc, so it isn't offered.</p>
      </section>

      {list === null ? <Skel rows={1} /> : (
        <AnimatePresence initial={false}>
          {list.map((s) => <Transfer key={s.id} s={s} />)}
        </AnimatePresence>
      )}
    </div>
  );
}

/** The workflow logs "<USDC6> USDC6 on Arc, ~Ns"; show it as USDC. */
const fmtQuote = (q?: string) => { if (!q) return "…"; const m = /^(\d+) USDC6(.*)$/.exec(q); return m ? `${usdc(m[1])} USDC${m[2]}` : q; };

function Transfer({ s }: { s: Settlement }) {
  const approved = s.status === "approved" || s.status === "executed";
  const tone = s.status === "rejected" || s.status === "failed" ? "bad" : s.status === "executed" ? "good" : "";
  return (
    <Result tone={tone} tag={`${usdc(s.amountUsdg6)} USDG → USDC`} link={<TxLink chain="robinhood" hash={s.requestTx} />}
      title={s.status === "requested" ? "Waiting for the CRE workflow…" : s.status === "rejected" ? "Rejected by the CRE workflow" : s.status === "failed" ? "Did not complete" : s.status === "approved" ? "Approved by Chainlink CRE" : "Deposited into Relay"}
      body={s.error ?? (s.cre?.decision ? `Decision: ${s.cre.decision}` : undefined)}
      kv={[["Relay quote", fmtQuote(s.quotes?.relay)], ["Across quote", fmtQuote(s.quotes?.across)], ["Minimum on Arc", s.approved ? `${usdc(s.approved.minOutUsdc6)} USDC` : "…"]]}>
      <div style={{ marginTop: 16 }}>
        <Track steps={[
          { k: "Escrowed", on: true, d: "Robinhood" },
          { k: "CRE approval", on: approved, d: s.cre ? `${(s.cre.ms / 1000).toFixed(1)} s` : "" },
          { k: "Bridge deposit", on: s.status === "executed", d: s.deposit ? <TxLink chain="robinhood" hash={s.deposit.tx} n={4} /> : "" },
          { k: "USDC on Arc", on: false, d: s.status === "executed" ? "needs a real relayer" : "" },
        ]} />
      </div>
    </Result>
  );
}
