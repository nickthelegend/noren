/**
 * Honest states for the hosted build (public Arc testnet): Robinhood Chain features point at the demo video and README,
 * and funding goes through Circle's public faucet, then a shield of exactly what the invoice needs, then the ASP check.
 */
import { useEffect, useState } from "react";
import { createPublicClient, erc20Abi, http } from "viem";
import { api, usdc, type Config } from "./api";
import { Copy, msgOf } from "./ui";
import { CIRCLE_FAUCET_URL, FORK_NOTICE, HOSTED, README_URL } from "./hosted";
import { creditOf } from "./onchain";

type Variant = "co" | "nk" | "sd";

/** Robinhood Chain features are off on this build: the hosted build, or a server without the Robinhood fork. */
export const robinhoodOff = (cfg: Config | null) => HOSTED || !creditOf(cfg);

/** A small card for a Robinhood-side feature: it exists, it runs on the local mainnet snapshot, here is where to see it. */
export function SnapshotNotice({ what, detail, variant = "nk" }: { what: string; detail?: string; variant?: Variant }) {
  const text = <>{detail ? `${detail} ` : ""}{FORK_NOTICE}.</>;
  const link = <a href={README_URL} target="_blank" rel="noreferrer">README and demo video ↗</a>;
  if (variant === "nk") return (
    <div className="nk-setup" role="note"><span className="nk-tag">Robinhood snapshot</span><b>{what}</b><p>{text}</p><p>{link}</p></div>
  );
  if (variant === "sd") return (
    <div className="hx-note sd" role="note"><span className="hx-tag">Robinhood snapshot</span><b>{what}</b><p>{text} {link}</p></div>
  );
  return (
    <div className="co-fund" role="note" aria-label={`${what}: Robinhood snapshot`}>
      <span className="hx-tag">Robinhood snapshot</span>
      <p><b>{what}</b> {text}</p>
      <div className="row2"><a className="btn line" href={README_URL} target="_blank" rel="noreferrer">README and demo video ↗</a></div>
    </div>
  );
}

/** Public USDC on Arc (the ERC-20 view of Arc's native USDC, 6 decimals), polled. null until read. */
export function usePublicUsdc(cfg: Config | null, address?: string | null) {
  const [bal, setBal] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!cfg || !address) return;
    let on = true;
    const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
    const read = () => pub.readContract({ address: cfg.deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] })
      .then((b) => { if (on) { setBal(b); setErr(null); } }).catch((e) => on && setErr(msgOf(e)));
    read(); const t = setInterval(read, 6000);
    return () => { on = false; clearInterval(t); };
  }, [cfg, address, tick]);
  return { bal, err, reload: () => setTick((t) => t + 1) };
}

/** "Get test USDC from Circle": the faucet link and the address to paste there. */
export function CircleFaucet({ address, variant = "co", bal, where = "This checkout" }: { address?: string | null; variant?: Variant; bal?: bigint | null; where?: string }) {
  return (
    <>
      <p className={variant === "nk" ? "nk-fine" : "faint sm"}>
        {where} runs on the public Arc testnet. Get free test USDC (it also pays Arc gas) at <a href={CIRCLE_FAUCET_URL} target="_blank" rel="noreferrer">faucet.circle.com</a> → Arc Testnet, sent to your wallet address:
      </p>
      <div className="hx-addr">{address ? <><code>{address}</code><Copy text={address} /></> : <span className="faint">reading your address…</span>}</div>
      {bal !== undefined && <p className={variant === "nk" ? "nk-fine" : "faint sm"}>Wallet on Arc: {bal === null ? "…" : `${usdc(bal)} USDC`}</p>}
    </>
  );
}

/** Kept back for Arc gas (paid in USDC) when shielding: 0.05 USDC. */
export const GAS_RESERVE = 50_000n;
/** What to shield for an invoice: the shortfall, rounded up to whole cents. */
export const shieldNeeded = (amount: bigint, have: bigint) => { const d = amount - have; return d <= 0n ? 0n : ((d + 9_999n) / 10_000n) * 10_000n; };

