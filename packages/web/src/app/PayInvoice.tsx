/**
 * Pay a Noren invoice from inside the app: paste or scan a payment link, see who you're paying, and pay.
 * "Pay privately" runs here end to end (bind → Groth16 proof on this device → the merchant relays it from the Kohaku
 * pool). The three other ways (USDC, stocks, Pay in 3 / pay later privately) open Noren's hosted checkout with that
 * method already chosen, so the shop checkout and the app offer the same four ways.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { jsonBigints, parseInvoice, type Invoice } from "@noren/core";
import type { Hex } from "viem";
import { api, usdc, type InvoiceView } from "../api";
import { isFork, msgOf } from "../ui";
import { HOSTED } from "../hosted";
import { HostedTopUp } from "../HostedNotice";
import { TxLink } from "../tx";
import { Mark } from "../logos";
import type { Wallet } from "./NorenApp";
import { Spin, shortHex, pop } from "./kit";

export const invoiceIdIn = (s: string) => /0x[0-9a-fA-F]{64}/.exec(s)?.[0] as Hex | undefined;

/** The four ways to pay, in Noren's order. The checkout uses the same ids (`#/pay/<id>?m=<id>`). */
export const WAYS = [
  { id: "private", title: "Pay privately", sub: "USDC from your private balance. The shop never learns who paid.", tag: "Private" },
  { id: "usdc", title: "Pay with USDC", sub: "From your public wallet on Arc.", tag: "Public" },
  { id: "stocks", title: "Pay with stocks or crypto", sub: "Any Stock Token you hold, or ETH, sold to the best price for the shop's USDG.", tag: "Public" },
  { id: "later", title: "Pay in 3 / Pay later, privately", sub: "From your credit line. Pay later, privately keeps you hidden from the shop.", tag: "Private option" },
] as const;

type Step = "idle" | "binding" | "proving" | "relaying" | "paid" | "error";

/** Camera QR scanning where the browser has BarcodeDetector (Chrome, Edge, Android); otherwise says so. */
function useScanner(onText: (t: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const stop = useCallback(() => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setOn(false); }, []);
  useEffect(() => stop, [stop]);
  const start = async () => {
    setErr(null);
    const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!BD) { setErr("This browser can't read QR codes from the camera. Paste the link instead, or use your phone's camera app."); return; }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      setOn(true);
      await new Promise((r) => setTimeout(r, 50));
      if (!video.current) return;
      video.current.srcObject = stream.current; await video.current.play();
      const det = new BD({ formats: ["qr_code"] });
      const tick = async () => {
        if (!stream.current || !video.current) return;
        const hit = (await det.detect(video.current).catch(() => []))[0]?.rawValue;
        if (hit && invoiceIdIn(hit)) { onText(hit); stop(); return; }
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { setErr(`Camera: ${msgOf(e)}`); stop(); }
  };
  return { video, on, err, start, stop };
}

