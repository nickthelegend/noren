/**
 * Bring USDC to Arc: Circle CCTP V2 from any of the 10 testnets linked to Arc, through NorenArcHook. Public testnets
 * only (no fork): the burn, Circle's attestation and the mint on Arc are real transactions with explorer links.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { maxFeeFor, type RelayMode } from "@noren/cctp";
import type { Wallet } from "./NorenApp";
import { Band, Coin, Result, Spin, Track, pop, shortHex } from "./kit";
import { parseAmount } from "./tokens";
import { TxLink } from "../tx";
import { Copy } from "../ui";
import { Mark } from "../logos";
import { CCTP_CHAINS, CCTP_RUNS, CHAIN_MARK, runLabel, SOURCE_CHAINS, shortChain, type CctpChainKey, type SourceChainKey } from "../crosschain";
import { fmt6, fmtGas, useCctpFlow, useFastFee, useSourceBalances, type Flow } from "../cctp-flow";

export function CctpCard({ w, from0 = "base-sepolia", lock, exclude, title = "Bring USDC to Arc", sub = "From 10 chains, burned and minted by Circle. No wrapped tokens.", bare }: { w: Wallet; from0?: SourceChainKey; lock?: boolean; exclude?: SourceChainKey[]; title?: string; sub?: string; bare?: boolean }) {
  const [from, setFrom] = useState<SourceChainKey>(from0);
  const [amount, setAmount] = useState("1");
  const [fast, setFast] = useState(true);
  const [relay, setRelay] = useState<RelayMode | null>(null);
  const [picking, setPicking] = useState(false);
  const [tick, setTick] = useState(0);
  const who = w.oc.address;
  const src = CCTP_CHAINS[from];
  const { b, err } = useSourceBalances(from, who, tick);
  const arc = useSourceBalances("arc-testnet", who, tick);
  const bps = useFastFee(from);
  const amt = useMemo(() => parseAmount(amount, 6), [amount]);
  const fee = amt && fast && bps ? maxFeeFor(amt, bps) : 0n;
  const { flow, run, reset } = useCctpFlow();
  const running = flow?.phase === "running";
  // Finish it myself only when this key can pay Arc gas (USDC is Arc's gas token); otherwise wait for the CRE relay.
  const mode: RelayMode = relay ?? (arc.b && arc.b.gas > 0n ? "self" : "cre");
  useEffect(() => { if (flow?.phase === "done") { setTick((t) => t + 1); setAmount(""); } }, [flow?.phase]);

  const missing = !b ? null
    : b.gas === 0n ? `${src.name} gas (${src.gas}) for ${shortHex(who, 4)}`
    : amt && b.usdc < amt ? `${fmt6(amt)} USDC on ${src.name} (this address holds ${fmt6(b.usdc)})`
    : mode === "self" && arc.b && arc.b.gas === 0n ? "a little USDC on Arc testnet to pay the mint's gas, or let the Chainlink CRE relay finish it"
    : null;

  const go = () => amt && run({ from, amount: amt, recipient: who, fast, relay: mode });

  return (
    <section className={bare ? "nk-bare" : "nk-card"} aria-label={title}>
      {!bare && <div className="nk-card-h"><div><b>{title}</b><p>{sub}</p></div><span className="nk-pill live"><Mark id="CIRCLE" size={16} />CCTP V2 · testnets</span></div>}
      <div className="nk-box">
        <span className="nk-l"><span>You send</span><button type="button" className="nk-chainbtn" onClick={() => setPicking(true)} disabled={running || lock} aria-label={`Source chain: ${src.name}. Change`}><Mark id={CHAIN_MARK[from]} size={18} />{src.name}<Caret /></button></span>
        <div className="nk-row"><input inputMode="decimal" aria-label="USDC to bring to Arc" placeholder="0" value={amount} disabled={running} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span className="nk-token" data-static="true"><Coin t={{ sym: "USDC" }} />USDC</span></div>
        <div className="nk-sub"><span>{err ? <span className="nk-bad-t">{err}</span> : b ? `${fmtGas(b.gas)} ${src.gas} for gas` : "reading balances…"}</span><span>Balance {b ? <button type="button" onClick={() => setAmount(String(Number(b.usdc) / 1e6))}>{fmt6(b.usdc)}</button> : "–"}</span></div>
      </div>
      <div className="nk-flip" aria-hidden style={{ cursor: "default" }}>↓</div>
      <div className="nk-box">
        <span className="nk-l"><span>You receive · <span className="lg-row" style={{ display: "inline-flex" }}><Mark id="ARC" size={14} />Arc testnet</span></span><span>to {shortHex(who, 4)}</span></span>
        <div className="nk-row"><output className={amt ? "" : "dim"}>{amt ? fmt6(amt - fee) : "0"}</output><span className="nk-token" data-static="true"><Coin t={{ sym: "USDC" }} />USDC</span></div>
        <div className="nk-sub"><span>{fast ? (bps === null ? "Fast transfer · reading Circle's fee…" : bps === 0 ? "Fast transfer · no fee on this route" : `at least · Circle's fast fee is ${bps} bps (max ${fmt6(fee, 6)} USDC)`) : "Standard transfer · no fee, waits for hard finality"}</span><span>{arc.b ? `${fmt6(arc.b.usdc)} on Arc now` : ""}</span></div>
      </div>
      <Band label="Speed" value={fast ? "fast" : "std"} options={["fast", "std"]} onChange={(v) => setFast(v === "fast")} fmt={(v) => (v === "fast" ? "Fast" : "Standard")} />
      <Band label="Finished on Arc by" value={mode} options={["cre", "self"]} onChange={setRelay} fmt={(v) => (v === "cre" ? "Chainlink CRE" : "This browser")} />
      {missing && !running && (
        <div className="nk-setup" role="status"><span className="nk-tag">Setup required</span><b>Needs {missing}.</b><p>This is a test key kept in this browser. Fund it on {src.name} at <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a> (USDC) and the chain's gas faucet, then <button type="button" className="nk-linkbtn" onClick={() => setTick((t) => t + 1)}>check again</button>.</p><p className="nk-addr"><code>{who}</code><Copy text={who} /></p></div>
      )}
      <button className="nk-cta" disabled={running || !amt || !!missing || !b} onClick={go}>
        {running ? <><Spin /> {stepText(flow!)}</> : !amt ? "Enter an amount" : !b && !err ? "Reading balances…" : missing ? "Fund the test key first" : `Bring ${fmt6(amt)} USDC from ${shortChain(from)}`}
      </button>
      <p className="nk-fine">Public testnets, real transactions. Every Noren burn names NorenArcHook as the only contract allowed to finish it on Arc. The Chainlink CRE relay watches all 10 chains, fetches Circle's attestation with DON consensus and writes it to Arc; it runs with <code>cre workflow simulate --broadcast</code> today, not on a deployed DON, so choose “This browser” to finish the mint yourself when no relay is running.</p>

      <AnimatePresence initial={false}>{flow && <FlowCard key={flow.startedAt} f={flow} onClose={flow.phase === "running" ? undefined : reset} />}</AnimatePresence>
      <AnimatePresence>{picking && <ChainSheet current={from} exclude={exclude} onClose={() => setPicking(false)} onPick={(k) => { setFrom(k); setPicking(false); }} />}</AnimatePresence>
    </section>
  );
}

const stepText = (f: Flow) => ({ approving: "Approving USDC…", burning: `Burning on ${shortChain(f.from)}…`, burned: "Burned. Asking Circle…", "attestation-pending": `Circle is attesting${f.iris ? ` (${f.iris})` : ""}…`, "attestation-ready": "Attested. Minting on Arc…", minting: f.via === "cre" ? "Waiting for the Chainlink CRE relay…" : "Minting on Arc…", minted: "Minted on Arc" } as Record<string, string>)[f.now ?? ""] ?? "Starting…";

/** The live status steps of one transfer, with explorer links on both chains. */
export function FlowCard({ f, onClose, title }: { f: Flow; onClose?: () => void; title?: string }) {
  const src = CCTP_CHAINS[f.from];
  const at = (s: string) => ["approving", "burning", "burned", "attestation-pending", "attestation-ready", "minting", "minted"].indexOf(s);
  const n = at(f.now ?? "");
  return (
    <Result tone={f.phase === "done" ? "good" : f.phase === "error" ? "bad" : ""} tag={`${shortChain(f.from)} → Arc · CCTP V2`}
      link={f.mintTx ? <TxLink chain="arc-live" hash={f.mintTx} n={6} /> : onClose ? <button type="button" className="nk-x sm" onClick={onClose} aria-label="Dismiss">×</button> : undefined}
      title={f.phase === "done" ? `${fmt6(f.minted ?? f.amount)} USDC landed on Arc${f.seconds ? ` in ${f.seconds.toFixed(0)} s` : ""}` : f.phase === "error" ? "Transfer stopped" : title ?? stepText(f)}
      body={f.error}
      kv={[["Sent", `${fmt6(f.amount)} USDC`], ["Circle fee", f.fee !== undefined ? `${fmt6(f.fee, 6)} USDC` : "…"], ["Finished by", f.via === "cre" ? "Chainlink CRE" : f.via === "self" ? "this browser" : f.via ?? "…"]]}>
      <div style={{ marginTop: 16 }}>
        <Track steps={[
          { k: `Burn on ${shortChain(f.from)}`, on: !!f.burnTx, d: f.burnTx ? <TxLink explorer={src.explorer} where={`${src.name} explorer`} hash={f.burnTx} n={4} /> : f.approveTx ? <TxLink explorer={src.explorer} hash={f.approveTx} n={4}>approve</TxLink> : "" },
          { k: "Circle attests", on: n >= at("attestation-ready"), d: f.iris && f.iris !== "complete" ? f.iris : n >= at("attestation-ready") ? "Iris sandbox" : "" },
          { k: "Minted on Arc", on: !!f.mintTx, d: f.mintTx ? <TxLink chain="arc-live" hash={f.mintTx} n={4} /> : n === at("minting") && f.via === "cre" ? "waiting for the relay" : "" },
        ]} />
      </div>
    </Result>
  );
}

