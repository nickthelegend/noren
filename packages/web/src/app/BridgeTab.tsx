/**
 * Bridge: bring USDC to Arc from any chain.
 * 0. The hero: Circle CCTP V2 from the 10 testnets linked to Arc (Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia,
 *    Robinhood Chain testnet and six more), burned on the source and minted on Arc by NorenArcHook; Arc → any chain as
 *    the reverse; and "Stocks → USDC on Arc" through the cross-chain Aqua order (fork demo). A 3-step explainer each.
 * 1. The mainnet route for USDG earned on Robinhood Chain: the customer escrows USDG in NorenSettlementDesk; the
 *    Chainlink CRE settlement workflow fetches live Relay and Across quotes, checks them against Chainlink USDG/USD and
 *    USDC/USD and approves or rejects on-chain; a keeper then deposits into the approved bridge. That runs on the
 *    Robinhood fork, where no real relayer fills on Arc, and the UI says so.
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
import { CctpCard, RecentCctp } from "./CctpCard";
import { CCTP_CHAINS, CHAIN_MARK, SOURCE_CHAINS, shortChain } from "../crosschain";
import type { SourceChainKey } from "@noren/cctp";
import { ArcOut } from "./ArcOut";
import { XChainSwap } from "./XChainSwap";

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

  const top = <AnyChainArc w={w} />;
  if (!desk) return <div className="nk-col">{top}<Card title="USDG to Arc · mainnet route"><div className="nk-pad"><SetupCard title="NorenSettlementDesk isn't deployed on this stack" text="This route needs the settlement desk on the Robinhood fork and its Chainlink CRE workflow. Start everything with pnpm dev:all." code="pnpm dev:all" /></div></Card><RecentCctp all /></div>;

  return (
    <div className="nk-col">
      {top}
      <section className="nk-card" aria-label="USDG to Arc, mainnet route">
        <div className="nk-card-h"><div><b>USDG to Arc · mainnet route</b><p>Robinhood Chain has no CCTP on mainnet, so USDG goes through Relay or Across, approved by Chainlink CRE.</p></div><span className="nk-pill fork"><Mark id="ROBINHOOD" size={16} />fork</span></div>
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
        <p className="nk-fine">Quotes are live mainnet quotes from Relay and Across (fetched by the Noren server, so your browser talks to no third party). On this local fork no real relayer fills on Arc, so the last step stays pending. Instructions (not tokens) from Robinhood reach Arc over Chainlink CCIP through a Base hub, because there is no direct lane.</p>
      </section>

      {list === null ? <Skel rows={1} /> : (
        <AnimatePresence initial={false}>
          {list.map((s) => <Transfer key={s.id} s={s} />)}
        </AnimatePresence>
      )}
      <RecentCctp all />
    </div>
  );
}

/** The chains shown first in the picker row; every other CCTP chain is one tap away in the sheet. */
const FIRST: SourceChainKey[] = ["ethereum-sepolia", "base-sepolia", "arbitrum-sepolia", "robinhood-testnet"];

