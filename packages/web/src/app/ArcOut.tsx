/**
 * Arc → Robinhood Chain: USDC out of Arc over Circle CCTP V2, from this browser's test key, on the public testnets.
 * Burn on Arc (TokenMessengerV2.depositForBurn) → Circle's attestation (Iris sandbox) → this browser mints on
 * Robinhood Chain testnet (MessageTransmitterV2.receiveMessage), which needs a little ETH there for gas.
 */
import { useMemo, useState } from "react";
import { createWalletClient, defineChain, http, type Hex } from "viem";
import { attestFromArc, burnFromArc, mintFromArc, CCTP_CHAINS, type SourceChainKey } from "@noren/cctp";
import { customerAccount } from "../onchain";
import { Copy, msgOf } from "../ui";
import { TxLink } from "../tx";
import { Mark } from "../logos";
import { fmt6, fmtGas, useSourceBalances } from "../cctp-flow";
import { Coin, Result, Spin, Track, shortHex } from "./kit";
import { parseAmount } from "./tokens";

const chainOf = (k: SourceChainKey | "arc-testnet") => {
  const c = CCTP_CHAINS[k];
  return defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: c.gas, symbol: c.gas, decimals: 18 }, rpcUrls: { default: { http: [c.rpcUrl] } } });
};

type Run = { started: number; amount: bigint; step: string; burnTx?: Hex; approveTx?: Hex; iris?: string; minted?: bigint; fee?: bigint; mintTx?: Hex; error?: string; seconds?: number };

