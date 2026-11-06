/**
 * One link for every transaction Noren shows, and the in-app page for transactions on a local fork.
 * - Arc testnet (live): https://explorer.testnet.arc.io/tx/<hash>
 * - Robinhood Chain mainnet reads: https://robinhoodchain.blockscout.com/tx/<hash>
 * - Local forks have no public explorer, so the link opens #/tx/<chain>/<hash> in a new tab: this page reads the receipt
 *   from that fork's RPC and decodes Noren, Aqua, Kohaku and ERC-20 events.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPublicClient, decodeEventLog, erc20Abi, formatUnits, http, parseAbi, toEventSelector, type Abi, type Address, type Hex, type Log } from "viem";
import { api, short, type Config } from "./api";
import { Copy, Icon, Logo, isFork, msgOf } from "./ui";
import { creditOf } from "./onchain";
import { HOSTED } from "./hosted";
import { TOKENS } from "./app/tokens";
import { EVENTS } from "./tx-events";
import { Mark } from "./logos";
import { PERMIT2, UNIVERSAL_ROUTER, V4_QUOTER } from "./app/swap";
import { privateKeyToAccount } from "viem/accounts";
import { activeAccount, activeMode } from "./signer";

export type TxChain = "arc" | "robinhood" | "arc-live" | "robinhood-mainnet";
export const ARC_EXPLORER = "https://explorer.testnet.arc.io";
export const ROBINHOOD_EXPLORER = "https://robinhoodchain.blockscout.com";

/** Where a transaction opens. `cfg` decides whether "arc" is the local fork or a real network. */
export function txHref(chain: TxChain, hash: string, cfg?: Config | null) {
  if (chain === "arc-live" || (chain === "arc" && (HOSTED || (cfg && !isFork(cfg))))) return { href: `${ARC_EXPLORER}/tx/${hash}`, local: false, where: "Arc testnet explorer" };
  if (chain === "robinhood-mainnet") return { href: `${ROBINHOOD_EXPLORER}/tx/${hash}`, local: false, where: "Robinhood Chain explorer" };
  return { href: `${location.origin}${location.pathname}#/tx/${chain}/${hash}`, local: true, where: `local ${chain === "arc" ? "Arc" : "Robinhood"} fork transaction page` };
}

/**
 * The transaction link used everywhere: short hash, opens in a new tab. `explorer` (a public testnet's explorer base
 * URL, e.g. a CCTP or CCIP source chain) takes precedence over `chain`.
 */
export function TxLink({ chain = "arc", explorer, where, hash, cfg, n = 6, children }: { chain?: TxChain; explorer?: string; where?: string; hash?: string | null; cfg?: Config | null; n?: number; children?: ReactNode }) {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return hash ? <span className="mono faint">{short(hash, n)}</span> : <span className="faint">–</span>;
  const t = explorer ? { href: `${explorer}/tx/${hash}`, where: where ?? "explorer" } : txHref(chain, hash, cfg);
  return (
    <a className="tx-link" href={t.href} target="_blank" rel="noreferrer" title={`${hash}: opens the ${t.where} in a new tab`} onClick={(e) => e.stopPropagation()}>
      {children ?? short(hash, n)}<Icon.ext />
    </a>
  );
}

/* ------------------------------------------------------------------ the local fork transaction page */

// OpenZeppelin ERC-4626 and WETH9 events, and Uniswap v4's Swap, which Noren's sources inherit or call but don't declare.
const EXTRA = [
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
];
type Item = { abi: Abi; sig: string };
const BY_TOPIC = (() => {
  const m = new Map<string, Item[]>();
  for (const text of [...EVENTS, ...EXTRA]) {
    try { const abi = parseAbi([text]) as Abi; const topic = toEventSelector(text.replace(/^event /, "")).toLowerCase(); m.set(topic, [...(m.get(topic) ?? []), { abi, sig: text }]); } catch { /* a type viem can't parse is skipped, its logs show raw */ }
  }
  return m;
})();

const NAMES: Record<string, string> = {
  checkout: "NorenCheckout", pool: "Privacy pool (Kohaku)", entrypoint: "Privacy Pools entrypoint", usdc: "USDC", oracle: "NorenRateOracle", rateOracle: "NorenRateOracle",
  creditLine: "NorenCreditLine", creditContract: "NorenCredit", credit: "NorenCredit", gateway: "NorenGateway", stockOracle: "NorenAssetOracle", vault: "NorenVault",
  settlementDesk: "NorenSettlementDesk", aquaLiquidity: "NorenLiquidity", aqua: "1inch Aqua", router: "SwapVM router", borrow: "NorenBorrow", reputation: "NorenReputation",
};
type Who = { name: string; logo?: string; token?: { sym: string; decimals: number } };