export function PayInvoice({ w, initial, onDone }: { w: Wallet; initial?: string; onDone?: () => void }) {
  const [text, setText] = useState(initial ?? "");
  const id = invoiceIdIn(text);
  const [view, setView] = useState<InvoiceView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [bal, setBal] = useState<{ approved: bigint; pending: bigint } | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [proofSec, setProofSec] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const scan = useScanner((t) => setText(t));
  const walletRef = useRef<Awaited<ReturnType<typeof loadWallet>> | null>(null);
  const loadWallet = (cfg: Wallet["cfg"]) => import("../wallet").then((m) => m.makeWallet(cfg));

  useEffect(() => { if (initial) setText(initial); }, [initial]);
  const refresh = useCallback(async () => {
    if (!id) { setView(null); setLoadErr(null); return; }
    try { setView(await api.invoice(id)); setLoadErr(null); } catch (e) { setView(null); setLoadErr(msgOf(e)); }
    try { walletRef.current ??= await loadWallet(w.cfg); setBal(await walletRef.current.balances()); } catch (e) { setNote(msgOf(e)); }
  }, [id, w.cfg]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setStep("idle"); setNote(null); setProofSec(null); setTotal(null); refresh(); }, [refresh]);
  useEffect(() => { if (!id || step === "paid") return; const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [id, step, refresh]);

  const amount = view ? BigInt(view.invoice.amount) : 0n;
  const payable = view?.status === "open" || view?.status === "draft";
  const enough = !!bal && bal.approved >= amount && amount > 0n;
  const working = step === "binding" || step === "proving" || step === "relaying";
  const shop = view?.merchantName || "this shop";

  const TOP_UP = 20_000_000n;
  // A wallet that already holds 20 USDC on the Arc fork shields it; otherwise the fork faucet (once per address) funds it.
  const hasPublic = w.arcUsdc !== null && w.arcUsdc >= TOP_UP;
  const topUp = async () => {
    setNote(null);
    try {
      walletRef.current ??= await loadWallet(w.cfg);
      const address = walletRef.current.address;
      if (!hasPublic) {
        setBusy("Getting test USDC on the Arc fork…");
        try { await api.faucet(address); }
        catch (e) {
          if (!/Faucet already used/i.test(msgOf(e))) throw e;
          const now = await w.oc.arcUsdc();
          if (now < TOP_UP) throw new Error(`The Arc fork faucet already funded ${address.slice(0, 8)}…, and this wallet holds ${usdc(now)} USDC: not enough to shield 20. Restart pnpm dev:all for a fresh fork, or pay another way.`);
        }
      }
      setBusy("Moving 20 USDC into your private balance…");
      await walletRef.current.shield(TOP_UP);
      setNote("20 USDC is in your private balance. The compliance check clears it in a few seconds."); w.refresh(); await refresh();
    } catch (e) { setNote(msgOf(e)); } finally { setBusy(null); }
  };

  const payPrivately = async () => {
    if (!view || !id) return;
    setNote(null); const t0 = performance.now();
    try {
      const wl = (walletRef.current ??= await loadWallet(w.cfg));
      setStep("binding");
      const { nextPrecommitment } = await wl.refundInbox();
      const opening = wl.createReceipt();
      const bound = await api.bind(id, nextPrecommitment, opening.commitment);
      const invoice: Invoice = parseInvoice(bound.invoice);
      await wl.rememberReceipt(invoice, opening);
      setStep("proving");
      const { withdrawal, proof, seconds } = await wl.prove(invoice);
      setProofSec(seconds);
      setStep("relaying");
      const done = await api.pay(id, jsonBigints({ withdrawal, proof }));
      setTotal((performance.now() - t0) / 1000);
      setView((v) => ({ ...v, ...done, merchantName: v?.merchantName ?? done.merchantName })); setStep("paid"); w.refresh(); onDone?.();
    } catch (e) { setStep("error"); setNote(msgOf(e)); }
  };

  return (
    <div className="nk-payin">
      <div className="nk-box">
        <label htmlFor="nk-paylink">Payment link or invoice</label>
        <div className="nk-row nk-row-link">
          <input id="nk-paylink" placeholder="Paste a Noren link: …/#/pay/0x…" value={text} onChange={(e) => setText(e.target.value.trim())} autoComplete="off" spellCheck={false} />
          <button type="button" className="nk-btn" onClick={scan.on ? scan.stop : scan.start} aria-pressed={scan.on}>{scan.on ? "Stop" : "Scan"}</button>
        </div>
        <div className="nk-sub"><span>{text && !id ? "That isn't a Noren payment link" : "A link, a QR code or a 0x… invoice ID"}</span><span /></div>
        {scan.on && <video ref={scan.video} className="nk-scan" muted playsInline aria-label="Camera preview" />}
        {scan.err && <p className="nk-err" role="alert">{scan.err}</p>}
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {id && (
          <motion.div key={id} className="nk-invoice" {...pop}>
            {loadErr ? <div className="nk-err" role="alert">{loadErr}</div> : !view ? <div className="nk-skel"><i /><i /></div> : (
              <>
                <div className="nk-inv-h">
                  <span className="nk-inv-mark" aria-hidden>{shop.slice(0, 1).toUpperCase()}</span>
                  <div><small>Pay {shop}</small><b>{usdc(view.invoice.amount)} <em>USDC</em></b><small>{view.description ?? "Payment"} · <span className="nk-mono">{shortHex(view.invoice.invoiceId, 6)}</span></small></div>
                  <span className={`nk-pill ${view.status === "paid" ? "live" : view.status === "expired" ? "bad" : ""}`}>{view.status}</span>
                </div>

                {step === "paid" || view.status === "paid" || view.status === "refunded" ? (
                  <div className="nk-paid" role="status">
                    <b>{step === "paid" ? "Paid privately" : view.status === "refunded" ? "Paid, then refunded" : "Already paid"}</b>
                    <p>{usdc(view.invoice.amount)} USDC to {shop}.{step === "paid" ? " Your address is not in the transaction." : ""}</p>
                    <dl className="nk-rows">
                      {proofSec !== null && <><dt>Proof made on this device</dt><dd>{proofSec.toFixed(2)} s</dd></>}
                      {total !== null && <><dt>Tap to paid</dt><dd>{total.toFixed(1)} s</dd></>}
                      <dt>Transaction</dt><dd><TxLink chain="arc" cfg={w.cfg} hash={view.paymentTx} n={6} /></dd>
                    </dl>
                  </div>
                ) : !payable ? <p className="nk-err">This link is {view.status}. Ask the shop for a new one; nothing was charged.</p> : (
                  <>
                    <div className="nk-ways" role="list" aria-label="Ways to pay">
                      {WAYS.map((m) => m.id === "private" ? (
                        <div key={m.id} role="listitem" className="nk-way on">
                          <Mark id="KOHAKU" size={26} />
                          <div><b>{m.title}</b><small>{m.sub}</small><small className="nk-mono">Private balance {bal ? `${usdc(bal.approved)} USDC` : "…"}{bal && bal.pending > 0n ? ` · +${usdc(bal.pending)} being screened` : ""}</small></div>
                          <span className="nk-way-tag ok">{m.tag}</span>
                        </div>
                      ) : (
                        <a key={m.id} role="listitem" className="nk-way" href={`#/pay/${id}?m=${m.id}`}>
                          <Mark id={m.id === "usdc" ? "USDC" : m.id === "stocks" ? "NVDA" : "ARC"} size={26} />
                          <div><b>{m.title}</b><small>{m.sub}</small></div>
                          <span className="nk-way-tag">{m.tag} →</span>
                        </a>
                      ))}
                    </div>
                    {!enough && bal && !working && (HOSTED || !isFork(w.cfg)) && (
                      <HostedTopUp variant="nk" cfg={w.cfg} amount={amount} bal={bal} getWallet={async () => (walletRef.current ??= await loadWallet(w.cfg))} onChange={() => { w.refresh(); refresh(); }} />
                    )}
                    {!enough && bal && !working && !(HOSTED || !isFork(w.cfg)) && (
                      <div className="nk-setup" role="status"><span className="nk-tag">Top up first</span><b>Your private balance is {usdc(bal.approved)} USDC.</b><p>{hasPublic ? `Your wallet holds ${usdc(w.arcUsdc!)} USDC on the Arc fork: move 20 into your private balance.` : "Test network: get fork USDC and move 20 into your private balance in one step."}</p>
                        <button className="nk-btn ink" disabled={!!busy} onClick={topUp}>{busy ? <><Spin /> {busy}</> : hasPublic ? "Shield 20 USDC from your wallet" : "Add 20 test USDC privately"}</button></div>
                    )}
                    <ol className="nk-steps" aria-label="Private payment steps">
                      {(["binding", "proving", "relaying"] as const).map((s, i) => {
                        const at = ["binding", "proving", "relaying", "paid"].indexOf(step);
                        return <li key={s} data-state={at > i ? "done" : at === i ? "now" : "todo"}><i>{at > i ? "✓" : i + 1}</i><span>{s === "binding" ? "Bind the invoice to your refund inbox" : s === "proving" ? `Prove on this device${proofSec ? ` (${proofSec.toFixed(2)} s)` : ""}` : `${shop} relays it and pays the gas`}</span></li>;
                      })}
                    </ol>
                    <button className="nk-cta" disabled={!enough || working || !!busy} onClick={payPrivately}>
                      {working ? <><Spin /> {step === "binding" ? "Binding the invoice…" : step === "proving" ? "Proving on this device…" : `${shop} is relaying…`}</> : `Pay ${usdc(view.invoice.amount)} USDC privately`}
                    </button>
                  </>
                )}
                {note && <div className={step === "error" ? "nk-err" : "nk-note"} role="status">{note}</div>}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
