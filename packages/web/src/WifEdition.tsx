import { useCallback, useEffect, useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, erc20Abi, formatUnits, http, parseAbi, parseAbiItem, parseUnits, toHex, type Address, type Hex } from "viem";

const WIF: Address = "0x5173b8eA6923c2d40267890D45C46a3480954773";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const gatewayAbi = parseAbi([
  "function createInvoice(bytes32 invoiceId,uint128 amountUsdg,uint64 expiry)",
  "function invoice(address merchant,bytes32 invoiceId) view returns ((uint128 amountUsdg,uint64 expiry,uint8 status,address payer,address asset,uint256 assetIn))",
  "function quote(address merchant,bytes32 invoiceId,address asset) view returns (uint256 assetIn,uint256 priceUsd8,bool marketClosed)",
  "function pay(bytes32 invoiceId,address merchant,address asset,uint256 maxAssetIn) payable returns (uint256 assetIn)",
  "function totalWifBurned() view returns (uint256)",
  "function accruedUsdg() view returns (uint256)",
  "function burnThresholdUsdg() view returns (uint256)",
  "function burnAccrued(uint256 minWifOut) returns (uint256)",
  "function wifRouter() view returns (address)",
]);
const routerAbi = parseAbi(["function quoteWifFromUsdg(uint256 amountUsdg) view returns (uint256)"]);
const burnedEvent = parseAbiItem("event WifBurned(bytes32 indexed invoiceId,uint256 usdgIn,uint256 wifBurned)");
const createdEvent = parseAbiItem("event InvoiceCreated(address indexed merchant,bytes32 indexed invoiceId,uint256 amountUsdg,uint64 expiry)");
type Config = { edition: "wif"; chainId: number; rpcUrl: string; gateway: Address | null; fromBlock: string };
type Burn = { tx: Hex; usdg: bigint; wif: bigint };
type Invoice = { amountUsdg: bigint; expiry: bigint; status: number; payer: Address; asset: Address; assetIn: bigint };
const explorer = (tx: Hex) => `https://robinhoodchain.blockscout.com/tx/${tx}`;
const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-6)}`;
const errorText = (e: unknown) => e instanceof Error ? e.message.split("\n")[0] : String(e);

export function WifEdition() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [burned, setBurned] = useState<bigint>(0n);
  const [accrued, setAccrued] = useState<bigint>(0n);
  const [threshold, setThreshold] = useState<bigint>(0n);
  const [burns, setBurns] = useState<Burn[]>([]);
  const [invoices, setInvoices] = useState<{ id: Hex; amount: bigint; tx: Hex }[]>([]);
  const [amount, setAmount] = useState("25");
  const [merchant, setMerchant] = useState<Address | null>(null);
  const [invoiceId, setInvoiceId] = useState<Hex | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [asset, setAsset] = useState<Address>(WIF);
  const [stockEligible, setStockEligible] = useState(false);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [tx, setTx] = useState<Hex | null>(null);

  useEffect(() => {
    const url = (import.meta.env.VITE_NOREN_API as string | undefined) ?? "http://127.0.0.1:8790";
    fetch(`${url}/config`).then(r => r.json()).then(setCfg).catch(() => setNote(`Start the WIF server at ${url}`));
  }, []);
  const rpc = cfg ? createPublicClient({ chain, transport: http((import.meta.env.VITE_NOREN_RH_RPC as string | undefined) || cfg.rpcUrl) }) : null;
  const addr = cfg?.gateway;
  const route = location.hash.match(/^#\/pay\/(0x[a-fA-F0-9]{40})\/(0x[a-fA-F0-9]{64})/);
  useEffect(() => { if (route) { setMerchant(route[1] as Address); setInvoiceId(route[2] as Hex); } }, [location.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    if (!rpc || !addr) return;
    const latest = await rpc.getBlockNumber();
    const from = BigInt(cfg?.fromBlock || "0");
    const logsFrom = from > latest - (latest > 40_000n ? 40_000n : latest) ? from : latest - (latest > 40_000n ? 40_000n : latest);
    const [total, pending, min, burnLogs, created] = await Promise.all([
      rpc.readContract({ address: addr, abi: gatewayAbi, functionName: "totalWifBurned" }),
      rpc.readContract({ address: addr, abi: gatewayAbi, functionName: "accruedUsdg" }),
      rpc.readContract({ address: addr, abi: gatewayAbi, functionName: "burnThresholdUsdg" }),
      rpc.getLogs({ address: addr, event: burnedEvent, fromBlock: logsFrom, toBlock: latest }),
      account ? rpc.getLogs({ address: addr, event: createdEvent, args: { merchant: account }, fromBlock: logsFrom, toBlock: latest }) : Promise.resolve([]),
    ]);
    setBurned(total); setAccrued(pending); setThreshold(min);
    setBurns(burnLogs.slice(-10).reverse().map(l => ({ tx: l.transactionHash, usdg: l.args.usdgIn ?? 0n, wif: l.args.wifBurned ?? 0n })));
    setInvoices(created.slice(-12).reverse().map(l => ({ id: l.args.invoiceId!, amount: l.args.amountUsdg!, tx: l.transactionHash })));
    if (merchant && invoiceId) setInvoice(await rpc.readContract({ address: addr, abi: gatewayAbi, functionName: "invoice", args: [merchant, invoiceId] }) as Invoice);
  }, [cfg?.rpcUrl, cfg?.fromBlock, addr, account, merchant, invoiceId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { refresh().catch(e => setNote(errorText(e))); const t = setInterval(() => refresh().catch(() => {}), 12_000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    if (!rpc || !addr || !merchant || !invoiceId || !invoice || invoice.status !== 1) { setQuote(null); return; }
    rpc.readContract({ address: addr, abi: gatewayAbi, functionName: "quote", args: [merchant, invoiceId, asset] }).then(x => setQuote(x[0])).catch(e => setNote(errorText(e)));
  }, [cfg?.rpcUrl, addr, merchant, invoiceId, invoice?.status, asset]); // eslint-disable-line react-hooks/exhaustive-deps

  const wallet = async () => {
    const provider = (window as typeof window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!provider) throw new Error("Connect an EVM wallet to Robinhood Chain");
    const [me] = await provider.request({ method: "eth_requestAccounts" }) as Address[];
    const id = await provider.request({ method: "eth_chainId" });
    if (Number(id) !== 4663) throw new Error("Switch your wallet to Robinhood Chain (4663)");
    setAccount(me);
    return { me, client: createWalletClient({ chain, transport: custom(provider), account: me }) };
  };
  const run = async (f: () => Promise<void>) => { setBusy(true); setNote(""); try { await f(); await refresh(); } catch (e) { setNote(errorText(e)); } finally { setBusy(false); } };
  const create = () => run(async () => {
    if (!addr || !rpc) throw new Error("Gateway address is not configured");
    const { me, client } = await wallet();
    const id = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const value = parseUnits(amount, 6);
    if (value <= 0n) throw new Error("Enter a USDG amount");
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 86400);
    const hash = await client.writeContract({ address: addr, abi: gatewayAbi, functionName: "createInvoice", args: [id, value, expiry] });
    await rpc.waitForTransactionReceipt({ hash });
    setMerchant(me); setInvoiceId(id); location.hash = `#/pay/${me}/${id}`; setTx(hash);
  });
  const pay = () => run(async () => {
    if (!addr || !rpc || !merchant || !invoiceId || quote === null) throw new Error("Invoice is not ready");
    if (asset === NVDA && !stockEligible) throw new Error("Confirm Stock Token eligibility first");
    const { me, client } = await wallet();
    const max = quote * 105n / 100n + 1n;
    if (asset !== ZERO) {
      const allowance = await rpc.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [me, addr] });
      if (allowance < max) { const approval = await client.writeContract({ address: asset, abi: erc20Abi, functionName: "approve", args: [addr, max] }); await rpc.waitForTransactionReceipt({ hash: approval }); }
    }
    const hash = await client.writeContract({ address: addr, abi: gatewayAbi, functionName: "pay", args: [invoiceId, merchant, asset, max], value: asset === ZERO ? max : 0n });
    await rpc.waitForTransactionReceipt({ hash }); setTx(hash); await refresh();
  });
  const burn = () => run(async () => {
    if (!addr || !rpc) throw new Error("Gateway address is not configured");
    const { client } = await wallet();
    const router = await rpc.readContract({ address: addr, abi: gatewayAbi, functionName: "wifRouter" });
    const minOut = await rpc.readContract({ address: router, abi: routerAbi, functionName: "quoteWifFromUsdg", args: [accrued] });
    const hash = await client.writeContract({ address: addr, abi: gatewayAbi, functionName: "burnAccrued", args: [minOut] });
    await rpc.waitForTransactionReceipt({ hash }); setTx(hash);
  });
  const item = merchant && invoiceId;
  const link = item ? `${location.origin}/#/pay/${merchant}/${invoiceId}` : "";

  return <div className="site">
    <header className="site-nav solid"><a className="site-brand" href="#/">Noren</a><nav className="mono"><a href="#/">Merchant</a><a href="https://github.com/nickthelegend/noren" target="_blank" rel="noreferrer">GitHub</a></nav><button className="lx-btn light sm" onClick={() => run(async () => { await wallet(); })}>{account ? short(account) : "Connect wallet"}</button></header>
    <main style={{ maxWidth: 920, margin: "90px auto 60px", padding: 24 }}>
      <p className="eyebrow">World is Flat edition · Robinhood Chain</p>
      <h1>Noren · Pay in anything, settle in USDG</h1>
      <p>Noren lets merchants get paid in USDG while customers pay with Stock Tokens, ETH, USDG or $WIF. Every non-WIF payment funds a $WIF burn. Paying in $WIF waives the protocol fee.</p>
      {!addr && <p role="alert">Set NOREN_WIF_GATEWAY on the WIF server after deploying to a local fork or mainnet.</p>}
      <section className="co-credit"><h2>Burn flywheel</h2><p><b>{formatUnits(burned, 18)} WIF</b> burned by Noren · {formatUnits(accrued, 6)} USDG accrued</p><button className="btn line" disabled={busy || accrued < threshold || !addr} onClick={burn}>Burn accrued fees · keeper tip</button><h3>Recent burns</h3>{burns.length ? <ul>{burns.map(x => <li key={x.tx}>{formatUnits(x.wif, 18)} WIF from {formatUnits(x.usdg, 6)} USDG · <a href={explorer(x.tx)} target="_blank" rel="noreferrer">{short(x.tx)}</a></li>)}</ul> : <p>No Noren burns on this deployment yet.</p>}</section>
      <section className="co-credit"><h2>Create an invoice</h2><label>Amount in USDG <input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label><button className="btn kaki" disabled={busy || !addr} onClick={create}>Create on Robinhood Chain</button><h3>Your recent invoices</h3>{invoices.length ? <ul>{invoices.map(x => <li key={x.id}><a href={`#/pay/${account}/${x.id}`} onClick={() => { setMerchant(account); setInvoiceId(x.id); }}>{formatUnits(x.amount, 6)} USDG · {short(x.id)}</a> · <a href={explorer(x.tx)} target="_blank" rel="noreferrer">create tx</a></li>)}</ul> : <p>Connect a wallet to see its invoices.</p>}</section>
      {item && <section className="co-credit"><h2>{invoice?.status === 2 ? "Receipt" : "Pay invoice"}</h2><p>{invoice ? `${formatUnits(invoice.amountUsdg, 6)} USDG · ${invoice.status === 2 ? "paid" : invoice.status === 1 ? "open" : "closed"}` : "Loading invoice…"}</p><p><a href={link}>Payment link</a> <button className="btn line" onClick={() => navigator.clipboard.writeText(link)}>Copy</button></p>{invoice?.status === 1 && <><label>Pay with <select value={asset} onChange={e => setAsset(e.target.value as Address)}><option value={WIF}>$WIF · fee waived</option><option value={USDG}>USDG</option><option value={ZERO}>ETH</option><option value={NVDA}>NVDA Stock Token</option></select></label>{asset === NVDA && <label><input type="checkbox" checked={stockEligible} onChange={e => setStockEligible(e.target.checked)} /> I am eligible to use Stock Tokens under the issuer’s <a href="https://docs.robinhood.com/rhj/restricted-jurisdictions/" target="_blank" rel="noreferrer">restricted-jurisdiction list</a>.</label>}<p>Live quote: {quote === null ? "…" : formatUnits(quote, asset === USDG ? 6 : 18)} {asset === WIF ? "WIF" : asset === USDG ? "USDG" : asset === ZERO ? "ETH" : "NVDA"}</p><button className="btn kaki" disabled={busy || quote === null || (asset === NVDA && !stockEligible)} onClick={pay}>Pay invoice</button></>}{invoice?.status === 2 && <p>Paid with {invoice.asset === WIF ? "$WIF" : invoice.asset === USDG ? "USDG" : invoice.asset === ZERO ? "ETH" : "a Stock Token"}. The merchant received USDG. Total Noren WIF burned: {formatUnits(burned, 18)}.</p>}{invoice?.status === 2 && <><h3>Recent WIF burns</h3><ul>{burns.map(x => <li key={x.tx}>{formatUnits(x.wif, 18)} WIF · <a href={explorer(x.tx)} target="_blank" rel="noreferrer">{short(x.tx)}</a></li>)}</ul></>}</section>}
      {tx && <p role="status">Transaction: <a href={explorer(tx)} target="_blank" rel="noreferrer">{short(tx)}</a></p>}{note && <p role="alert">{note}</p>}
    </main>
  </div>;
}