export function ArcOut({ to = "robinhood-testnet" as SourceChainKey }: { to?: SourceChainKey }) {
  const me = useMemo(() => customerAccount(), []);
  const [amount, setAmount] = useState("0.5");
  const [tick, setTick] = useState(0);
  const arc = useSourceBalances("arc-testnet", me.address, tick);
  const dst = useSourceBalances(to, me.address, tick);
  const [run, setRun] = useState<Run | null>(null);
  const amt = useMemo(() => parseAmount(amount, 6), [amount]);
  const d = CCTP_CHAINS[to];
  const running = !!run && !run.mintTx && !run.error;
  // Arc's gas token is USDC (18-dp native view of the same balance): keep a little back for the approve and burn.
  const reserve = 20_000n;
  const missing = !arc.b || !dst.b ? null
    : amt && arc.b.usdc < amt + reserve ? `${fmt6(amt + reserve)} USDC on Arc testnet (amount + gas; this address holds ${fmt6(arc.b.usdc)})`
    : dst.b.gas === 0n ? `a little ${d.gas} on ${d.name} to pay the mint's gas`
    : null;

  const go = async () => {
    if (!amt) return;
    const started = Date.now();
    const put = (x: Partial<Run>) => setRun((r) => (r && r.started === started ? { ...r, ...x } : r));
    setRun({ started, amount: amt, step: "Approving USDC on Arc…" });
    try {
      const arcWallet = createWalletClient({ account: me, chain: chainOf("arc-testnet"), transport: http(CCTP_CHAINS["arc-testnet"].rpcUrl) });
      const b = await burnFromArc({ toChain: to, amount: amt, recipient: me.address, walletClient: arcWallet, fast: true,
        onStatus: (s) => { if (s.step === "approving") put({ approveTx: s.txHash, step: "Approving USDC on Arc…" }); else if (s.step === "burning") put({ step: "Burning on Arc…" }); else if (s.step === "burned") put({ burnTx: s.burnTxHash, step: "Burned. Asking Circle…" }); } });
      put({ burnTx: b.burnTxHash, step: "Circle is attesting…" });
      const a = await attestFromArc(to, b.burnTxHash, { pollMs: 3000, onStatus: (s) => { if (s.step === "attestation-pending") put({ iris: s.irisStatus, step: `Circle is attesting (${s.irisStatus})…` }); } });
      put({ minted: a.minted, fee: a.feeExecuted, iris: "complete", step: `Minting on ${d.name}…` });
      const dstWallet = createWalletClient({ account: me, chain: chainOf(to), transport: http(d.rpcUrl) });
      const m = await mintFromArc(to, a, dstWallet);
      put({ mintTx: m.mintTxHash, step: "Minted", seconds: (Date.now() - started) / 1000 });
    } catch (e) { put({ error: msgOf(e) }); }
    setTick((t) => t + 1);
  };

  return (
    <div className="nk-bare" aria-label={`Arc to ${d.name}`}>
      <div className="nk-box">
        <span className="nk-l"><span className="lg-row"><Mark id="ARC" size={16} />You send · Arc testnet</span><span>from {shortHex(me.address, 4)}</span></span>
        <div className="nk-row"><input inputMode="decimal" aria-label="USDC to send from Arc" placeholder="0" value={amount} disabled={running} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span className="nk-token" data-static="true"><Coin t={{ sym: "USDC" }} />USDC</span></div>
        <div className="nk-sub"><span>{arc.err ? <span className="nk-bad-t">{arc.err}</span> : "USDC is also Arc's gas"}</span><span>Balance {arc.b ? <button type="button" onClick={() => setAmount(String(Number(arc.b!.usdc > reserve ? arc.b!.usdc - reserve : 0n) / 1e6))}>{fmt6(arc.b.usdc)}</button> : "–"}</span></div>
      </div>
      <div className="nk-flip" aria-hidden style={{ cursor: "default" }}>↓</div>
      <div className="nk-box">
        <span className="nk-l"><span className="lg-row"><Mark id="ROBINHOOD" size={16} />You receive · {d.name}</span><span>to {shortHex(me.address, 4)}</span></span>
        <div className="nk-row"><output className={amt ? "" : "dim"}>{amt ? fmt6(run?.minted ?? amt) : "0"}</output><span className="nk-token" data-static="true"><Coin t={{ sym: "USDC" }} />USDC</span></div>
        <div className="nk-sub"><span>{dst.err ? <span className="nk-bad-t">{dst.err}</span> : dst.b ? `${fmtGas(dst.b.gas)} ${d.gas} for the mint's gas` : "reading…"}</span><span>{dst.b ? `${fmt6(dst.b.usdc)} there now` : ""}</span></div>
      </div>
      {missing && !running && (
        <div className="nk-setup" role="status"><span className="nk-tag">Setup required</span><b>Needs {missing}.</b><p>This is the test key kept in this browser. Fund it at <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a>, then <button type="button" className="nk-linkbtn" onClick={() => setTick((t) => t + 1)}>check again</button>.</p><p className="nk-addr"><code>{me.address}</code><Copy text={me.address} /></p></div>
      )}
      <button className="nk-cta" disabled={running || !amt || !!missing || !arc.b || !dst.b} onClick={go}>
        {running ? <><Spin /> {run!.step}</> : !amt ? "Enter an amount" : !arc.b || !dst.b ? "Reading balances…" : missing ? "Fund the test key first" : `Send ${fmt6(amt)} USDC to ${d.name.replace(/ Testnet$/, "")}`}
      </button>
      {run && (
        <Result tone={run.mintTx ? "good" : run.error ? "bad" : ""} tag={`Arc → ${d.name.replace(/ Testnet$/, "")} · CCTP V2`} link={run.mintTx ? <TxLink explorer={d.explorer} where={`${d.name} explorer`} hash={run.mintTx} n={6} /> : undefined}
          title={run.mintTx ? `${fmt6(run.minted ?? run.amount)} USDC landed on ${d.name}${run.seconds ? ` in ${run.seconds.toFixed(0)} s` : ""}` : run.error ? "Transfer stopped" : run.step}
          body={run.error}
          kv={[["Sent", `${fmt6(run.amount)} USDC`], ["Circle fee", run.fee !== undefined ? `${fmt6(run.fee, 6)} USDC` : "…"], ["Minted by", "this browser"]]}>
          <div style={{ marginTop: 16 }}>
            <Track steps={[
              { k: "Burn on Arc", on: !!run.burnTx, d: run.burnTx ? <TxLink chain="arc-live" hash={run.burnTx} n={4} /> : "" },
              { k: "Circle attests", on: run.iris === "complete", d: run.iris && run.iris !== "complete" ? run.iris : run.iris ? "Iris sandbox" : "" },
              { k: `Minted on ${d.name.replace(/ Chain Testnet$/, "")}`, on: !!run.mintTx, d: run.mintTx ? <TxLink explorer={d.explorer} hash={run.mintTx} n={4} /> : "" },
            ]} />
          </div>
        </Result>
      )}
    </div>
  );
}
