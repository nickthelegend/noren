/**
 * Earn: deposit stock or ETH into a NorenDepositVault (ERC-4626). The shares are your receipt; the vault backs its
 * own 1inch Aqua maker, so its spread on real fills is the yield. Withdraw any time; realised yield is computed from
 * your own Deposit/Withdraw logs. Nothing here is projected: no APY is shown without fills to back it.
 */
import { useEffect, useMemo, useState } from "react";
import { erc20Abi, maxUint256, type Address } from "viem";
import { msgOf } from "../ui";
import type { Wallet } from "./NorenApp";
import { readVaults, vaultAbi, type VaultRow } from "./earn";
import { TOKENS, fmtUnits, parseAmount } from "./tokens";
import { Card, Coin, Empty, SetupCard, Skel, Spin, shortHex } from "./kit";
import { SWAPVM_ATTRIBUTION } from "./SwapTab";

const symOf = (a: Address) => TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase())?.sym ?? shortHex(a, 4);

export function EarnTab({ w }: { w: Wallet }) {
  const list = (w.oc.credit?.depositVaults as { asset: Address; vault: Address }[] | undefined) ?? [];
  const [rows, setRows] = useState<VaultRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: string; bad?: boolean } | null>(null);
  useEffect(() => { if (!list.length) return; let on = true; readVaults(w, list, symOf).then((r) => on && (setRows(r), setErr(null))).catch((e) => on && setErr(msgOf(e))); return () => { on = false; }; }, [w.tick, list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = rows?.find((r) => r.vault === sel) ?? rows?.find((r) => r.sym === "NVDA") ?? rows?.[0];
  const tok = v ? TOKENS.find((t) => t.sym === v.sym) : undefined;
  const native = v?.sym === "ETH";
  const walletBal = v ? (native ? w.hold?.eth ?? 0n : v.walletAsset) : 0n;
  const amt = useMemo(() => parseAmount(amount, mode === "deposit" ? 18 : v?.decimals ?? 18), [amount, mode, v?.decimals]);
  const [preview, setPreview] = useState<bigint | null>(null);
  useEffect(() => {
    if (!v || !amt) { setPreview(null); return; }
    const { pub } = w.oc.robinhood(); let on = true;
    pub.readContract({ address: v.vault, abi: vaultAbi, functionName: mode === "deposit" ? "previewDeposit" : "previewRedeem", args: [amt] }).then((x) => on && setPreview(x)).catch(() => on && setPreview(null));
    return () => { on = false; };
  }, [v?.vault, amt, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list.length) return <div className="nk-col"><Card title="Earn"><div className="nk-pad"><SetupCard title="The deposit vaults aren't deployed on this stack" text="NorenDepositVault isn't in this stack's config. Rebuild the Robinhood snapshot (sh packages/robinhood/scripts/fork-snapshot.sh) and restart pnpm dev:all." /></div></Card></div>;

  const go = async () => {
    if (!v || !amt) return;
    setBusy(mode); setNote(null);
    try {
      const { pub, wallet, chain, account } = w.oc.robinhood();
      const send = async (label: string, req: Parameters<typeof wallet.writeContract>[0]) => { setNote({ t: label }); const h = await wallet.writeContract(req); const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(`${label} reverted: ${h}`); return h; };
      let h: string;
      if (mode === "deposit") {
        if (native) h = await send("Depositing ETH…", { address: v.vault, abi: vaultAbi, functionName: "depositETH", args: [account.address], value: amt, chain, account } as never);
        else {
          const allowance = await pub.readContract({ address: v.asset, abi: erc20Abi, functionName: "allowance", args: [account.address, v.vault] });
          if (allowance < amt) await send(`Approving ${v.sym}…`, { address: v.asset, abi: erc20Abi, functionName: "approve", args: [v.vault, maxUint256], chain, account });
          await pub.simulateContract({ account, address: v.vault, abi: vaultAbi, functionName: "deposit", args: [amt, account.address] });
          h = await send(`Depositing ${v.sym}…`, { address: v.vault, abi: vaultAbi, functionName: "deposit", args: [amt, account.address], chain, account });
        }
      } else {
        const fn = !v.stats.priced ? "redeemInKind" : native ? "redeemETH" : "redeem";
        await pub.simulateContract({ account, address: v.vault, abi: vaultAbi, functionName: fn, args: [amt, account.address, account.address] } as never);
        h = await send(fn === "redeemInKind" ? "Redeeming in kind (a feed is stale)…" : "Withdrawing…", { address: v.vault, abi: vaultAbi, functionName: fn, args: [amt, account.address, account.address], chain, account } as never);
      }
      setNote({ t: `${mode === "deposit" ? "Deposited" : "Withdrew"} on Robinhood (tx ${shortHex(h, 6)}).` }); setAmount(""); w.refresh();
    } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); }
  };

  const max = mode === "deposit" ? walletBal : v?.shares ?? 0n;
  const over = !!amt && amt > max;
  const s = v?.stats;
  const open = v ? v.assetsNow - v.netDeposited : 0n;
  return (
    <div className="nk-col">
      <section className="nk-card" aria-label="Earn">
        <div className="nk-card-h"><b>Earn</b>
          <div className="nk-band" style={{ padding: 0 }} role="group" aria-label="Deposit or withdraw">{(["deposit", "withdraw"] as const).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => { setMode(m); setAmount(""); }}>{m === "deposit" ? "Deposit" : "Withdraw"}</button>)}</div>
        </div>
        {err ? <div className="nk-pad"><div className="nk-err">{err}</div></div> : !rows || !v ? <Skel rows={3} /> : (
          <>
            <div className="nk-box">
              <label htmlFor="nk-earn"><span>{mode === "deposit" ? "You deposit" : "You redeem"}</span></label>
              <div className="nk-row">
                <input id="nk-earn" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
                {mode === "deposit" && tok ? <span className="nk-token" data-static="true"><Coin t={tok} />{v.sym}</span> : <span className="nk-token" data-static="true"><Coin t={{ sym: v.shareSym, color: "#1c2a5e" }} />{v.shareSym}</span>}
              </div>
              <div className="nk-sub"><span>{mode === "deposit" ? "Into the vault's Aqua maker" : "Shares are your receipt"}</span><span>{mode === "deposit" ? "Wallet" : "Shares"} <button type="button" onClick={() => setAmount(String(Number(max) / 1e18))}>{fmtUnits(max, 18, 4)}</button></span></div>
            </div>
            <div className="nk-flip" aria-hidden style={{ cursor: "default" }}>↓</div>
            <div className="nk-box">
              <span className="nk-l"><span>{mode === "deposit" ? "You receive" : "You get back"}</span><span>{mode === "deposit" ? "receipt shares" : v.stats.priced ? `${v.sym}` : "in kind"}</span></span>
              <div className="nk-row"><output className={preview ? "" : "dim"}>{preview !== null ? fmtUnits(preview, 18, 6) : "0"}</output>{mode === "deposit" ? <span className="nk-token" data-static="true"><Coin t={{ sym: v.shareSym, color: "#1c2a5e" }} />{v.shareSym}</span> : tok && <span className="nk-token" data-static="true"><Coin t={tok} />{v.sym}</span>}</div>
              <div className="nk-sub"><span>{s?.priced ? `1 ${v.shareSym} = ${fmtUnits(s.assetsPerShare, 18, 6)} ${v.sym}` : "A feed is stale: withdrawals pay out in kind"}</span><span /></div>
            </div>
            <div className="nk-routes" role="radiogroup" aria-label="Vault">
              {rows.map((r) => {
                const t = TOKENS.find((x) => x.sym === r.sym);
                return (
                  <button key={r.vault} role="radio" aria-checked={r.vault === v.vault} className="nk-route" data-best={r.vault === v.vault} onClick={() => setSel(r.vault)} style={{ cursor: "pointer" }}>
                    {t ? <Coin t={t} /> : <span className="nk-route-i">{r.sym.slice(0, 2)}</span>}
                    <div><b>{r.shareSym} · {r.sym} vault</b><small>{r.stats.fills > 0n ? `${r.stats.fills} maker fills · ${fmtUnits(r.stats.feesUsdg, 6, 2)} USDG earned` : "No maker fills yet, so no yield yet"}</small></div>
                    <div className="r"><b>{r.stats.priced ? `$${fmtUnits(r.stats.navUsd8, 8, 0)}` : "–"}</b><small>NAV</small></div>
                  </button>
                );
              })}
            </div>
            {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
            <button className="nk-cta" disabled={!!busy || !amt || over} onClick={go}>{busy ? <><Spin /> {mode === "deposit" ? "Depositing…" : "Withdrawing…"}</> : !amt ? "Enter an amount" : over ? (mode === "deposit" ? `Not enough ${v.sym}` : "Not enough shares") : mode === "deposit" ? `Deposit ${v.sym}` : `Withdraw ${v.sym}`}</button>
            <p className="nk-attrib">{SWAPVM_ATTRIBUTION}</p>
          </>
        )}
      </section>

      {v && s && (
        <Card title="Your position" sub={`${v.shareSym} receipt shares; gains from your own Deposit and Withdraw logs`}>
          <div className="nk-pad">
            {v.shares + v.locked === 0n && v.realised === 0n ? <Empty title="Nothing deposited yet" text={`Deposit ${v.sym} to back the vault's 1inch Aqua maker and earn its spread on real fills.`} /> : (
              <div className="nk-stats">
                <div className="nk-stat"><small>Shares{v.locked > 0n ? ` (${fmtUnits(v.locked, 18, 4)} locked in Borrow)` : ""}</small><b>{fmtUnits(v.shares + v.locked, 18, 4)}</b></div>
                <div className="nk-stat"><small>Worth now</small><b>{fmtUnits(v.assetsNow, 18, 6)} {v.sym}</b></div>
                <div className="nk-stat"><small>Open gain</small><b className={open > 0n ? "ok" : open < 0n ? "bad" : ""}>{open >= 0n ? "+" : "−"}{fmtUnits(open < 0n ? -open : open, 18, 6)} {v.sym}</b></div>
                <div className="nk-stat"><small>Realised yield</small><b className={v.realised > 0n ? "ok" : ""}>{fmtUnits(v.realised, 18, 6)} {v.sym}</b></div>
              </div>
            )}
            <dl className="nk-rows">
              <dt>Vault NAV</dt><dd>{s.priced ? `$${fmtUnits(s.navUsd8, 8, 2)}` : "feed stale"}</dd>
              <dt>Held</dt><dd>{fmtUnits(s.assetBalance, 18, 4)} {v.sym} + {fmtUnits(s.usdgBalance, 6, 2)} USDG</dd>
              <dt>Maker fills · volume</dt><dd>{String(s.fills)} · {fmtUnits(s.volumeUsdg, 6, 2)} USDG</dd>
              <dt>Spread earned (realised)</dt><dd className={s.feesUsdg > 0n ? "ok" : ""}>{fmtUnits(s.feesUsdg, 6, 4)} USDG</dd>
              <dt>Since</dt><dd>{s.firstDepositAt > 0n ? new Date(Number(s.firstDepositAt) * 1000).toLocaleString() : "no deposits yet"}</dd>
            </dl>
          </div>
        </Card>
      )}
    </div>
  );
}