/** The hero: any chain ⇄ Arc. USDC both ways over CCTP V2 (public testnets), and stock → USDC through Aqua. */
function AnyChainArc({ w }: { w: Wallet }) {
  const [dir, setDir] = useState<"in" | "out" | "stock">("in");
  const [chain, setChain] = useState<SourceChainKey>("ethereum-sepolia");
  const rest = SOURCE_CHAINS.filter((c) => !FIRST.includes(c.key));
  const c = CCTP_CHAINS[chain];
  return (
    <section className="nk-card nk-rharc" aria-label="Bring USDC to Arc from any chain">
      <div className="nk-card-h">
        <div>
          <b className="lg-row nk-rharc-t">{dir === "stock" ? <><Mark id="ROBINHOOD" size={22} />Stocks <span aria-hidden>→</span><Mark id="ARC" size={22} />USDC on Arc</> : dir === "out" ? <><Mark id="ARC" size={22} />Send USDC from Arc to any chain</> : <><Mark id="ARC" size={22} />Bring USDC to Arc from any chain</>}</b>
          <p>{dir === "stock" ? "Sell Stock Tokens on Robinhood Chain, get USDC on Arc from a 1inch Aqua maker." : `Native USDC over Circle CCTP V2 from ${SOURCE_CHAINS.length} chains: burned on one side, minted on the other. No wrapped tokens. Public testnets.`}</p>
        </div>
        <span className={`nk-pill ${dir === "stock" ? "fork" : "live"}`}>{dir === "stock" ? "fork demo" : <><Mark id="CIRCLE" size={16} />CCTP V2 · testnets</>}</span>
      </div>
      <div className="nk-band nk-markets" role="tablist" aria-label="Direction">
        {([["in", "Any chain → Arc"], ["out", "Arc → any chain"], ["stock", "Stocks → USDC"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={dir === k} aria-pressed={dir === k} onClick={() => setDir(k)}>{l}</button>)}
      </div>
      {dir !== "stock" && (
        <div className="nk-chains" role="radiogroup" aria-label={dir === "in" ? "Bring USDC from" : "Send USDC to"}>
          {FIRST.map((k) => <ChainChip key={k} k={k} on={chain === k} pick={setChain} />)}
          <label className="nk-chain-more" data-on={!FIRST.includes(chain)}>
            {!FIRST.includes(chain) ? <Mark id={CHAIN_MARK[chain]} size={20} /> : <span className="nk-chain-plus" aria-hidden>+{rest.length}</span>}
            <select aria-label="More chains" value={FIRST.includes(chain) ? "" : chain} onChange={(e) => e.target.value && setChain(e.target.value as SourceChainKey)}>
              <option value="">More chains</option>
              {rest.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select>
          </label>
        </div>
      )}
      <PathSteps kind={dir} chain={chain} />
      {dir === "in" ? <CctpCard w={w} from={chain} onFrom={setChain} bare /> : dir === "out" ? <ArcOut key={chain} to={chain} /> : <XChainSwap w={w} />}
      {dir !== "stock" && <p className="nk-fine nk-chain-note">{c.name} · CCTP domain {c.domain} · chain {c.chainId} · gas {c.gas}</p>}
    </section>
  );
}

function ChainChip({ k, on, pick }: { k: SourceChainKey; on: boolean; pick: (k: SourceChainKey) => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={CCTP_CHAINS[k].name} className="nk-chain" data-on={on} onClick={() => pick(k)}>
      <Mark id={CHAIN_MARK[k]} size={20} /><span>{shortChain(k)}</span>
    </button>
  );
}

/** The three steps of each cross-chain path, drawn from what the code does. */
function PathSteps({ kind, chain }: { kind: "in" | "out" | "stock"; chain: SourceChainKey }) {
  const name = CCTP_CHAINS[chain].name, mark = CHAIN_MARK[chain];
  const steps = kind === "stock" ? [
    { m: "ROBINHOOD", t: "Escrow on Robinhood", d: "NorenCrossChainEscrow locks your Stock Token and reads its Chainlink price" },
    { m: "CHAINLINK", t: "Chainlink CRE carries the order", d: "with the price round, to NorenCrossChainSettler on Arc" },
    { m: "1INCH", t: "Aqua maker settles on Arc", d: "its Chainlink-pegged strategy pays you USDC; CRE carries the fill back and the escrow releases the stock to the maker" },
  ] : kind === "out" ? [
    { m: "ARC", t: "Burn on Arc", d: "TokenMessengerV2.depositForBurn, fast finality" },
    { m: "CIRCLE", t: "Circle attests", d: "Iris signs the burn message" },
    { m: mark, t: `Mint on ${shortChain(chain)}`, d: `MessageTransmitterV2.receiveMessage on ${name}, sent from this browser` },
  ] : [
    { m: mark, t: `Burn on ${shortChain(chain)}`, d: "TokenMessengerV2 burns your USDC and names NorenArcHook as the only contract that may finish it on Arc" },
    { m: "CIRCLE", t: "Circle attests", d: "Iris signs the burn message" },
    { m: "ARC", t: "NorenArcHook mints on Arc", d: "it mints the USDC and runs the action: your wallet here; a private balance, an invoice or an Aqua order when a hook rides along" },
  ];
  return (
    <ol className="nk-path" aria-label="How it moves">
      {steps.map((s, i) => <li key={s.t}><span className="nk-path-n"><Mark id={s.m} size={26} /><i>{i + 1}</i></span><div><b>{s.t}</b><small>{s.d}</small></div></li>)}
    </ol>
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
