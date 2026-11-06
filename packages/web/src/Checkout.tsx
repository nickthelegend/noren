import { useCallback, useEffect, useRef, useState } from "react";
import { jsonBigints, parseInvoice, type Invoice } from "@noren/core";
import { api, short, usdc, type InvoiceView } from "./api";
import type { Wallet } from "./wallet";
import { Icon, Logo, Setup, msgOf, useConfig } from "./ui";
import { CreditPay } from "./CreditPay";
import { CreditPrivatePay } from "./CreditPrivatePay";
import { StockPay } from "./StockPay";
import { UsdcPay } from "./UsdcPay";
import { CctpPay } from "./CctpPay";
import { LiveArc, NetSwitch } from "./LiveArc";
import { useNet } from "./network";
import { TxLink } from "./tx";
import { Mark } from "./logos";
import { assetSym } from "./onchain";
import { restoreBrowserWallet } from "./signer";

const stockSym = (a?: string) => assetSym(a);

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
  // The checkout signs with the same active wallet as the app: restore an injected browser wallet chosen there.
  useEffect(() => { restoreBrowserWallet().catch(() => {}); }, []);
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
  const [crowd, setCrowd] = useState<{ deposits: number; depositors: number } | null>(null);
  // Private by default: every other method is a public payment and says so.
  // The Noren app hands off with ?m=usdc|stocks|later so the shop checkout and the app share the same four ways.
  const [method, setMethod] = useState<"usdc" | "private" | "credit-private" | "stocks" | "credit" | "xchain">(() => {
    const m = new URLSearchParams(location.hash.split("?")[1] ?? "").get("m");
    return m === "usdc" ? "usdc" : m === "stocks" ? "stocks" : m === "later" ? "credit-private" : m === "xchain" ? "xchain" : "private";
  });
  const [more, setMore] = useState(method === "xchain");
  const later = method === "credit" || method === "credit-private";
  // Set when "Pay later, privately" drew on a credit line for this payment (the merchant still sees a private payment).
  const [drawnOnCredit, setDrawnOnCredit] = useState<{ lineId: string; tx: string; amount: bigint } | null>(null);
  const [net] = useNet();

  useEffect(() => { if (cfg) import("./wallet").then((m) => setWallet(m.makeWallet(cfg))).catch((e) => setNote(`Couldn't load the private wallet: ${msgOf(e)}`)); }, [cfg]);
  const load = useCallback(async () => {
    try { setView(await api.invoice(id)); setLoadErr(null); } catch (e) { setLoadErr(msgOf(e)); }
    if (wallet) { try { setBal(await wallet.balances()); setInbox(await wallet.refundInbox()); } catch (e) { setNote(msgOf(e)); } wallet.anonymitySet().then(setCrowd).catch(() => setCrowd(null)); }
  }, [id, wallet]);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);
  const cd = useCountdown(view?.invoice.expiry);
  const successUrl = typeof view?.successUrl === "string" ? view.successUrl : null;
  const cancelUrl = typeof view?.cancelUrl === "string" ? view.cancelUrl : null;
  const orderId = (view?.metadata as Record<string, string> | undefined)?.orderId;
  const back = (base: string) => { try { const u = new URL(base); if (u.protocol !== "http:" && u.protocol !== "https:") return null; u.searchParams.set("noren_invoice", id); if (orderId) u.searchParams.set("order_id", orderId); return u.toString(); } catch { return null; } };
  const doneUrl = successUrl ? back(successUrl) : null;
  const [leaving, setLeaving] = useState<number | null>(null);
  useEffect(() => {
    if (!doneUrl || (view?.status !== "paid")) return;
    setLeaving(5);
    const t = setInterval(() => setLeaving((n) => { if (n === null) return n; if (n <= 1) { clearInterval(t); location.assign(doneUrl); return 0; } return n - 1; }), 1000);
    return () => clearInterval(t);
  }, [doneUrl, view?.status]);

  if (err) return <div className="co-page"><Setup err={err} /></div>;
  const shop = view?.merchantName || "Noren merchant";
  const quote = (view as { quote?: { currency: string; fiatAmount: string; rate: string } } | null)?.quote;
  const fiat = (q: { currency: string; fiatAmount: string }) => { const d = q.currency === "JPY" || q.currency === "KRW" ? 0 : 2; return (Number(q.fiatAmount) / 10 ** d).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); };
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
            {quote ? (
              <>
                <b className="co-amt">{fiat(quote)}<em>{quote.currency}</em></b>
                <span className="co-conv"><span className="co-cl lg-row"><Mark id="CHAINLINK" size={14} />Chainlink</span> {usdc(view?.invoice.amount)} USDC at 1 {quote.currency} = {Number(quote.rate).toFixed(4)} USDC</span>
              </>
            ) : <b className="co-amt">{view ? usdc(view.invoice.amount) : <span className="skel-t" />}<em className="lg-row"><Mark id="USDC" size={20} />USDC</em></b>}
            <ul className="co-lines">
              <li><span>{view?.description || "Payment"}</span><span>{view ? usdc(view.invoice.amount) : "…"}</span></li>
              <li className="faint"><span>Network fee</span><span>paid by {shop}</span></li>
              {quote && <li className="faint"><span>Price</span><span>{fiat(quote)} {quote.currency}</span></li>}
              <li className="tot"><span>Total due</span><span>{view ? `${usdc(view.invoice.amount)} USDC` : "…"}</span></li>
            </ul>
            <div className="co-privacy">
              <Icon.eyeOff />
              {method === "private" ? <p><b>{shop} sees the amount, never you.</b> You pay from a private balance, so your wallet address, balance and history stay yours.</p>
                : method === "credit-private" ? <p><b>{shop} sees the amount, never you.</b> Your credit line tops up your private balance; {shop} never learns who paid. Your lender still knows you.</p>
                : <p><b>Only “Pay privately” hides you.</b> {method === "usdc" ? "A USDC payment comes from your Arc wallet" : method === "stocks" ? "Paying with stocks or crypto comes from your Robinhood wallet" : method === "xchain" ? "Paying from another chain comes from your wallet there" : "Paying later comes from your credit line"}, so {shop} and the chain can link it to you.</p>}
            </div>
          </div>
          <footer className="co-foot"><span>Powered by</span><a href="#/"><Logo size={16} /> Noren</a><span className="mono faint">{short(id, 6)}</span></footer>
        </section>

        {/* --------------------------------------------------------------- pay */}
        <section className="co-pay">
          <div className="co-net"><NetSwitch /></div>
          {net === "live" ? <LiveArc context="checkout" /> : loadErr && !view ? (
            <div className="co-state"><Icon.x /><h2>This payment link doesn't work</h2><p>{loadErr}</p></div>
          ) : settled ? (
            <div className="co-done">
              <div className="co-check" aria-hidden><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" /><path d="m15 27 7.5 7.5L38 19" /></svg></div>
              <h2>{view?.status === "refunded" ? <>Paid, then <em>refunded</em></> : view?.method === "credit" ? <>Paid on <em>credit</em></> : drawnOnCredit && view?.method !== "stocks" && view?.method !== "usdc" ? <>Paid <em>later</em>, privately</> : view?.method === "stocks" ? <>Paid with <em>{view.stock?.asset?.toLowerCase() === "0x0bd7d308f8e1639fab988df18a8011f41eacad73" ? "ETH" : "stocks"}</em></> : view?.method === "usdc" ? <>Paid with <em>USDC</em></> : <>Paid <em>privately</em></>}</h2>
              <p>{usdc(view?.invoice.amount)} USDC to {shop}.{view?.status === "refunded" && ` ${usdc(view.refundAmount)} USDC came back to your private refund inbox.`}</p>
              <dl className="kv">
                {proofSec && <><dt>Proof made on this device</dt><dd>{proofSec.toFixed(2)} s</dd></>}
                {total && <><dt>Click to paid</dt><dd>{total.toFixed(1)} s</dd></>}
                <dt>Transaction</dt><dd><TxLink chain={view?.method === "stocks" ? "robinhood" : "arc"} cfg={cfg} hash={view?.paymentTx} n={8} /></dd>
                {view?.method === "stocks" && view.stock ? <>
                  <dt>You paid</dt><dd className="lg-row">{stockSym(view.stock.asset) && <Mark id={stockSym(view.stock.asset)!} size={16} />}{(Number(view.stock.assetIn) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 6 })} {stockSym(view.stock.asset) ?? "units"} at ${(Number(view.stock.priceUsd8) / 1e8).toFixed(2)}</dd>
                  <dt>Private</dt><dd>no: paid from your Robinhood wallet</dd>
                </> : view?.method === "usdc" ? <>
                  <dt>Paid from</dt><dd>your wallet on Arc</dd>
                  <dt>Private</dt><dd>no: a direct USDC transfer</dd>
                </> : view?.method === "credit" ? <>
                  <dt>Paid from</dt><dd>Credit line <span className="mono">{short(view.creditLineId, 4)}</span></dd>
                  <dt>Private</dt><dd>no: the line is tied to your Robinhood wallet</dd>
                </> : <>
                  <dt>Your address in it</dt><dd className="unk">none</dd>
                  {drawnOnCredit && <><dt>Paid from</dt><dd>private balance, topped up by line <span className="mono">{short(drawnOnCredit.lineId, 4)}</span></dd>
                  <dt>Credit draw</dt><dd><TxLink chain="arc" cfg={cfg} hash={drawnOnCredit.tx} n={8} /> <span className="faint">(public)</span></dd></>}
                  <dt>Refund inbox</dt><dd>{inbox ? `${usdc(inbox.approved + inbox.pending)} USDC` : "…"}</dd>
                </>}
              </dl>
              {doneUrl && view?.status === "paid" && <a className="btn ink full lg" href={doneUrl}>Return to {shop}{leaving ? ` (${leaving})` : ""} <Icon.arrow /></a>}
              {view?.method === "stocks" ? <p className="faint sm">{shop} received USDG on Robinhood Chain{view.stock?.route === "aqua-maker" ? " from a 1inch Aqua maker, which now holds your shares" : view.stock?.route === "vault" ? " from Noren's stock vault, which now holds your shares" : ""}.</p> : view?.method === "credit" ? <p className="faint sm">{shop} was paid in full from the Arc credit pool, out of your credit limit. Your repayment plan is in the <a href="#/app/credit">Noren app</a>.</p> : view?.method === "usdc" ? <p className="faint sm">A direct transfer on Arc, verified on-chain by {shop}'s Noren server.</p> : drawnOnCredit ? <p className="faint sm">{shop} was paid from the privacy pool and sees “Customer: Private”. Your lender sees a draw into the privacy pool, not which merchant it paid. Repay in the <a href="#/app/credit">Noren app</a>; repayments are public.</p> : <p className="faint sm">Your receipt opening is saved in this browser, so you can prove the purchase later if you need to.</p>}
            </div>
          ) : expired ? (
            <div className="co-state"><Icon.clock /><h2>This link has expired</h2><p>Ask {shop} for a new one. Nothing was charged.</p></div>
          ) : (
            <>
              <div className="co-pay-h"><h2>{method === "credit" ? <>Pay <em>later</em></> : method === "credit-private" ? <>Pay <em>later</em>, privately</> : method === "stocks" ? <>Pay with <em>stocks or crypto</em></> : method === "usdc" ? <>Pay with <em>USDC</em></> : method === "xchain" ? <>Pay from <em>another chain</em></> : <>Pay <em>privately</em></>}</h2>{cd && <span className="co-timer"><Icon.clock /> {cd.text}</span>}</div>
              {cancelUrl && back(cancelUrl) && <a className="co-cancel" href={back(cancelUrl)!}><Icon.back /> Back to {shop}</a>}
              <div className="co-methods four" role="tablist" aria-label="Payment method">
                <button role="tab" aria-selected={method === "private"} disabled={working} onClick={() => setMethod("private")}><Mark id="KOHAKU" size={20} /><span><b>Pay privately</b><small>Default · USDC from your private balance; {shop} never learns who paid</small></span></button>
                <button role="tab" aria-selected={method === "usdc"} disabled={working} onClick={() => setMethod("usdc")}><Mark id="USDC" size={20} /><span><b>Pay with USDC</b><small>Public · your wallet on Arc</small></span></button>
                <button role="tab" aria-selected={method === "stocks"} disabled={working} onClick={() => setMethod("stocks")}><span className="co-stack" aria-hidden><Mark id="NVDA" size={20} /><Mark id="TSLA" size={20} /><Mark id="ETH" size={20} /></span><span><b>Pay with stocks or crypto</b><small>Public · any Stock Token or ETH, sold to the best price</small></span></button>
                <button role="tab" aria-selected={later} disabled={working} onClick={() => setMethod("credit-private")}><Icon.layers /><span><b>Pay in 3 / Pay later, privately</b><small>Your credit line · private by default</small></span></button>
              </div>
              {later && (
                <div className="co-sub" role="radiogroup" aria-label="Pay later">
                  <button role="radio" aria-checked={method === "credit-private"} disabled={working} onClick={() => setMethod("credit-private")}><Icon.eyeOff /> Pay later, privately</button>
                  <button role="radio" aria-checked={method === "credit"} disabled={working} onClick={() => setMethod("credit")}><Icon.layers /> Pay in 3 · public</button>
                </div>
              )}
              <div className={`co-more ${more ? "open" : ""}`}>
                <button type="button" className="co-more-t" aria-expanded={more} onClick={() => setMore((o) => !o)}><Mark id="CIRCLE" size={18} /><span>Pay from another chain</span><small>Public · USDC from 10 chains over Circle CCTP</small><i aria-hidden>{more ? "−" : "+"}</i></button>
                {more && <button role="tab" className="co-more-go" aria-selected={method === "xchain"} disabled={working} onClick={() => setMethod("xchain")}>{method === "xchain" ? "Selected" : "Use this"}</button>}
              </div>
              {method !== "private" && method !== "credit-private" && method !== "xchain" && (
                <div className="co-fund" role="note" aria-label="Public payment">
                  <p><b>This is a public payment.</b> {method === "usdc" ? "It comes straight from your Arc wallet (or from your wallet on another chain, if you bridge)" : method === "stocks" ? "It comes from your Robinhood Chain wallet" : "It draws on a credit line tied to your Robinhood Chain wallet"}, so {shop} and anyone reading the chain can link it to you.</p>
                  <div className="row2">{method === "credit" ? <button className="btn line" disabled={working} onClick={() => setMethod("credit-private")}><Icon.eyeOff /> Make it private: pay later, privately</button> : <button className="btn line" disabled={working} onClick={() => setMethod("private")}><Icon.eyeOff /> Make it private: shield first</button>}</div>
                </div>
              )}
              {method === "usdc" && cfg && view ? <UsdcPay cfg={cfg} view={view} shop={shop} onPaid={load} /> : method === "xchain" && view ? <CctpPay view={view} shop={shop} /> : method === "credit" && cfg && view ? <CreditPay cfg={cfg} view={view} shop={shop} onPaid={load} /> : method === "credit-private" && cfg && view ? <>
                <CreditPrivatePay cfg={cfg} view={view} shop={shop} wallet={wallet} bal={bal} payStep={step} proofSec={proofSec} onFunded={pay} onDrawn={setDrawnOnCredit} />
                {note && <p className={step === "error" ? "err" : "note"} role="status">{note}</p>}
              </> : method === "stocks" && cfg && view ? <StockPay cfg={cfg} view={view} shop={shop} onPaid={load} /> : <>
              <div className="co-bal">
                <div><span>Private balance</span><b>{bal ? usdc(bal.approved) : <span className="skel-t sm" />}<em>USDC</em></b>{bal && bal.pending > 0n && <small className="pend"><span className="spin xs" /> +{usdc(bal.pending)} being screened</small>}</div>
                <div><span>Refund inbox</span><b>{inbox ? usdc(inbox.approved + inbox.pending) : <span className="skel-t sm" />}<em>USDC</em></b></div>
              </div>

              {crowd && (
                <div className={`co-crowd ${crowd.depositors < 5 ? "thin" : ""}`}>
                  <div className="co-crowd-h"><span>Anonymity set</span><b>{crowd.depositors} depositor{crowd.depositors === 1 ? "" : "s"} · {crowd.deposits} deposit{crowd.deposits === 1 ? "" : "s"}</b></div>
                  <div className="co-crowd-bar" aria-hidden><i style={{ width: `${Math.min(100, (crowd.depositors / 50) * 100)}%` }} /></div>
                  <p>{crowd.depositors < 5 ? "This pool is new and small. Your payment hides among few people, so timing could link it to your deposit. Waiting helps." : "Your payment hides among everyone who has deposited into this pool."}</p>
                </div>
              )}

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
              </>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
