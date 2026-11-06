/**
 * Hosted checkout, "Pay with USDC": a plain wallet payment on Arc. The customer's wallet sends USDC straight to the
 * merchant's registered payout address; the Noren server checks that transfer on-chain (payee, exact amount, timing,
 * one tx per invoice) and marks the invoice paid. Simple, but public: the merchant sees the payer's address.
 */
import { useEffect, useState } from "react";
import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type Hex } from "viem";
import { activeAccount } from "./signer";
import { localFork } from "@noren/core";
import { SERVER, api, short, usdc, type Config, type InvoiceView } from "./api";
import { Icon, msgOf } from "./ui";
import { payoutOf } from "./kit";
import type { ReactNode } from "react";
import { TxLink } from "./tx";
import { Mark } from "./logos";

export function UsdcPay({ cfg, view, shop, onPaid }: { cfg: Config; view: InvoiceView; shop: string; onPaid: () => void }) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const [payout, setPayout] = useState<Address | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: ReactNode; bad?: boolean } | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);
  const amount = BigInt(view.invoice.amount);
  const chain = localFork(cfg.rpcUrl);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

  const load = async () => {
    const a = activeAccount().address; setAddr(a);
    pub.readContract({ address: cfg.deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] }).then(setBal).catch((e) => setNote({ t: msgOf(e), bad: true }));
  };
  useEffect(() => { load(); payoutOf(cfg.rpcUrl, cfg.deployment.checkout, view.invoice.merchant).then((p) => setPayout(/^0x0{40}$/.test(p) ? null : (p as Address))).catch((e) => setNote({ t: msgOf(e), bad: true })); }, [cfg, view.invoice.merchant]); // eslint-disable-line react-hooks/exhaustive-deps

  const pay = async () => {
    if (!payout) return;
    setBusy("pay"); setNote(null);
    try {
      const account = activeAccount();
      const w = createWalletClient({ chain, transport: http(cfg.rpcUrl), account });
      await pub.simulateContract({ account, address: cfg.deployment.usdc, abi: erc20Abi, functionName: "transfer", args: [payout, amount] });
      const h = await w.writeContract({ address: cfg.deployment.usdc, abi: erc20Abi, functionName: "transfer", args: [payout, amount], chain });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error(`USDC transfer reverted: ${h}`);
      setTx(h); setBusy("verify");
      const res = await fetch(`${SERVER}/invoices/${view.invoice.invoiceId}/pay-usdc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash: h }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 404 ? "Setup required: this Noren server can't verify direct USDC payments yet (restart pnpm dev:all on the app-dex branch)" : j.error ?? `HTTP ${res.status}`);
      setNote({ t: <>Paid {usdc(amount)} USDC to {shop} (tx <TxLink chain="arc" cfg={cfg} hash={h} />), verified on Arc.</> });
      onPaid();
    } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); load(); }
  };

  const enough = bal !== null && bal >= amount;
  return (
    <div className="co-credit">
      <div className="co-bal">
        <div><span>Wallet on Arc</span><b>{bal === null ? <span className="skel-t sm" /> : usdc(bal)}<em className="lg-row"><Mark id="USDC" size={16} />USDC</em></b><small className="faint mono">{addr ? short(addr, 6) : "…"}</small></div>
        <div><span>Pays to</span><b className="mono sm">{payout ? short(payout, 4) : "…"}</b><small className="faint">{shop}'s payout address</small></div>
      </div>
      {bal !== null && !enough && !tx && (
        <button className="btn line full" disabled={!!busy} onClick={async () => { setBusy("faucet"); setNote(null); try { await api.faucet(addr!); await load(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); } }}>
          {busy === "faucet" ? <><span className="spin" /> Sending…</> : "Get test USDC on Arc"}
        </button>
      )}
      <div className="co-privacy light">
        <Icon.card />
        <p><b>Simple, not private.</b> One USDC transfer from your wallet to {shop}. {shop} and anyone reading the chain see your address. For a private payment choose “Pay privately”.</p>
      </div>
      {note && <p className={note.bad ? "err" : "note"} role="status">{note.t}</p>}
      <button className="btn ink full xl" disabled={!!busy || !!tx || !enough || !payout} onClick={pay}>
        {busy === "pay" ? <><span className="spin" /> Sending USDC…</> : busy === "verify" ? <><span className="spin" /> Verifying on Arc…</> : !payout ? `${shop} has no payout address` : !enough ? "Not enough USDC" : <><Mark id="USDC" size={20} /> Pay {usdc(amount)} USDC</>}
      </button>
      <p className="faint sm center">USDC.transfer on the Arc fork, signed by your test key in this browser.</p>
    </div>
  );
}