function directory(cfg: Config, chain: "arc" | "robinhood") {
  const d = new Map<string, Who>();
  const put = (a: unknown, w: Who) => { if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !d.has(a.toLowerCase())) d.set(a.toLowerCase(), w); };
  if (chain === "arc") {
    put(cfg.deployment.usdc, { name: "USDC", logo: "USDC", token: { sym: "USDC", decimals: 6 } });
    for (const [k, v] of Object.entries(cfg.deployment)) put(v, { name: NAMES[k] ?? k });
    put(creditOf(cfg)?.creditLine, { name: "NorenCreditLine" });
    put(cfg.merchant, { name: "Merchant (this store)" });
  } else {
    for (const t of TOKENS) put(t.address, { name: t.native ? "WETH" : t.sym, logo: t.native ? "WETH" : t.sym, token: { sym: t.native ? "WETH" : t.sym, decimals: t.decimals } });
    const c = creditOf(cfg) ?? {};
    for (const [k, v] of Object.entries(c)) {
      if (k === "creditLine") continue; // Arc side
      if (k === "depositVaults" && Array.isArray(v)) { for (const x of v as { asset: string; vault: string }[]) { const s = TOKENS.find((t) => t.address.toLowerCase() === x.asset.toLowerCase())?.sym ?? "asset"; put(x.vault, { name: `NorenDepositVault (${s})`, logo: s }); } continue; }
      put(v, { name: NAMES[k] ?? k });
    }
    put("0x8366a39CC670B4001A1121B8F6A443A643e40951", { name: "Uniswap v4 PoolManager", logo: "UNISWAP" });
    put(UNIVERSAL_ROUTER, { name: "Uniswap Universal Router", logo: "UNISWAP" });
    put(PERMIT2, { name: "Permit2", logo: "UNISWAP" });
    put(V4_QUOTER, { name: "Uniswap v4 Quoter", logo: "UNISWAP" });
  }
  // The customer's test key lives in this browser (see onchain.ts): name it instead of showing a bare address.
  try { const k = JSON.parse(localStorage.getItem("noren.customer.v1") ?? "null")?.gasKey; if (k) put(privateKeyToAccount(k).address, { name: "You (this browser's test key)" }); } catch { /* no key in this browser */ }
  if (activeMode() === "privy") put(activeAccount().address, { name: "You (your Noren wallet)" });
  return d;
}

type Decoded = { log: Log; name?: string; sig?: string; args?: Record<string, unknown> };
type Loaded = {
  chainId: number; rpc: string; status: "success" | "reverted"; block: bigint; time?: number; from: Address; to: Address | null; created?: Address | null;
  value: bigint; gasUsed: bigint; gasLimit: bigint; price: bigint; nonce: number; logs: Decoded[]; dir: Map<string, Who>;
};