const Caret = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>;

export function ChainSheet({ current, onClose, onPick, exclude }: { current: CctpChainKey; onClose: () => void; onPick: (k: SourceChainKey) => void; exclude?: SourceChainKey[] }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return (
    <motion.div className="nk-modal" role="dialog" aria-modal="true" aria-label="Choose the source chain" onMouseDown={(e) => e.target === e.currentTarget && onClose()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="nk-sheet" {...pop}>
        <div className="nk-sheet-h"><b>Bring USDC from</b><button className="nk-x" onClick={onClose} aria-label="Close">×</button></div>
        <ul className="nk-list" role="listbox" aria-label="CCTP source chains">
          {SOURCE_CHAINS.filter((c) => !exclude?.includes(c.key)).map((c, i) => (
            <li key={c.key}>
              <button ref={i === 0 ? first : undefined} role="option" aria-selected={c.key === current} onClick={() => onPick(c.key)}>
                <Mark id={CHAIN_MARK[c.key]} size={36} />
                <span><b>{c.name}</b><small>CCTP domain {c.domain} · chain {c.chainId}</small></span>
                <span className="r"><small>gas {c.gas}</small></span>
              </button>
            </li>
          ))}
        </ul>
      </motion.div>
    </motion.div>
  );
}

/** The CCTP transfers Noren already ran on public testnets, both legs linked. */
export function RecentCctp({ all }: { all?: boolean }) {
  const runs = CCTP_RUNS.filter((r) => all || r.to === "arc-testnet");
  return (
    <section className="nk-card" aria-label="Recent live transfers into Arc">
      <div className="nk-card-h"><div><b>Already done on testnets</b><p>Real CCTP V2 transfers{all ? ", both directions" : " into Arc"}, with both legs linked.</p></div></div>
      <ul className="nk-runs">
        {runs.map((r) => (
          <li key={r.burnTx}>
            <Mark id={CHAIN_MARK[r.from]} size={28} />
            <div><b>{shortChain(r.from)} → {shortChain(r.to)} · {fmt6(r.minted)} USDC</b><small>{runLabel(r)}</small></div>
            <div className="r"><TxLink explorer={CCTP_CHAINS[r.from].explorer} hash={r.burnTx} n={4}>burn</TxLink><TxLink explorer={CCTP_CHAINS[r.to].explorer} hash={r.mintTx} n={4}>mint</TxLink></div>
          </li>
        ))}
      </ul>
    </section>
  );
}
