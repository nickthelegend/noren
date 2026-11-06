/**
 * Hosted checkout, "Pay from another chain": Circle CCTP V2 with a PAY_INVOICE hook. USDC is burned on the customer's
 * chain (any of 10 testnets) and minted on Arc testnet to NorenArcHook, which hands it to NorenArcActionRouter; the
 * router pays the merchant and emits InvoicePaid(invoiceId). Public testnets, real transactions; not private.
 */
import { HOSTED } from "./network";
import { useMemo, useState } from "react";
import { maxFeeFor, type RelayMode } from "@noren/cctp";
import { short, usdc, type InvoiceView } from "./api";
import { Copy, Icon } from "./ui";
import { TxLink } from "./tx";
import { Mark } from "./logos";
import { customerAccount } from "./onchain";
import { CCTP_CHAINS, CHAIN_MARK, SOURCE_CHAINS, shortChain, type SourceChainKey } from "./crosschain";
import { fmt6, fmtGas, grossFor, useCctpFlow, useFastFee, useSourceBalances } from "./cctp-flow";

export function CctpPay({ view, shop }: { view: InvoiceView; shop: string }) {
  const who = useMemo(() => customerAccount().address, []);
  const [from, setFrom] = useState<SourceChainKey>("base-sepolia");
  const [tick, setTick] = useState(0);
  const [mine, setMine] = useState<boolean | null>(null);
  const src = CCTP_CHAINS[from];
  const { b, err } = useSourceBalances(from, who, tick);
  const arc = useSourceBalances("arc-testnet", who, tick);
  const bps = useFastFee(from);
  const net = BigInt(view.invoice.amount);
  const gross = grossFor(net, bps, true);
  const { flow, run } = useCctpFlow();
  const relay: RelayMode = (mine ?? (arc.b ? arc.b.gas > 0n : false)) ? "self" : "cre";
  const running = flow?.phase === "running";
  const missing = !b ? null : b.gas === 0n ? `${src.gas} for gas on ${src.name}` : b.usdc < gross ? `${fmt6(gross)} USDC on ${src.name} (you hold ${fmt6(b.usdc)})` : relay === "self" && arc.b?.gas === 0n ? "USDC on Arc testnet for the mint's gas" : null;
  const pay = () => run({ from, amount: gross, recipient: who, fast: true, relay, action: { kind: "pay-invoice", merchant: view.invoice.merchant, invoiceId: view.invoice.invoiceId } });

  const st = flow?.now ?? "";
  const order = ["burned", "attestation-ready", "minted"];
  const done = (k: string) => flow && (flow.phase === "done" || order.indexOf(st) >= order.indexOf(k));
  const steps: [string, string, React.ReactNode][] = [
    ["burned", `Burn on ${src.name}`, flow?.burnTx ? <TxLink explorer={src.explorer} where={`${src.name} explorer`} hash={flow.burnTx} n={6} /> : "Circle's TokenMessengerV2, with the invoice as hook data"],
    ["attestation-ready", "Circle attests", flow?.iris && flow.iris !== "complete" ? `Iris: ${flow.iris}` : "Iris sandbox, usually 5–30 s on a fast transfer"],
    ["minted", `${shop} is paid on Arc`, flow?.mintTx ? <TxLink chain="arc-live" hash={flow.mintTx} n={6} /> : relay === "cre" ? "Chainlink CRE relay → NorenArcHook → router" : "this browser relays → NorenArcHook → router"],
  ];

  return (
    <div className="co-credit">
      <label className="co-from">
        <span>Pay from</span>
        <span className="co-select"><Mark id={CHAIN_MARK[from]} size={20} />
          <select value={from} disabled={running} onChange={(e) => setFrom(e.target.value as SourceChainKey)} aria-label="Source chain">
            {SOURCE_CHAINS.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
          </select><Icon.chevron />
        </span>
      </label>
      <div className="co-bal">
        <div><span>Your USDC on {shortChain(from)}</span><b>{b ? fmt6(b.usdc) : err ? "–" : <span className="skel-t sm" />}<em className="lg-row"><Mark id="USDC" size={16} />USDC</em></b><small className="faint">{b ? `${fmtGas(b.gas)} ${src.gas} for gas` : err ?? "reading…"}</small></div>
        <div><span>You send</span><b>{fmt6(gross)}<em>USDC</em></b><small className="faint">{bps === null ? "reading Circle's fee…" : bps === 0 ? "no fast fee on this route" : `${shop} gets ${usdc(view.invoice.amount)}; fast fee ≤ ${fmt6(maxFeeFor(gross, bps), 6)}`}</small></div>
      </div>
      {missing && !running && (
        <div className="co-fund">
          <p><b>Needs {missing}.</b> This test key lives in this browser. Get USDC at <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a> and gas from the chain's faucet, then check again.</p>
          <p className="mono sm co-addr">{who}<Copy text={who} /></p>
          <button className="btn line" onClick={() => setTick((t) => t + 1)}>Check again</button>
        </div>
      )}
      <label className="co-check-row"><input type="checkbox" checked={relay === "self"} disabled={running} onChange={(e) => setMine(e.target.checked)} /> <span>Finish the mint on Arc from this browser (needs a little Arc testnet USDC for gas). Otherwise Noren's Chainlink CRE relay finishes it.</span></label>
      <div className="co-privacy light">
        <Icon.card />
        <p><b>Not private, on public testnets.</b> Your address on {src.name} is in the burn. The invoice is paid on <b>Arc testnet</b> by NorenArcActionRouter (event InvoicePaid){HOSTED ? ". Noren Merchant lists it under cross-chain payments." : "; this page's invoice lives on the Arc testnet fork, so it won't flip to “Paid” here. Noren Merchant lists it under cross-chain payments."}</p>
      </div>
      {flow && (
        <ol className="co-steps">
          {steps.map(([k, t, d], i) => <li key={k} data-state={done(k) ? "done" : flow.phase === "running" && (i === 0 ? !done("burned") : done(order[i - 1])) ? "now" : "todo"}><i>{done(k) ? <Icon.check /> : i + 1}</i><div><b>{t}</b><span>{d}</span></div></li>)}
        </ol>
      )}
      {flow?.phase === "error" && <p className="err" role="alert">{flow.error}</p>}
      {flow?.phase === "done" && <p className="note" role="status">{shop} was paid {fmt6(flow.minted ?? gross)} USDC on Arc testnet{flow.seconds ? ` in ${flow.seconds.toFixed(0)} s` : ""}, from {src.name}. Invoice {short(view.invoice.invoiceId, 6)}.</p>}
      <button className="btn ink full xl" disabled={running || !b || !!missing || flow?.phase === "done"} onClick={pay}>
        {running ? <><span className="spin" /> {st === "attestation-pending" ? "Circle is attesting…" : st === "minting" ? (relay === "cre" ? "Waiting for the CRE relay…" : "Paying on Arc…") : `Burning on ${shortChain(from)}…`}</> : flow?.phase === "done" ? "Paid on Arc" : missing ? "Fund the test key first" : <><Mark id="CIRCLE" size={20} /> Pay {fmt6(gross)} USDC from {shortChain(from)}</>}
      </button>
      <p className="faint sm center">Circle CCTP V2 burn on {src.name}, mint and payment on Arc testnet, signed by your test key in this browser.</p>
    </div>
  );
}