type FundWallet = { address: `0x${string}`; shield: (n: bigint) => Promise<unknown>; balances: () => Promise<{ approved: bigint; pending: bigint }> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fund a private payment on the public Arc testnet: Circle faucet → shield exactly the shortfall → ask the ASP postman to
 * approve the deposit now (POST /asp/sync) → wait until the approved private balance covers the invoice.
 */
export function HostedTopUp({ cfg, amount, bal, getWallet, onChange, variant = "co" }: {
  cfg: Config; amount: bigint; bal: { approved: bigint; pending: bigint } | null;
  getWallet: () => Promise<FundWallet>; onChange: () => void; variant?: "co" | "nk";
}) {
  const [addr, setAddr] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const [asp, setAsp] = useState<null | "waiting" | "slow" | "failed">(null);
  const [note, setNote] = useState<{ t: string; bad?: boolean } | null>(null);
  useEffect(() => { getWallet().then((w) => setAddr(w.address)).catch((e) => setNote({ t: msgOf(e), bad: true })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pub = usePublicUsdc(cfg, addr);
  const approved = bal?.approved ?? 0n, pending = bal?.pending ?? 0n;
  const need = shieldNeeded(amount, approved + pending);
  const screening = pending > 0n && approved < amount;
  const canShield = need > 0n && pub.bal !== null && pub.bal >= need + GAS_RESERVE;

  const waitForAsp = async () => {
    setAsp("waiting"); setNote(null);
    try { await api.aspSync(); } catch (e) { setAsp("failed"); setNote({ t: `Compliance check (ASP): ${msgOf(e)}`, bad: true }); return; }
    const w = await getWallet();
    for (let i = 0; i < 30; i++) {
      try { const b = await w.balances(); if (b.approved >= amount) { setAsp(null); setNote({ t: "Approved: your private balance covers this payment." }); onChange(); return; } } catch { /* retry */ }
      await sleep(4000);
    }
    setAsp("slow"); onChange();
  };
  const shield = async () => {
    setBusy(true); setNote(null);
    try { const w = await getWallet(); await w.shield(need); pub.reload(); onChange(); await waitForAsp(); }
    catch (e) { setNote({ t: msgOf(e), bad: true }); } finally { setBusy(false); }
  };

  const nk = variant === "nk";
  const btn = nk ? "nk-btn" : "btn line";
  const label = need > 0n ? `Shield ${usdc(need)} USDC` : "Shield";
  const status = asp === "waiting" ? "Waiting for the compliance check (ASP)…" : asp === "slow" ? "The compliance check (ASP) hasn't approved the deposit yet." : asp === "failed" ? "The compliance check (ASP) didn't answer." : screening ? `${usdc(pending)} USDC is waiting for the compliance check (ASP).` : null;
  const short = pub.bal !== null && need > 0n && !canShield ? `Your wallet holds ${usdc(pub.bal)} USDC: shielding ${usdc(need)} needs ${usdc(need + GAS_RESERVE)} with the 0.05 USDC gas reserve.` : null;
  return (
    <div className={nk ? "nk-setup" : "co-fund"} role="group" aria-label="Add funds to your private balance">
      {nk && <span className="nk-tag">Top up first</span>}
      <p>{nk ? <b>Your private balance is {usdc(approved)} USDC.</b> : <><b>Add funds to your private balance.</b> It holds {usdc(approved)} USDC; this payment needs {usdc(amount)}.</>}</p>
      <CircleFaucet address={addr} variant={nk ? "nk" : "co"} bal={pub.bal} />
      <p className={nk ? "nk-fine" : "faint sm"}>Then shield it: it moves into the privacy pool and a compliance check (ASP) approves it.</p>
      {short && <p className={nk ? "nk-fine" : "faint sm"}>{short}</p>}
      <div className="row2 hx-row">
        <a className={btn} href={CIRCLE_FAUCET_URL} target="_blank" rel="noreferrer">{!nk && <span className="n">1</span>} Open the Circle faucet ↗</a>
        {status && !busy ? <button className={btn} disabled={asp === "waiting"} onClick={waitForAsp}>{asp === "waiting" ? <><span className={nk ? "nk-spin" : "spin"} /> Checking…</> : "Retry the compliance check"}</button>
          : <button className={nk ? "nk-btn ink" : "btn line"} disabled={busy || !canShield} onClick={shield}>{busy ? <><span className={nk ? "nk-spin" : "spin"} /> {asp === "waiting" ? "Checking…" : "Shielding…"}</> : <>{!nk && <span className="n">2</span>} {label}</>}</button>}
      </div>
      {status && <p className={nk ? "nk-note" : "note"} role="status">{asp === "waiting" && <span className={nk ? "nk-spin" : "spin xs"} />} {status}</p>}
      {pub.err && <p className={nk ? "nk-err" : "err"}>Couldn't read your Arc balance: {pub.err}</p>}
      {note && <p className={note.bad ? (nk ? "nk-err" : "err") : (nk ? "nk-note" : "note")}>{note.t}</p>}
    </div>
  );
}
