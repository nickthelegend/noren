import { useCallback, useEffect, useRef, useState } from "react";
import { jsonBigints, parseInvoice, type Invoice } from "@noren/core";
import { api, short, usdc, type InvoiceView } from "./api";
import type { Wallet } from "./wallet";
import { Icon, Logo, Setup, TxRef, msgOf, useConfig } from "./ui";

type Step = "idle" | "binding" | "proving" | "relaying" | "paid" | "error";

function useCountdown(expiry?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!expiry) return null;
  const left = Math.max(0, Number(expiry) * 1000 - now);
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  return { left, text: m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}:${String(s).padStart(2, "0")}` };
}

export function Checkout({ id }: { id: string }) {
  const { cfg, err } = useConfig();
  // The prover (snarkjs + Kohaku) loads only here, on the checkout page.
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [view, setView] = useState<InvoiceView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [bal, setBal] = useState<{ approved: bigint; pending: bigint } | null>(null);
  const [inbox, setInbox] = useState<{ approved: bigint; pending: bigint } | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [proofSec, setProofSec] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const started = useRef(0);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => { if (cfg) import("./wallet").then((m) => setWallet(m.makeWallet(cfg))).catch((e) => setNote(`Couldn't load the private wallet: ${msgOf(e)}`)); }, [cfg]);
  const load = useCallback(async () => {
    try { setView(await api.invoice(id)); setLoadErr(null); } catch (e) { setLoadErr(msgOf(e)); }
    if (wallet) { try { setBal(await wallet.balances()); setInbox(await wallet.refundInbox()); } catch (e) { setNote(msgOf(e)); } }
  }, [id, wallet]);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);
  const cd = useCountdown(view?.invoice.expiry);

  if (err) return <div className="co-page"><Setup err={err} /></div>;
  const shop = view?.merchantName || "Noren merchant";
  const amount = view ? BigInt(view.invoice.amount) : 0n;
  const enough = !!bal && bal.approved >= amount && amount > 0n;
  const expired = view?.status === "expired" || (cd !== null && cd.left === 0 && view?.status !== "paid" && view?.status !== "refunded");
  const settled = view?.status === "paid" || view?.status === "refunded";
  const working = step === "binding" || step === "proving" || step === "relaying";

  const getUsdc = async () => { if (!wallet) return; setBusy("faucet"); setNote(null); try { await api.faucet(wallet.address); await load(); } catch (e) { setNote(msgOf(e)); } finally { setBusy(null); } };
  const shield = async () => { if (!wallet) return; setBusy("shield"); setNote(null); try { await wallet.shield(20_000_000n); setNote("Shielded 20 USDC. The compliance check approves it in a few seconds."); await load(); } catch (e) { setNote(msgOf(e)); } finally { setBusy(null); } };
  const pay = async () => {
    if (!wallet || !view) return;
    setNote(null); started.current = performance.now();
    try {
      setStep("binding");
      const { nextPrecommitment } = await wallet.refundInbox();
      const opening = wallet.createReceipt();
      const bound = await api.bind(id, nextPrecommitment, opening.commitment);
      const invoice: Invoice = parseInvoice(bound.invoice);
      await wallet.rememberReceipt(invoice, opening);
      setStep("proving");
      const { withdrawal, proof, seconds } = await wallet.prove(invoice);
      setProofSec(seconds);
      setStep("relaying");
      const done = await api.pay(id, jsonBigints({ withdrawal, proof }));
      setTotal((performance.now() - started.current) / 1000);
      setView((v) => ({ ...v, ...done, merchantName: v?.merchantName ?? done.merchantName })); setStep("paid"); load();
    } catch (e) { setStep("error"); setNote(msgOf(e)); }
  };

  const steps: [Step, string, string][] = [
    ["binding", "Bind this invoice", "to your private refund inbox and a receipt"],
    ["proving", "Prove on this device", proofSec ? `done in ${proofSec.toFixed(2)} s` : "zero-knowledge; nothing leaves your browser"],
    ["relaying", `${shop} relays it`, "they pay the gas, you pay nothing extra"],
  ];
  const order: Step[] = ["binding", "proving", "relaying", "paid"];
  const at = order.indexOf(step);

  return (
    <div className="co-page">
      <div className="co">
        {/* --------------------------------------------------------------- summary */}
        <section className="co-sum">
          <div className="co-sum-in">
            <a className="co-shop" href="#/"><span className="co-shop-mark" aria-hidden>{shop.slice(0, 1).toUpperCase()}</span><span>{shop}</span></a>
            <span className="co-k">Pay {shop}</span>
            <b className="co-amt">{view ? usdc(view.invoice.amount) : <span className="skel-t" />}<em>USDC</em></b>
            <ul className="co-lines">
              <li><span>{view?.description || "Payment"}</span><span>{view ? usdc(view.invoice.amount) : "…"}</span></li>
              <li className="faint"><span>Network fee</span><span>paid by {shop}</span></li>
              <li className="tot"><span>Total due</span><span>{view ? `${usdc(view.invoice.amount)} USDC` : "…"}</span></li>
            </ul>
            <div className="co-privacy">
              <Icon.eyeOff />
              <p><b>{shop} sees the amount, never you.</b> You pay from a private balance, so your wallet address, balance and history stay yours.</p>
            </div>
          </div>
          <footer className="co-foot"><span>Powered by</span><a href="#/"><Logo size={16} /> Noren</a><span className="mono faint">{short(id, 6)}</span></footer>
        </section>

        {/* --------------------------------------------------------------- pay */}
        <section className="co-pay">
          {loadErr && !view ? (
            <div className="co-state"><Icon.x /><h2>This payment link doesn't work</h2><p>{loadErr}</p></div>
          ) : settled ? (
            <div className="co-done">
              <div className="co-check" aria-hidden><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" /><path d="m15 27 7.5 7.5L38 19" /></svg></div>
              <h2>{view?.status === "refunded" ? "Paid, then refunded" : "Paid privately"}</h2>
              <p>{usdc(view?.invoice.amount)} USDC to {shop}.{view?.status === "refunded" && ` ${usdc(view.refundAmount)} USDC came back to your private refund inbox.`}</p>
              <dl className="kv">
                {proofSec && <><dt>Proof made on this device</dt><dd>{proofSec.toFixed(2)} s</dd></>}
                {total && <><dt>Click to paid</dt><dd>{total.toFixed(1)} s</dd></>}
                <dt>Transaction</dt><dd><TxRef cfg={cfg} hash={view?.paymentTx} /></dd>
                <dt>Your address in it</dt><dd className="unk">none</dd>
                <dt>Refund inbox</dt><dd>{inbox ? `${usdc(inbox.approved + inbox.pending)} USDC` : "…"}</dd>
              </dl>
              <p className="faint sm">Your receipt opening is saved in this browser, so you can prove the purchase later if you need to.</p>
            </div>
          ) : expired ? (
            <div className="co-state"><Icon.clock /><h2>This link has expired</h2><p>Ask {shop} for a new one. Nothing was charged.</p></div>
          ) : (
            <>
              <div className="co-pay-h"><h2>Pay privately</h2>{cd && <span className="co-timer"><Icon.clock /> {cd.text}</span>}</div>
              <div className="co-bal">
                <div><span>Private balance</span><b>{bal ? usdc(bal.approved) : <span className="skel-t sm" />}<em>USDC</em></b>{bal && bal.pending > 0n && <small className="pend"><span className="spin xs" /> +{usdc(bal.pending)} being screened</small>}</div>
                <div><span>Refund inbox</span><b>{inbox ? usdc(inbox.approved + inbox.pending) : <span className="skel-t sm" />}<em>USDC</em></b></div>
              </div>

              {!enough && !working && bal && (
                <div className="co-fund">
                  <p><b>Add funds to your private balance.</b> Test network: get free test USDC, then shield it into the pool. A compliance check clears it in a few seconds.</p>
                  <div className="row2">
                    <button className="btn line" disabled={!!busy} onClick={getUsdc}>{busy === "faucet" ? <><span className="spin" /> Sending…</> : <><span className="n">1</span> Get test USDC</>}</button>
                    <button className="btn line" disabled={!!busy} onClick={shield}>{busy === "shield" ? <><span className="spin" /> Shielding…</> : <><span className="n">2</span> Shield 20 USDC</>}</button>
                  </div>
                </div>
              )}

              <ol className="co-steps">
                {steps.map(([k, t, d], i) => <li key={k} data-state={at > i || step === "paid" ? "done" : at === i ? "now" : "todo"}><i>{at > i ? <Icon.check /> : at === i ? <span className="spin xs" /> : i + 1}</i><div><b>{t}</b><span>{d}</span></div></li>)}
              </ol>

              {note && <p className={step === "error" ? "err" : "note"} role="status">{note}</p>}
              <button className="btn ink full xl" disabled={!wallet || !enough || working || (view?.status !== "open" && view?.status !== "draft")} onClick={pay}>
                {working ? <><span className="spin" /> {step === "proving" ? "Proving on this device…" : step === "binding" ? "Binding invoice…" : `${shop} is relaying…`}</> : <><Icon.lock /> Pay {view ? usdc(view.invoice.amount) : ""} USDC</>}
              </button>
              <p className="faint sm center">Test network wallet, kept in this browser. Your keys and proof inputs never leave it.</p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