async function load(chain: "arc" | "robinhood", hash: Hex): Promise<Loaded> {
  let cfg: Config;
  try { cfg = await api.config(); } catch (e) { throw new Error(`Setup required: ${msgOf(e)}`); }
  const rpc = chain === "arc" ? cfg.rpcUrl : creditOf(cfg)?.robinhoodRpc;
  if (!rpc) throw new Error("Setup required: the Robinhood fork isn't running on this stack. Start everything with pnpm dev:all");
  const pub = createPublicClient({ transport: http(rpc, { timeout: 30_000 }) });
  const [rc, tx, chainId] = await Promise.all([
    pub.getTransactionReceipt({ hash }).catch((e) => { throw new Error(/could not be found|not found/i.test(msgOf(e)) ? `No transaction ${short(hash, 8)} on this ${chain === "arc" ? "Arc" : "Robinhood"} fork (${rpc}). A fork restarted since the payment forgets its transactions.` : `Can't read the fork at ${rpc}: ${msgOf(e)}`); }),
    pub.getTransaction({ hash }),
    pub.getChainId(),
  ]);
  const blk = await pub.getBlock({ blockNumber: rc.blockNumber }).catch(() => null);
  const dir = directory(cfg, chain);
  // ERC-20s this page doesn't know yet: read symbol and decimals from the fork.
  const unknown = [...new Set(rc.logs.filter((l) => l.topics[0]?.toLowerCase() === toEventSelector("Transfer(address,address,uint256)") && !dir.has(l.address.toLowerCase())).map((l) => l.address))];
  await Promise.all(unknown.map(async (a) => {
    try { const [sym, dec] = await Promise.all([pub.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }), pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals" })]); dir.set(a.toLowerCase(), { name: sym, logo: sym, token: { sym, decimals: dec } }); } catch { /* stays an address */ }
  }));
  const logs: Decoded[] = rc.logs.map((log) => {
    for (const it of BY_TOPIC.get(log.topics[0]?.toLowerCase() ?? "") ?? []) {
      try { const r = decodeEventLog({ abi: it.abi, data: log.data, topics: log.topics }); return { log, name: r.eventName, sig: it.sig, args: (r.args ?? {}) as Record<string, unknown> }; } catch { /* next candidate */ }
    }
    return { log };
  });
  return { chainId, rpc, status: rc.status, block: rc.blockNumber, time: blk ? Number(blk.timestamp) : undefined, from: rc.from, to: rc.to, created: rc.contractAddress, value: tx.value, gasUsed: rc.gasUsed, gasLimit: tx.gas, price: rc.effectiveGasPrice, nonce: tx.nonce, logs, dir };
}

function Addr({ a, dir }: { a: string; dir: Map<string, Who> }) {
  const w = dir.get(a.toLowerCase());
  return (
    <span className="tx-addr">
      {w?.logo && <Mark id={w.logo} size={16} />}
      {w && <b>{w.name}</b>}
      <span className="mono" title={a}>{w ? short(a, 6) : a}</span>
    </span>
  );
}

/** Amounts: ERC-20 values in their token, Noren's *Usdc6 / *Usdg / *Usd8 fields in their unit, everything else raw. */
function Val({ k, v, d, dir }: { k: string; v: unknown; d: Decoded; dir: Map<string, Who> }) {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return <Addr a={v} dir={dir} />;
  if (typeof v === "bigint") {
    const tok = dir.get(d.log.address.toLowerCase())?.token;
    if (tok && ["Transfer", "Approval", "Deposit", "Withdrawal"].includes(d.name ?? "") && /^(value|wad|amount)$/.test(k)) return <span className="tx-amt"><Mark id={tok.sym} size={16} /><b>{fmtAmt(v, tok.decimals)}</b> {tok.sym}</span>;
    const unit = /usdc6$/i.test(k) ? ["USDC", 6] : /usdg6?$/i.test(k) ? ["USDG", 6] : /usd8$/i.test(k) ? ["USD", 8] : null;
    if (unit) return <span className="tx-amt">{unit[0] !== "USD" && <Mark id={String(unit[0])} size={16} />}<b>{fmtAmt(v, Number(unit[1]))}</b> {unit[0]}</span>;
    return <span className="mono">{v.toString()}</span>;
  }
  if (Array.isArray(v)) return <span className="mono">[{v.map(String).join(", ")}]</span>;
  return <span className={typeof v === "number" || typeof v === "boolean" ? "mono" : "mono tx-raw"}>{String(v)}</span>;
}
const fmtAmt = (v: bigint, dec: number) => { const s = formatUnits(v, dec); const n = Number(s); return Math.abs(n) >= 1e15 ? s : n.toLocaleString("en-US", { maximumFractionDigits: dec > 6 ? 6 : dec }); };

export function TxPage({ chain, hash }: { chain: string; hash: string }) {
  const ok = (chain === "arc" || chain === "robinhood") && /^0x[0-9a-fA-F]{64}$/.test(hash);
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!ok) return;
    let on = true; setData(null); setErr(null);
    load(chain as "arc" | "robinhood", hash as Hex).then((d) => on && setData(d)).catch((e) => on && setErr(msgOf(e)));
    return () => { on = false; };
  }, [chain, hash, ok]);
  useEffect(() => { document.title = `Local fork transaction ${short(hash, 6)} · Noren`; }, [hash]);
  const chainName = chain === "arc" ? "Arc testnet fork" : "Robinhood Chain fork";
  const fee = useMemo(() => (data ? data.gasUsed * data.price : 0n), [data]);

  return (
    <div className="tx-page">
      <header className="tx-top">
        <a className="site-brand" href="#/"><Logo /><span>Noren</span></a>
        <span className="tx-chain"><Mark id={chain === "arc" ? "ARC" : "ROBINHOOD"} size={20} />{chainName}</span>
      </header>
      <main className="tx-main">
        <span className="eyebrow">Local fork transaction</span>
        <h1 className="tx-h">{data ? (data.status === "success" ? "Succeeded" : "Reverted") : err ? "Can't show this transaction" : ok ? "Reading the receipt…" : "Not a transaction link"}</h1>
        <div className="tx-hash"><span className="mono">{hash}</span>{ok && <Copy text={hash} label="Copy hash" />}</div>
        <p className="tx-note">A local Anvil fork has no public explorer, so Noren reads this receipt straight from the fork's RPC{data ? <> (<span className="mono">{data.rpc}</span>, chain {data.chainId})</> : null}. Nothing here exists on a public network.</p>

        {!ok ? <div className="tx-err" role="alert">The link should look like <span className="mono">#/tx/arc/0x…</span> or <span className="mono">#/tx/robinhood/0x…</span> with a 32-byte hash.</div>
          : err ? <div className="tx-err" role="alert"><b>{/^Setup required/.test(err) ? "Setup required" : "Not found"}</b><p>{err.replace(/^Setup required:\s*/, "")}</p>{/^Setup required/.test(err) && <pre>pnpm dev:all{"\n"}pnpm --filter @noren/web dev</pre>}</div>
          : !data ? <div className="tx-card"><div className="tx-skel"><i /><i /><i /><i /></div></div>
          : <>
            <section className="tx-card" aria-label="Overview">
              <dl className="tx-kv">
                <dt>Status</dt><dd><span className={`pill ${data.status === "success" ? "moss" : "rust"}`}>{data.status === "success" ? "Success" : "Reverted"}</span></dd>
                <dt>Block</dt><dd><span className="mono">{data.block.toString()}</span>{data.time ? <span className="faint"> · {new Date(data.time * 1000).toLocaleString()}</span> : null}</dd>
                <dt>From</dt><dd><Addr a={data.from} dir={data.dir} /></dd>
                <dt>{data.created ? "Created" : "To"}</dt><dd>{data.created ? <Addr a={data.created} dir={data.dir} /> : data.to ? <Addr a={data.to} dir={data.dir} /> : "–"}</dd>
                {data.value > 0n && <><dt>Value</dt><dd className="tx-amt"><Mark id={chain === "arc" ? "USDC" : "ETH"} size={16} /><b>{fmtAmt(data.value, 18)}</b> {chain === "arc" ? "USDC (native, 18 decimals)" : "ETH"}</dd></>}
                <dt>Gas used</dt><dd><span className="mono">{data.gasUsed.toLocaleString()}</span><span className="faint"> of {data.gasLimit.toLocaleString()} · nonce {data.nonce}</span></dd>
                <dt>Fee</dt><dd><span className="mono">{fmtAmt(fee, 18)}</span> {chain === "arc" ? "USDC (Arc gas)" : "ETH"}<span className="faint"> at {fmtAmt(data.price, 9)} gwei</span></dd>
              </dl>
            </section>
            <section className="tx-card" aria-label="Events">
              <div className="tx-card-h"><b>Events</b><span className="pill grey">{data.logs.length}</span></div>
              {!data.logs.length ? <p className="faint sm" style={{ margin: 0 }}>{data.status === "success" ? "This transaction emitted no events." : "A reverted transaction keeps no events."}</p> : (
                <ol className="tx-logs">
                  {data.logs.map((d, i) => (
                    <li key={i}>
                      <div className="tx-log-h"><span className="tx-i">{d.log.logIndex ?? i}</span><b>{d.name ?? "Unknown event"}</b><span className="tx-from">emitted by <Addr a={d.log.address} dir={data.dir} /></span></div>
                      {d.args ? (
                        <dl className="tx-args">{Object.entries(d.args).map(([k, v]) => <div key={k}><dt>{k.replace(/^_/, "")}</dt><dd><Val k={k} v={v} d={d} dir={data.dir} /></dd></div>)}</dl>
                      ) : <p className="tx-raw mono">topic0 {d.log.topics[0] ?? "(anonymous)"} · {(d.log.data.length - 2) / 2} bytes of data</p>}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>}
      </main>
      <footer className="tx-foot faint sm">Test networks only. Opened from Noren in a new tab.</footer>
    </div>
  );
}
