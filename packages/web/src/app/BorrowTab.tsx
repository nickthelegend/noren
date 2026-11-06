/**
 * Borrow: lock Earn receipt shares in NorenBorrow and borrow USDG from the lender pool. The limit is the Chainlink value
 * of the collateral times your reputation LTV (66% → 80%); the health factor and liquidation price come from the
 * contract itself. Below health 1.0 the collateral is sold to 1inch Aqua makers.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { erc20Abi, maxUint256, type Address } from "viem";
import { msgOf } from "../ui";
import { USDG } from "../onchain";
import type { Wallet } from "./NorenApp";
import { borrowAbi, readVaults, type VaultRow } from "./earn";
import { TOKENS, USDG_TOKEN, fmtUnits, parseAmount } from "./tokens";
import { Card, Coin, Empty, SetupCard, Skel, Spin, shortHex } from "./kit";

const symOf = (a: Address) => TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase())?.sym ?? shortHex(a, 4);
type Pos = { debt: bigint; limit: bigint; health: bigint; ltvBps: number; liqLtvBps: number; rateBps: number; collateral8: bigint; liq: Record<string, bigint> };

export function BorrowTab({ w }: { w: Wallet }) {
  const borrow = (w.oc.credit?.borrow as Address | undefined) ?? null;
  const list = (w.oc.credit?.depositVaults as { asset: Address; vault: Address }[] | undefined) ?? [];
  const [rows, setRows] = useState<VaultRow[] | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"borrow" | "repay">("borrow");
  const [amount, setAmount] = useState("");
  const [lockAmt, setLockAmt] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ t: string; bad?: boolean } | null>(null);

  useEffect(() => {
    if (!borrow || !list.length) return;
    let on = true;
    const { pub } = w.oc.robinhood(); const me = w.oc.address;
    const rd = <T,>(functionName: string, args: unknown[] = []) => pub.readContract({ address: borrow, abi: borrowAbi, functionName, args } as never) as Promise<T>;
    Promise.all([readVaults(w, list, symOf), rd<bigint>("debtOf", [me]), rd<bigint>("borrowLimitUsdg", [me]), rd<bigint>("healthFactor", [me]), rd<number>("ltvOf", [me]), rd<number>("liquidationLtvBps"), rd<number>("borrowRateBps"), rd<bigint>("collateralValueUsd8", [me, false])])
      .then(async ([r, debt, limit, health, ltvBps, liqLtvBps, rateBps, collateral8]) => {
        const liq: Record<string, bigint> = {};
        for (const v of r) if (v.locked > 0n) liq[v.vault] = await rd<bigint>("liquidationPriceUsd8", [me, v.vault]).catch(() => 0n);
        if (on) { setRows(r); setPos({ debt, limit, health, ltvBps: Number(ltvBps), liqLtvBps: Number(liqLtvBps), rateBps: Number(rateBps), collateral8, liq }); setErr(null); }
      }).catch((e) => on && setErr(msgOf(e)));
    return () => { on = false; };
  }, [w.tick, borrow, list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const amt = useMemo(() => parseAmount(amount, 6), [amount]);
  if (!borrow || !list.length) return <div className="nk-col"><Card title="Borrow"><div className="nk-pad"><SetupCard title="NorenBorrow isn't deployed on this stack" text="Rebuild the Robinhood snapshot (sh packages/robinhood/scripts/fork-snapshot.sh) and restart pnpm dev:all." /></div></Card></div>;

  const run = async (k: string, f: (x: ReturnType<Wallet["oc"]["robinhood"]>) => Promise<string>) => {
    setBusy(k); setNote(null);
    try { const t = await f(w.oc.robinhood()); setNote({ t }); w.refresh(); } catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(null); }
  };
  const tx = async (x: ReturnType<Wallet["oc"]["robinhood"]>, label: string, req: Record<string, unknown>) => {
    setNote({ t: label });
    await x.pub.simulateContract({ account: x.account, ...req } as never);
    const h = await x.wallet.writeContract({ ...req, chain: x.chain, account: x.account } as never);
    if ((await x.pub.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error(`${label} reverted: ${h}`);
    return h;
  };

  const hf = pos ? (pos.health > 10n ** 30n ? null : Number(pos.health) / 1e18) : null;
  const room = pos ? (pos.limit > pos.debt ? pos.limit - pos.debt : 0n) : 0n;
  const after = pos && amt ? (mode === "borrow" ? pos.debt + amt : pos.debt > amt ? pos.debt - amt : 0n) : pos?.debt ?? 0n;
  const hfAfter = pos && after > 0n ? (Number(pos.collateral8) / 100 * (pos.liqLtvBps / 10_000)) / Number(after) : null; // collateral USD (6 dp) x liquidation LTV / debt; USDG at $1
  const usdg = w.hold?.usdg ?? 0n;
  const over = !!amt && (mode === "borrow" ? amt > room : amt > usdg || amt > (pos?.debt ?? 0n) + 1_000_000n);
  const tone = (h: number | null) => (h === null ? "" : h < 1.1 ? "bad" : h < 1.5 ? "warn" : "ok");

  return (
    <div className="nk-col">
      <div className="nk-hero" aria-label="Borrow limit">
        <small>Borrow limit · NorenBorrow on Robinhood Chain</small>
        <b>{pos ? <><i>$</i>{fmtUnits(pos.limit, 6, 2)}</> : err ? "–" : "…"}</b>
        <p>{err ? err : pos ? `${(pos.ltvBps / 100).toFixed(0)}% of your collateral's Chainlink value (your reputation tier; up to 80%) · ${(pos.rateBps / 100).toFixed(1)}% a year` : "Reading your position…"}</p>
      </div>

      <section className="nk-card" aria-label="Borrow or repay">
        <div className="nk-card-h"><b>{mode === "borrow" ? "Borrow USDG" : "Repay"}</b>
          <div className="nk-band" style={{ padding: 0 }} role="group" aria-label="Borrow or repay">{(["borrow", "repay"] as const).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => { setMode(m); setAmount(""); }}>{m === "borrow" ? "Borrow" : "Repay"}</button>)}</div>
        </div>
        {!pos ? <Skel rows={2} /> : (
          <>
            <div className="nk-box">
              <label htmlFor="nk-borrow"><span>{mode === "borrow" ? "You borrow" : "You repay"}</span></label>
              <div className="nk-row"><input id="nk-borrow" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span className="nk-token" data-static="true"><Coin t={USDG_TOKEN} />USDG</span></div>
              <div className="nk-sub"><span>{mode === "borrow" ? "From the Noren lender pool" : `Owed ${fmtUnits(pos.debt, 6, 2)} USDG`}</span><span>{mode === "borrow" ? <>Available <button type="button" onClick={() => setAmount(String(Number(room) / 1e6))}>{fmtUnits(room, 6, 2)}</button></> : <>Wallet {fmtUnits(usdg, 6, 2)}</>}</span></div>
            </div>
            <dl className="nk-rows">
              <dt>Collateral (Chainlink)</dt><dd>${fmtUnits(pos.collateral8, 8, 2)}</dd>
              <dt>Debt</dt><dd>{fmtUnits(pos.debt, 6, 2)} → <b>{fmtUnits(after, 6, 2)}</b> USDG</dd>
              <dt>Health factor</dt><dd className={tone(hfAfter ?? hf)}>{hf === null ? "∞" : hf.toFixed(2)}{amt ? ` → ${hfAfter === null ? "∞" : hfAfter.toFixed(2)}` : ""}</dd>
              <dt>Liquidates at</dt><dd>health 1.00 ({(pos.liqLtvBps / 100).toFixed(0)}% LTV)</dd>
              {rows?.filter((v) => v.locked > 0n).map((v) => <Fragment key={v.vault}><dt>{v.sym} liquidation price</dt><dd className="warn">{pos.liq[v.vault] ? `$${fmtUnits(pos.liq[v.vault], 8, 2)}` : "none at this debt"}</dd></Fragment>)}
            </dl>
            {note && <div className={note.bad ? "nk-err" : "nk-note"} role="status">{note.t}</div>}
            <button className="nk-cta" disabled={!!busy || !amt || over} onClick={() => run(mode, async (x) => {
              if (mode === "borrow") { const h = await tx(x, "Borrowing…", { address: borrow, abi: borrowAbi, functionName: "borrow", args: [amt!, x.account.address] }); return `Borrowed ${fmtUnits(amt!, 6, 2)} USDG (tx ${shortHex(h, 6)}).`; }
              const allowance = await x.pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [x.account.address, borrow] });
              if (allowance < amt!) await tx(x, "Approving USDG…", { address: USDG, abi: erc20Abi, functionName: "approve", args: [borrow, maxUint256] });
              const all = amt! >= pos.debt;
              const h = await tx(x, "Repaying…", { address: borrow, abi: borrowAbi, functionName: "repay", args: [x.account.address, all ? maxUint256 : amt!] });
              return `Repaid${all ? " in full" : ""} (tx ${shortHex(h, 6)}).${all ? " A fully repaid loan counts toward your reputation." : ""}`;
            })}>{busy === mode ? <><Spin /> {mode === "borrow" ? "Borrowing…" : "Repaying…"}</> : !amt ? "Enter an amount" : over ? (mode === "borrow" ? "Above your borrow limit" : "Not enough USDG") : mode === "borrow" ? `Borrow ${fmtUnits(amt, 6, 2)} USDG` : `Repay ${fmtUnits(amt, 6, 2)} USDG`}</button>
          </>
        )}
      </section>

      <Card title="Collateral" sub="Earn receipt shares you lock here back your loan; unlocked shares keep earning in your wallet">
        <div className="nk-pad">
          {!rows ? <Skel rows={2} /> : rows.every((v) => v.shares === 0n && v.locked === 0n) ? <Empty title="No receipt shares yet" text="Deposit in Earn first; your nNVDA, nETH… shares are the collateral."><a className="nk-btn ink" href="#/app/earn" style={{ marginTop: 12 }}>Go to Earn</a></Empty> : (
            <ul className="nk-items">
              {rows.filter((v) => v.shares > 0n || v.locked > 0n).map((v) => {
                const t = TOKENS.find((x) => x.sym === v.sym);
                const a = parseAmount(lockAmt[v.vault] ?? "", v.decimals);
                return (
                  <li key={v.vault} style={{ flexWrap: "wrap" }}>
                    {t && <Coin t={t} />}
                    <div><b>{v.shareSym}</b><small>{fmtUnits(v.locked, v.decimals, 4)} locked · {fmtUnits(v.shares, v.decimals, 4)} in wallet</small></div>
                    <input className="nk-search" style={{ width: 110, minHeight: 44 }} inputMode="decimal" placeholder="0" aria-label={`${v.shareSym} amount`} value={lockAmt[v.vault] ?? ""} onChange={(e) => setLockAmt((m) => ({ ...m, [v.vault]: e.target.value.replace(/[^0-9.]/g, "") }))} />
                    <button className="nk-btn ink" disabled={!!busy || !a || a > v.shares} onClick={() => run(`lock${v.vault}`, async (x) => {
                      const allowance = await x.pub.readContract({ address: v.vault, abi: erc20Abi, functionName: "allowance", args: [x.account.address, borrow] });
                      if (allowance < a!) await tx(x, `Approving ${v.shareSym}…`, { address: v.vault, abi: erc20Abi, functionName: "approve", args: [borrow, maxUint256] });
                      const h = await tx(x, `Locking ${v.shareSym}…`, { address: borrow, abi: borrowAbi, functionName: "lock", args: [v.vault, a!] });
                      setLockAmt((m) => ({ ...m, [v.vault]: "" })); return `Locked ${fmtUnits(a!, v.decimals, 4)} ${v.shareSym} (tx ${shortHex(h, 6)}).`;
                    })}>{busy === `lock${v.vault}` ? "Locking…" : "Lock"}</button>
                    <button className="nk-btn" disabled={!!busy || !a || a > v.locked} onClick={() => run(`unlock${v.vault}`, async (x) => {
                      const h = await tx(x, `Unlocking ${v.shareSym}…`, { address: borrow, abi: borrowAbi, functionName: "unlock", args: [v.vault, a!, x.account.address] });
                      setLockAmt((m) => ({ ...m, [v.vault]: "" })); return `Unlocked ${fmtUnits(a!, v.decimals, 4)} ${v.shareSym} (tx ${shortHex(h, 6)}).`;
                    })}>Unlock</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
