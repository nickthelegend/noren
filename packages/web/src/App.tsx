import { useCallback, useEffect, useRef, useState } from "react";
import { jsonBigints, parseInvoice, type Invoice } from "@noren/core";
import { api, short, usdc, SERVER, type Config, type InvoiceView } from "./api";
import type { Wallet } from "./wallet";

const EXPLORER = "https://explorer.testnet.arc.io/tx/";
/** Fork transactions don't exist on the public explorer: link only when talking to a real network. */
const txLink = (cfg: Config | null, hash?: string) => !hash ? null : cfg && !/127\.0\.0\.1|localhost/.test(cfg.rpcUrl) ? <a className="nr-tx" href={`${EXPLORER}${hash}`} target="_blank" rel="noreferrer">tx ↗</a> : <span className="nr-tx" title={`${hash} (local fork)`}>{short(hash, 8)}</span>;
/** viem errors carry request dumps; show the human part only. */
const msgOf = (e: unknown) => { const m = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : (() => { try { return JSON.stringify(e); } catch { return String(e); } })(); const head = m.split(/Request Arguments:|Contract Call:|Raw Call Arguments:|\n\n/)[0].trim(); return head.length > 220 ? head.slice(0, 220) + "…" : head; };

function useRoute() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => { const on = () => { setHash(location.hash); window.scrollTo(0, 0); }; addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  if (hash.startsWith("#/merchant")) return { page: "merchant" as const };
  const m = /^#\/pay\/(0x[0-9a-fA-F]{64})/.exec(hash);
  if (m) return { page: "pay" as const, id: m[1] };
  return { page: "home" as const };
}

function useConfig() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.config().then(setCfg).catch((e) => setErr(e.message)); }, []);
  return { cfg, err };
}

export function App() {
  const route = useRoute();
  return (
    <div className="nr">
      <header className="nr-nav">
        <a className="nr-brand" href="#/"><img src="/noren.svg" alt="" width="30" height="30" /><span>Noren</span></a>
        <nav><a href="#/merchant" aria-current={route.page === "merchant" ? "page" : undefined}>Merchant</a><a href="https://github.com/nickthelegend/noren" target="_blank" rel="noreferrer">Source</a></nav>
      </header>
      {route.page === "home" && <Home />}
      {route.page === "merchant" && <Merchant />}
      {route.page === "pay" && <Checkout id={route.id} />}
      <footer className="nr-foot"><span>Noren · Kohaku Privacy Pools on Arc · MIT</span><span>Local Arc testnet fork until the live deployment is funded</span></footer>
    </div>
  );
}

/* ------------------------------------------------------------------ landing */
function Home() {
  return (
    <main>
      <section className="nr-hero">
        <div className="nr-hero-copy">
          <span className="nr-pill"><i />Kohaku × Arc · USDC</span>
          <h1>Get paid.<br /><em>Never learn who paid.</em></h1>
          <p>Customers pay from a private USDC balance. The merchant is paid instantly and can refund, and nobody, the merchant included, can see who the customer was.</p>
          <div className="nr-ctas"><a className="nr-btn ink" href="#/merchant">Open the merchant console</a><a className="nr-btn line" href="#how">How it works</a></div>
        </div>
        <div className="nr-curtain" aria-hidden>
          <div className="nr-curtain-rod" />
          {[0, 1, 2].map((i) => <div key={i} className={`nr-curtain-panel p${i}`}>{i === 1 && <span>暖簾</span>}</div>)}
          <div className="nr-receipt">
            <small>Payment received</small>
            <b>7.50 USDC</b>
            <dl><dt>From</dt><dd>Noren checkout</dd><dt>Customer</dt><dd className="unk">unknown</dd></dl>
          </div>
        </div>
      </section>

      <section className="nr-how" id="how">
        <span className="nr-eyebrow">How it works</span>
        <h2>A shop curtain for your customers.</h2>
        <ol>
          <li><b>Shield.</b><span>The customer deposits USDC into a Kohaku privacy pool. A compliance check (USDC's own blacklist) approves it.</span></li>
          <li><b>Prove.</b><span>On their device, they make a zero-knowledge proof bound to this invoice, this merchant and this amount. Change any field and the pool rejects it.</span></li>
          <li><b>The merchant relays.</b><span>The merchant submits the proof and pays about a cent of gas. The customer needs no gas and no public wallet.</span></li>
          <li><b>Refund privately.</b><span>Refunds land in the customer's private inbox. The merchant never learns who they refunded.</span></li>
        </ol>
      </section>

      <section className="nr-facts">
        <div><b>~1.2 s</b><span>proof on a laptop (measured)</span></div>
        <div><b>583k</b><span>gas per checkout (~$0.01 on Arc)</span></div>
        <div><b>0</b><span>customer addresses the merchant sees</span></div>
        <div><b>5/5</b><span>attacks rejected on chain (replay, tamper, squat, expiry, stale root)</span></div>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ merchant console */
function Merchant() {
  const { cfg, err } = useConfig();
  const [token, setToken] = useState(() => { try { return localStorage.getItem("noren.merchant.token") ?? ""; } catch { return ""; } });
  const [rows, setRows] = useState<InvoiceView[]>([]);
  const [amount, setAmount] = useState("7.50");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const refresh = useCallback(async () => { if (cfg) setRows(await api.listInvoices(cfg.merchant).catch(() => [])); }, [cfg]);
  useEffect(() => { refresh(); const es = api.events(); es.onmessage = () => refresh(); ["invoice_created", "paid", "refunded"].forEach((t) => es.addEventListener(t, () => refresh())); return () => es.close(); }, [refresh]);
  const saveToken = (t: string) => { setToken(t); try { localStorage.setItem("noren.merchant.token", t); } catch { /* ignore */ } };
  const create = async () => {
    if (!cfg) return;
    setBusy(true); setMsg(null);
    try {
      const base = BigInt(Math.round(Number(amount) * 1e6));
      if (base <= 0n) throw new Error("Enter an amount above 0");
      const r = await api.createInvoice(cfg.merchant, base, BigInt(Math.floor(Date.now() / 1000) + 30 * 60), token);
      setCreated(r.invoice.invoiceId); refresh();
    } catch (e) { setMsg(msgOf(e)); } finally { setBusy(false); }
  };
  const paidTotal = rows.filter((r) => r.status === "paid" || r.status === "refunded").reduce((s, r) => s + BigInt(r.invoice.amount), 0n);
  if (err) return <Setup err={err} />;
  return (
    <main className="nr-console">
      <div className="nr-console-h">
        <div><span className="nr-eyebrow">Merchant console</span><h2>Takumi Coffee</h2><p className="nr-mono">{cfg ? short(cfg.merchant, 10) : "…"}</p></div>
        <div className="nr-kpis"><div><small>Received</small><b>{usdc(paidTotal)} <em>USDC</em></b></div><div><small>Invoices</small><b>{rows.length}</b></div><div><small>Customers identified</small><b>0</b></div></div>
      </div>

      <div className="nr-console-grid">
        <section className="nr-card">
          <h3>New invoice</h3>
          <label htmlFor="amt">Amount</label>
          <div className="nr-amount"><input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span>USDC</span></div>
          <label htmlFor="tok">Merchant token</label>
          <input id="tok" className="nr-input" type="password" placeholder="printed by pnpm dev:stack" value={token} onChange={(e) => saveToken(e.target.value)} />
          {msg && <p className="nr-err" role="alert">{msg}</p>}
          <button className="nr-btn ink full" disabled={busy || !token || !cfg} onClick={create}>{busy ? "Creating…" : "Create payment link"}</button>
          {created && <div className="nr-link"><small>Share with the customer</small><a href={`#/pay/${created}`}>{location.origin}/#/pay/{short(created, 10)}</a></div>}
        </section>

        <section className="nr-card wide">
          <h3>Payments</h3>
          {rows.length === 0 ? <p className="nr-empty">No invoices yet. Create one, open its link, and pay it privately.</p> : (
            <table className="nr-table">
              <thead><tr><th>Invoice</th><th>Amount</th><th>Status</th><th>Customer</th><th /></tr></thead>
              <tbody>{rows.map((r) => <InvoiceRow key={r.invoice.invoiceId} r={r} token={token} cfg={cfg} onDone={refresh} />)}</tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}

function InvoiceRow({ r, token, cfg, onDone }: { r: InvoiceView; token: string; cfg: Config | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const refund = async () => {
    const value = prompt("Refund how much USDC?", usdc(r.invoice.amount));
    if (!value) return;
    setBusy(true); setErr(null);
    try { await api.refund(r.invoice.invoiceId, BigInt(Math.round(Number(value) * 1e6)), token); onDone(); } catch (e) { setErr(msgOf(e)); } finally { setBusy(false); }
  };
  return (
    <tr>
      <td className="nr-mono"><a href={`#/pay/${r.invoice.invoiceId}`}>{short(r.invoice.invoiceId, 8)}</a></td>
      <td>{usdc(r.invoice.amount)}</td>
      <td><span className={`nr-status ${r.status}`}>{r.status}</span>{txLink(cfg, r.paymentTx)}</td>
      <td className="unk">unknown</td>
      <td>{r.status === "paid" && <button className="nr-btn line sm" disabled={busy || !token} onClick={refund}>{busy ? "…" : "Refund"}</button>}{err && <span className="nr-err sm">{err}</span>}</td>
    </tr>
  );
}

/* ------------------------------------------------------------------ customer checkout */
type Step = "idle" | "binding" | "proving" | "relaying" | "paid" | "error";
function Checkout({ id }: { id: string }) {
  const { cfg, err } = useConfig();
  // The prover (snarkjs + Kohaku, ~2 MB) loads only here, on the checkout page.
  const [wallet, setWallet] = useState<Wallet | null>(null);
  useEffect(() => { if (cfg) import("./wallet").then((m) => setWallet(m.makeWallet(cfg))).catch((e) => setNote(`Couldn't load the private wallet: ${msgOf(e)}`)); }, [cfg]);
  const [view, setView] = useState<InvoiceView | null>(null);
  const [bal, setBal] = useState<{ approved: bigint; pending: bigint } | null>(null);
  const [inbox, setInbox] = useState<{ approved: bigint; pending: bigint } | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [proofSec, setProofSec] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try { setView(await api.invoice(id)); } catch (e) { setNote(msgOf(e)); }
    if (wallet) { try { setBal(await wallet.balances()); setInbox(await wallet.refundInbox()); } catch (e) { setNote(msgOf(e)); } }
  }, [id, wallet]);
  useEffect(() => { alive.current = true; load(); const t = setInterval(load, 6000); return () => { alive.current = false; clearInterval(t); }; }, [load]);

  if (err) return <Setup err={err} />;
  const amount = view ? BigInt(view.invoice.amount) : 0n;
  const enough = !!bal && bal.approved >= amount && amount > 0n;
  const expired = view ? Number(view.invoice.expiry) * 1000 < Date.now() : false;

  const getUsdc = async () => { if (!wallet) return; setBusy("faucet"); setNote(null); try { await api.faucet(wallet.address); await load(); } catch (e) { setNote(msgOf(e)); } finally { setBusy(null); } };
  const shield = async () => { if (!wallet) return; setBusy("shield"); setNote(null); try { await wallet.shield(20_000_000n); setNote("Shielded 20 USDC. The compliance check approves it in a few seconds."); await load(); } catch (e) { setNote(msgOf(e)); } finally { setBusy(null); } };
  const pay = async () => {
    if (!wallet || !view) return;
    setNote(null);
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
      setView(done); setStep("paid"); load();
    } catch (e) { setStep("error"); setNote(msgOf(e)); }
  };

  const steps: [Step, string, string][] = [
    ["binding", "Bind the invoice", "your private refund inbox + receipt"],
    ["proving", "Prove on this device", proofSec ? `${proofSec.toFixed(2)} s` : "zero-knowledge, nothing leaves the browser"],
    ["relaying", "Merchant relays", "they pay the gas"],
    ["paid", "Paid", view?.paymentTx ? short(view.paymentTx, 10) : ""],
  ];
  const order: Step[] = ["binding", "proving", "relaying", "paid"];
  const at = order.indexOf(step);

  return (
    <main className="nr-checkout">
      <section className="nr-co-left">
        <span className="nr-eyebrow light">Pay Takumi Coffee</span>
        <b className="nr-co-amount">{view ? usdc(view.invoice.amount) : "…"}<em>USDC</em></b>
        <dl className="nr-co-dl">
          <dt>Invoice</dt><dd className="nr-mono">{short(id, 10)}</dd>
          <dt>Expires</dt><dd>{view ? new Date(Number(view.invoice.expiry) * 1000).toLocaleTimeString() : "…"}</dd>
          <dt>Merchant sees</dt><dd>the amount, never you</dd>
        </dl>
        <div className={`nr-co-state ${view?.status ?? ""}`}>{view?.status === "paid" ? "Paid privately" : view?.status === "refunded" ? "Refunded to your private inbox" : expired ? "Expired" : "Awaiting payment"}</div>
      </section>

      <section className="nr-co-right">
        <h2>Pay privately</h2>
        <div className="nr-bal">
          <div><small>Your private balance</small><b>{bal ? usdc(bal.approved) : "…"}</b>{bal && bal.pending > 0n && <span className="nr-pend">+{usdc(bal.pending)} being approved</span>}</div>
          <div><small>Refund inbox</small><b>{inbox ? usdc(inbox.approved + inbox.pending) : "…"}</b>{inbox && inbox.pending > 0n && <span className="nr-pend">{usdc(inbox.pending)} being approved</span>}</div>
        </div>
        {!enough && view?.status !== "paid" && (
          <div className="nr-setup-steps">
            <p>You need a private balance first. On this test network:</p>
            <div className="nr-row2"><button className="nr-btn line" disabled={!!busy} onClick={getUsdc}>{busy === "faucet" ? "…" : "1 · Get test USDC"}</button><button className="nr-btn line" disabled={!!busy} onClick={shield}>{busy === "shield" ? "Shielding…" : "2 · Shield 20 USDC"}</button></div>
          </div>
        )}
        <ol className="nr-track">{steps.map(([k, t, d], i) => <li key={k} data-on={at >= i || view?.status === "paid"}><i /><b>{t}</b><span>{d}</span></li>)}</ol>
        {note && <p className={step === "error" ? "nr-err" : "nr-note"} role="status">{note}</p>}
        <button className={`nr-btn ink full big ${view?.status === "paid" || view?.status === "refunded" ? "done" : ""}`} disabled={!enough || expired || view?.status !== "open" && view?.status !== "draft" || (step !== "idle" && step !== "error")} onClick={pay}>
          {view?.status === "paid" || view?.status === "refunded" ? "Paid privately ✓" : step === "idle" || step === "error" ? `Pay ${view ? usdc(view.invoice.amount) : ""} USDC privately` : "Working…"}
        </button>
        <p className="nr-fine">Your wallet lives in this browser (test network only). The merchant receives the payment from the Noren checkout contract; your address never appears.</p>
      </section>
    </main>
  );
}

function Setup({ err }: { err: string }) {
  return (
    <main className="nr-setup">
      <h2>Setup required</h2>
      <p>{err}</p>
      <pre>pnpm install{"\n"}pnpm dev:stack      # Arc testnet fork + Noren contracts + merchant server + compliance postman{"\n"}pnpm --filter @noren/web dev</pre>
      <p className="nr-fine">Server: {SERVER}</p>
    </main>
  );
}
