import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, secs, short, usdc, SERVER, type Config, type InvoiceView, type NorenEvent, type Webhook } from "./api";
import { Copy, Icon, Logo, Setup, TxRef, isFork, msgOf } from "./ui";
import { LineChart, Menu, Modal, QR, Toasts, downloadCsv, erc20Balance, payoutOf, toast } from "./kit";
import { createPublicClient, http, parseAbi } from "viem";
import { creditLineAbi, creditOf } from "./onchain";
import { LiveArc, NetSwitch } from "./LiveArc";
import { useNet } from "./network";
import { Onboard, listStores, readSession, readStoreId, saveSession, saveStoreId, type Session, type StoreView } from "./Onboard";

export type Tab = "home" | "balances" | "payments" | "links" | "developers" | "settings" | "onboard";
type Quote = { currency: string; fiatAmount: string; usdcAmount: string; rate?: string; quotedAt?: number | string; fiatUsd?: Feed; usdcUsd?: Feed };
type Feed = { feed: string; answer: string; decimals: number; roundId: string; updatedAt: number | string };
type Row = InvoiceView & { quote?: Quote };
type Currency = { code: string; name?: string; symbol?: string; decimals: number };

const TOKEN_KEY = "noren.merchant.token";
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
const payLink = (id: string) => `${location.origin}${location.pathname}#/pay/${id}`;
const go = (h: string) => { location.hash = h; };
const STATUS: Record<string, [string, string]> = { paid: ["Succeeded", "ok"], refunded: ["Refunded", "muted"], open: ["Incomplete", "info"], draft: ["Link sent", "info"], expired: ["Expired", "muted"] };
const Badge = ({ s }: { s: string }) => { const [t, c] = STATUS[s] ?? [s, "info"]; return <span className={`sd-badge ${c}`}>{t}{s === "paid" && <Icon.check />}{s === "refunded" && <Icon.refund />}</span>; };
const settled = (r: Row) => r.status === "paid" || r.status === "refunded";
const n6 = (v?: string | bigint) => (v === undefined ? 0 : Number(BigInt(v)) / 1e6);
const fmt = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = (v?: number | string, withYear = false) => { const s = secs(v); if (!s) return "–"; const d = new Date(s * 1000); return d.toLocaleDateString([], { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) }) + ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
const fiatStr = (q?: Quote, cur?: Currency) => { if (!q) return null; const d = cur?.decimals ?? (q.currency === "JPY" || q.currency === "KRW" ? 0 : 2); const v = Number(q.fiatAmount) / 10 ** d; return `${cur?.symbol ?? ""}${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })} ${q.currency}`; };

type Method = "usdc" | "private" | "credit" | "stocks";
const methodOf = (r: Row): Method | null => (settled(r) ? (r.method ?? "private") : null);
const METHOD: Record<Method, [string, string, () => JSX.Element]> = { usdc: ["USDC", "A direct USDC transfer from the customer's Arc wallet, verified on-chain", Icon.card], private: ["Private pool", "Zero-knowledge withdrawal from the Kohaku privacy pool", Icon.shield], credit: ["Pay later", "Credit line backed by Stock Tokens on Robinhood Chain, bridged to Arc by Chainlink CRE", Icon.layers], stocks: ["Pay with stocks", "Paid with Stock Tokens, converted to stablecoin at the Chainlink price", Icon.chart] };
const PM = ({ r }: { r: Row }) => { const m = methodOf(r); if (!m) return <span className="sd-muted">–</span>; const [t, d, I] = METHOD[m]; return <span className={`sd-pm ${m}`} title={d}><span className="sd-pm-ic"><I /></span>{t}</span>; };
const Who = ({ r }: { r: Row }) => r.method === "usdc" ? <span className="sd-linked" title="Paid from a public Arc wallet"><Icon.card />Arc wallet</span> : r.method === "stocks" ? <span className="sd-linked" title="Paid from a public Robinhood Chain wallet"><Icon.chart />Robinhood wallet</span> : r.method === "credit" ? <span className="sd-linked" title="Paid from a credit line: the line, and the borrower behind it, are public on-chain"><Icon.layers />Credit line {short(r.creditLineId, 4)}</span> : <span className="sd-private"><Icon.eyeOff />Private</span>;

/* ================================================================== shell */
export function Dashboard({ tab, sub }: { tab: Tab; sub?: string }) {
  const [baseCfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [devToken, setTokenState] = useState(readToken);
  // A signed-in owner (SIWE session) acts on its own store; the legacy dev token acts on the dev merchant.
  const [session, setSession] = useState<Session | null>(readSession);
  const [stores, setStores] = useState<StoreView[] | null>(null);
  const [storeId, setStoreId] = useState<string | null>(readStoreId);
  useEffect(() => { if (!session) { setStores(null); return; } listStores(session.session).then(setStores).catch((e) => { if (/Session required/.test(msgOf(e))) { saveSession(null); setSession(null); } else setStores([]); }); }, [session, tab]);
  const store = stores?.find((x) => x.id === storeId) ?? stores?.[0] ?? null;
  const cfg = useMemo(() => (baseCfg && store ? { ...baseCfg, merchant: store.merchant } : baseCfg), [baseCfg, store]);
  const token = store && session ? session.session : devToken;
  const [tick, setTick] = useState(0);
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);
  const [net] = useNet();
  const setToken = (t: string) => { setTokenState(t); try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } };

  useEffect(() => { api.config().then(setCfg).catch((e) => setErr(msgOf(e))); }, []);
  const signOut = () => { if (session) fetch(`${SERVER}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${session.session}` } }).catch(() => {}); saveSession(null); setSession(null); setStores(null); go("#/dashboard"); };
  const refresh = useCallback(async () => {
    if (!cfg) return;
    try { setRows(await api.listInvoices(cfg.merchant) as Row[]); } catch (e) { setErr(msgOf(e)); }
    api.profile(cfg.merchant).then((p) => setName(p.name)).catch(() => { /* no profile yet */ });
    setTick((t) => t + 1);
  }, [cfg]);
  useEffect(() => {
    if (!cfg) return;
    refresh();
    const es = api.events(); const on = () => refresh();
    ["message", "invoice_created", "invoice_bound", "paid", "refunded", "payment.succeeded", "refund.succeeded"].forEach((t) => es.addEventListener(t, on));
    return () => es.close();
  }, [cfg, refresh]);
  useEffect(() => setMenu(false), [tab, sub]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
      else if (e.key === "/" && !/input|textarea/i.test((e.target as HTMLElement).tagName)) { e.preventDefault(); setPalette(true); }
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);

  const firstRun = !!baseCfg && !err && (tab === "onboard" || (!devToken && !session && tab === "home") || (!!session && stores !== null && stores.length === 0 && tab === "home"));
  if (firstRun && baseCfg) return (
    <div className="ob-page">
      <div className="sd-testbar">Noren Merchant · Test mode: payments settle on local forks of Arc testnet and Robinhood Chain. No real funds.</div>
      <Onboard cfg={baseCfg} session={session} onSession={setSession} onStore={(st) => { setStores((l) => [...(l ?? []), st]); setStoreId(st.id); }} onDone={() => go("#/dashboard")} />
      <Toasts />
    </div>
  );
  const shop = name ?? "Your shop";
  const nav: [Tab, string, () => JSX.Element, number?][] = [["home", "Home", Icon.home], ["balances", "Balances", Icon.receipt], ["payments", "Payments", Icon.card, rows?.length], ["links", "Payment links", Icon.link]];

  return (
    <div className="sd">
      <div className="sd-testbar">Noren Merchant · Test mode: payments settle on local forks of Arc testnet and Robinhood Chain. No real funds.</div>
      <aside className={`sd-side ${menu ? "open" : ""}`}>
        <Menu align="left" trigger={(o) => (
          <button className="sd-acct" onClick={o}><span className="sd-avatar">{shop.slice(0, 1).toUpperCase()}</span><span className="sd-acct-t"><b>{shop}</b><small className="mono">{cfg ? short(cfg.merchant, 6) : "…"}</small></span><span className="sd-chev">⌄</span></button>
        )} items={[["Business settings", () => go("#/dashboard/settings")], ["Copy merchant ID", () => { if (cfg) { navigator.clipboard?.writeText(cfg.merchant); toast("Merchant ID copied"); } }], ...(stores && stores.length > 1 ? stores.filter((x) => x.id !== store?.id).map((x) => [`Switch to ${x.name}`, () => { saveStoreId(x.id); setStoreId(x.id); }] as [string, () => void]) : []), "sep", ["Set up a new store", () => go("#/dashboard/onboard")], ...(session ? [["Sign out", signOut] as [string, () => void]] : []), ["View landing page", () => go("#/")]]} />
        <nav className="sd-nav">
          {nav.map(([k, t, I, c]) => <a key={k} href={`#/dashboard${k === "home" ? "" : `/${k}`}`} aria-current={tab === k ? "page" : undefined}><I /><span>{t}</span>{!!c && <em>{c}</em>}</a>)}
          <span className="sd-nav-h">Developers</span>
          <a href="#/dashboard/developers" aria-current={tab === "developers" && !sub ? "page" : undefined}><Icon.code /><span>API keys</span></a>
          <a href="#/dashboard/developers/webhooks" aria-current={tab === "developers" && sub === "webhooks" ? "page" : undefined}><Icon.hook /><span>Webhooks</span></a>
          <a href="#/dashboard/developers/events" aria-current={tab === "developers" && sub === "events" ? "page" : undefined}><Icon.bolt /><span>Events</span></a>
        </nav>
        <div className="sd-side-foot">
          <a href="#/dashboard/settings" aria-current={tab === "settings" ? "page" : undefined}><Icon.gear /><span>Settings</span></a>
          <p className="mono">{cfg ? `${isFork(cfg) ? "Arc testnet fork" : "Arc testnet"} · ${cfg.chainId}` : "connecting…"}</p>
        </div>
      </aside>

      <div className="sd-body">
        <header className="sd-top">
          <button className="sd-icon-btn sd-burger" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}><Icon.menu /></button>
          <button className="sd-search" onClick={() => setPalette(true)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><span>Search payments, links, events</span><kbd>⌘K</kbd></button>
          <div className="sd-top-r">
            <NetSwitch />
            <a className="sd-icon-btn" href="#/dashboard/developers" title="Developers" aria-label="Developers"><Icon.code /></a>
            <Menu trigger={(o) => <button className="sd-btn primary sm" onClick={o}><Icon.plus /> New</button>} items={[["Payment link", () => setCreating(true), !!token], ["Webhook endpoint", () => go("#/dashboard/developers/webhooks")], ["Business name", () => go("#/dashboard/settings")]]} />
          </div>
        </header>

        <main className="sd-main">
          {net === "live" ? <><PageHead title="Arc testnet (live)" sub="The public deployment and the payments recorded on it. Stores, links and the dashboard below run on the local fork." /><div style={{ maxWidth: 760 }}><LiveArc context="merchant" /></div></> : err ? <Setup err={err} /> : !cfg ? <div className="sd-loading"><span className="spin" /> Connecting to {SERVER}…</div> : (
            <>
              {!token && tab !== "developers" && <div className="sd-callout"><Icon.lock /><span><b>Add your secret key</b> to create links, refund payments and manage webhooks. <code>pnpm dev:stack</code> prints one.</span><a className="sd-btn sm" href="#/dashboard/developers">Add key</a></div>}
              {tab === "home" && <Home rows={rows} shop={shop} cfg={cfg} onCreate={() => setCreating(true)} token={token} />}
              {tab === "balances" && <Balances rows={rows} cfg={cfg} token={token} />}
              {tab === "payments" && (sub ? <PaymentPage id={sub} rows={rows} cfg={cfg} token={token} onDone={refresh} tick={tick} /> : <Payments rows={rows} />)}
              {tab === "links" && <Links rows={rows} onCreate={() => setCreating(true)} token={token} />}
              {tab === "developers" && <Developers cfg={cfg} token={token} setToken={setToken} sub={sub} tick={tick} store={store} session={session} onStores={() => session && listStores(session.session).then(setStores).catch(() => {})} />}
              {tab === "settings" && <Settings cfg={cfg} token={token} name={name} onSaved={setName} />}
            </>
          )}
        </main>
      </div>
      {menu && <div className="sd-scrim" onClick={() => setMenu(false)} />}
      {palette && <Palette rows={rows ?? []} onClose={() => setPalette(false)} onCreate={() => { setPalette(false); setCreating(true); }} />}
      {creating && cfg && <CreateLink cfg={cfg} token={token} shop={shop} onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); refresh(); go(`#/dashboard/payments/${id}`); }} />}
      <Toasts />
    </div>
  );
}

const PageHead = ({ title, children, sub }: { title: ReactNode; children?: ReactNode; sub?: ReactNode }) => (
  <div className="sd-head"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>{children && <div className="sd-head-act">{children}</div>}</div>
);

/* ================================================================== home */
type Range = "today" | "7d" | "30d" | "90d";
const RANGES: [Range, string][] = [["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 4 weeks"], ["90d", "Last 3 months"]];
function buckets(range: Range, offset = 0) {
  const now = Math.floor(Date.now() / 1000), H = 3600, D = 86400;
  if (range === "today") { const start = new Date(); start.setHours(0, 0, 0, 0); const s = Math.floor(start.getTime() / 1000) - offset * D; return { start: s, step: H, n: 24, end: s + D, label: (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric" }) }; }
  const days = range === "7d" ? 7 : range === "30d" ? 28 : 90;
  const end = Math.floor(now / D) * D + D - offset * days * D, start = end - days * D;
  return { start, step: D, n: days, end, label: (t: number) => new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) };
}
function series(rows: Row[], range: Range, offset: number, pick: (r: Row) => number, at: (r: Row) => number | undefined = (r) => secs(r.paidAt), cumulative = false) {
  const b = buckets(range, offset), vals = Array.from({ length: b.n }, () => 0);
  for (const r of rows) { const t = at(r); if (!t || t < b.start || t >= b.end) continue; vals[Math.floor((t - b.start) / b.step)] += pick(r); }
  if (cumulative) for (let i = 1; i < vals.length; i++) vals[i] += vals[i - 1];
  return { vals, labels: vals.map((_, i) => b.label(b.start + i * b.step)), total: vals.reduce((a, v) => a + v, 0) };
}
const delta = (cur: number, prev: number) => prev === 0 ? (cur === 0 ? null : "new") : `${cur >= prev ? "+" : ""}${(((cur - prev) / prev) * 100).toFixed(1)}%`;

function Home({ rows, shop, cfg, onCreate, token }: { rows: Row[] | null; shop: string; cfg: Config; onCreate: () => void; token: string }) {
  const [range, setRange] = useState<Range>("7d");
  const r = rows ?? [];
  const today = series(r.filter(settled), "today", 0, (x) => n6(x.invoice.amount), undefined, true);
  const yday = series(r.filter(settled), "today", 1, (x) => n6(x.invoice.amount), undefined, true);
  const bal = useBalance(cfg);
  const gross = series(r.filter(settled), range, 0, (x) => n6(x.invoice.amount)), grossP = series(r.filter(settled), range, 1, (x) => n6(x.invoice.amount));
  const refunds = series(r.filter((x) => x.refundAmount), range, 0, (x) => n6(x.refundAmount), (x) => secs(x.refundedAt)), refundsP = series(r.filter((x) => x.refundAmount), range, 1, (x) => n6(x.refundAmount), (x) => secs(x.refundedAt));
  const count = series(r.filter(settled), range, 0, () => 1), countP = series(r.filter(settled), range, 1, () => 1);
  const links = series(r, range, 0, () => 1, (x) => secs(x.createdAt)), linksP = series(r, range, 1, () => 1, (x) => secs(x.createdAt));
  const net = { vals: gross.vals.map((v, i) => v - refunds.vals[i]), total: gross.total - refunds.total }, netP = grossP.total - refundsP.total;
  const cards: [string, { vals: number[]; total: number }, number, (v: number) => string, string][] = [
    ["Gross volume", gross, grossP.total, (v) => `${fmt(v)} USDC`, "Settled payments, before refunds. Pay-with-stocks payments settle in USDG on Robinhood Chain (1:1 USD stablecoin) and are counted here at face value."],
    ["Net volume", net, netP, (v) => `${fmt(v)} USDC`, "Gross volume minus refunds"],
    ["Successful payments", count, countP.total, (v) => String(Math.round(v)), "Private and credit payments"],
    ["Refunds", refunds, refundsP.total, (v) => `${fmt(v)} USDC`, "Sent to customers' private inboxes"],
    ["Payment links created", links, linksP.total, (v) => String(Math.round(v)), "Including unpaid and expired"],
    ["Average payment", { vals: gross.vals.map((v, i) => (count.vals[i] ? v / count.vals[i] : 0)), total: count.total ? gross.total / count.total : 0 }, countP.total ? grossP.total / countP.total : 0, (v) => `${fmt(v)} USDC`, "Gross volume ÷ payments"],
  ];
  return (
    <>
      <PageHead title="Today" sub={<>Welcome back, {shop}. Everything here is read from your server and the chain; nothing here identifies a customer.</>}>
        <button className="sd-btn primary" disabled={!token} onClick={onCreate}><Icon.plus /> Create payment link</button>
      </PageHead>

      <section className="sd-today">
        <div className="sd-today-chart">
          <div className="sd-kv-row">
            <div><span>Gross volume</span><b>{fmt(today.total ? today.vals[today.vals.length - 1] : 0)} <em>USDC</em></b><small>{new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></div>
            <div className="muted"><span>Yesterday</span><b>{fmt(yday.vals[yday.vals.length - 1] ?? 0)} <em>USDC</em></b></div>
          </div>
          <LineChart series={[{ label: "Today", values: today.vals.slice(0, new Date().getHours() + 1) }, { label: "Yesterday", values: yday.vals, dashed: true }]} labels={today.labels} height={150} format={(v) => `${fmt(v)} USDC`} />
          <div className="sd-axis mono"><span>12:00 AM</span><span>Now, {new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span><span>11:59 PM</span></div>
        </div>
        <div className="sd-today-side">
          <div className="sd-stat"><span>USDC balance</span><b>{bal.value === null ? <span className="sd-skel w80" /> : `${fmt(n6(bal.value))}`} <em>USDC</em></b><small>{bal.error ? <span className="sd-err-t">{bal.error}</span> : <>On-chain at your payout address <span className="mono">{short(bal.payout ?? "", 6)}</span></>}</small><a href="#/dashboard/balances">View balance <Icon.arrow /></a></div>
          <div className="sd-stat"><span>Payouts</span><b>Instant</b><small>USDC lands at your payout address in the same transaction as the proof. No payout schedule, no holding period.</small></div>
          <div className="sd-stat accent"><span>Customers identified</span><b>0</b><small>of {r.filter((x) => methodOf(x) === "private").length} private payments. They come from the privacy pool, never from a person's wallet.{r.some((x) => methodOf(x) === "credit") && <> Credit payments are tied to a public credit line.</>}</small></div>
        </div>
      </section>

      <div className="sd-section-h">
        <h2>Your overview</h2>
        <div className="sd-seg">{RANGES.map(([k, t]) => <button key={k} aria-pressed={range === k} onClick={() => setRange(k)}>{t}</button>)}</div>
      </div>
      <section className="sd-cards">
        {cards.map(([t, s, prev, f, hint]) => {
          const d = delta(s.total, prev);
          return (
            <article className="sd-card" key={t} title={hint}>
              <header><span>{t}</span>{d && <em className={d.startsWith("-") ? "down" : "up"}>{d}</em>}</header>
              <b>{f(s.total)}</b>
              <small>{f(prev)} previous period</small>
              {rows === null ? <div className="sd-skel h60" /> : <LineChart compact series={[{ label: t, values: s.vals }]} labels={series([], range, 0, () => 0).labels} height={64} format={f} />}
              <div className="sd-axis mono"><span>{series([], range, 0, () => 0).labels[0]}</span><span>{range === "today" ? "Now" : "Today"}</span></div>
            </article>
          );
        })}
      </section>

      <Methods rows={rows} cfg={cfg} />

      <div className="sd-section-h"><h2>Recent payments</h2><a className="sd-link" href="#/dashboard/payments">View all <Icon.arrow /></a></div>
      <PayTable rows={r.slice(0, 6)} loading={!rows} />
    </>
  );
}

/** Payment-method mix, and what the credit pool is still owed on lines that paid this merchant (read from Arc logs). */
function Methods({ rows, cfg }: { rows: Row[] | null; cfg: Config }) {
  const credit = creditOf(cfg);
  const paid = (rows ?? []).filter(settled);
  const mix = (Object.keys(METHOD) as Method[]).map((m) => { const xs = paid.filter((x) => methodOf(x) === m); return { m, n: xs.length, v: xs.reduce((a, x) => a + n6(x.invoice.amount), 0) }; });
  const total = mix.reduce((a, x) => a + x.v, 0);
  const lineIds = useMemo(() => [...new Set(paid.filter((x) => x.method === "credit" && x.creditLineId).map((x) => x.creditLineId!.toLowerCase()))], [paid.length, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const [exp, setExp] = useState<{ drawn: number; repaid: number } | null>(null);
  const [expErr, setExpErr] = useState<string | null>(null);
  useEffect(() => {
    if (!credit?.creditLine || !lineIds.length) { setExp({ drawn: 0, repaid: 0 }); return; }
    const creditLine = credit.creditLine;
    let live = true;
    const c = createPublicClient({ transport: http(cfg.rpcUrl) });
    const from = BigInt(credit.arcFromBlock ?? cfg.deployment.deploymentBlock);
    Promise.all([
      c.getLogs({ address: creditLine, event: creditLineAbi[2], args: { lineId: lineIds as `0x${string}`[] }, fromBlock: from, toBlock: "latest" }),
      c.getLogs({ address: creditLine, event: creditLineAbi[3], args: { lineId: lineIds as `0x${string}`[] }, fromBlock: from, toBlock: "latest" }),
    ]).then(([d, rp]) => { if (live) { setExp({ drawn: d.reduce((a, l) => a + n6(l.args.amount), 0), repaid: rp.reduce((a, l) => a + n6(l.args.amount), 0) }); setExpErr(null); } })
      .catch((e) => live && setExpErr(`Couldn't read NorenCreditLine: ${msgOf(e)}`));
    return () => { live = false; };
  }, [cfg, credit?.creditLine, lineIds.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="sd-methods">
      <div>
        <div className="sd-section-h tight"><h2>Payment methods</h2><span className="sd-muted">{paid.length} settled</span></div>
        <div className="sd-mix" aria-hidden>{total > 0 && mix.map((x) => x.v > 0 && <i key={x.m} className={x.m} style={{ width: `${(x.v / total) * 100}%` }} />)}</div>
        <ul className="sd-mix-l">{mix.map((x) => { const [t, d, I] = METHOD[x.m]; return <li key={x.m} title={d}><span className={`sd-pm ${x.m}`}><span className="sd-pm-ic"><I /></span>{t}</span><b className="num">{fmt(x.v)} <em>{x.m === "stocks" ? "USDG" : "USDC"}</em></b><small>{x.n} payment{x.n === 1 ? "" : "s"}{total > 0 && ` · ${Math.round((x.v / total) * 100)}%`}</small></li>; })}</ul>
      </div>
      <div className="sd-exposure">
        <div className="sd-section-h tight"><h2>Credit-line exposure</h2></div>
        {!credit?.creditLine ? <p className="sd-muted">Setup required: the credit line isn't connected. <code>pnpm dev:all</code> starts the Robinhood fork, NorenCredit, NorenCreditLine and the CRE bridge.</p> : expErr ? <p className="sd-err-t">{expErr}</p> : (
          <>
            <dl className="sd-dl">
              <dt>Lines that paid you</dt><dd className="num">{lineIds.length}</dd>
              <dt>Drawn on those lines</dt><dd className="num">{exp ? `${fmt(exp.drawn)} USDC` : "…"}</dd>
              <dt>Repaid so far</dt><dd className="num">{exp ? `${fmt(exp.repaid)} USDC` : "…"}</dd>
              <dt>Owed to the credit pool</dt><dd className="num"><b>{exp ? `${fmt(Math.max(0, exp.drawn - exp.repaid))} USDC` : "…"}</b></dd>
              <dt>Your exposure</dt><dd><b>0.00 USDC</b> · paid upfront</dd>
            </dl>
            <p className="sd-muted sm">Drawn and repaid amounts are summed from <code>Drawn</code> and <code>Repaid</code> logs on NorenCreditLine <span className="mono">{short(credit.creditLine ?? "", 6)}</span>. Collateral sits in NorenCredit on Robinhood Chain.</p>
          </>
        )}
      </div>
    </section>
  );
}

function useBalance(cfg: Config) {
  const [s, setS] = useState<{ value: bigint | null; payout?: string; error?: string }>({ value: null });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const payout = await payoutOf(cfg.rpcUrl, cfg.deployment.checkout, cfg.merchant);
        const target = /^0x0{40}$/.test(payout) ? cfg.merchant : payout;
        const value = await erc20Balance(cfg.rpcUrl, cfg.deployment.usdc, target);
        if (live) setS({ value, payout: target });
      } catch (e) { if (live) setS({ value: 0n, error: `Couldn't read the chain: ${msgOf(e)}` }); }
    })();
    return () => { live = false; };
  }, [cfg]);
  return s;
}

/* ================================================================== balances */
function Balances({ rows, cfg, token }: { rows: Row[] | null; cfg: Config; token: string }) {
  const bal = useBalance(cfg);
  const r = rows ?? [];
  const incoming = r.filter((x) => x.status === "open" || x.status === "draft").reduce((a, x) => a + n6(x.invoice.amount), 0);
  const ledger = useMemo(() => {
    const e: { at: number; type: string; amount: number; id: string; tx?: string; desc?: string }[] = [];
    for (const x of r) {
      if (settled(x) && x.paidAt) e.push({ at: secs(x.paidAt)!, type: x.method === "stocks" ? "Payment (USDG, Robinhood)" : "Payment", amount: n6(x.invoice.amount), id: x.invoice.invoiceId, tx: x.paymentTx, desc: x.description });
      if (x.refundAmount && x.refundedAt) e.push({ at: secs(x.refundedAt)!, type: "Refund", amount: -n6(x.refundAmount), id: x.invoice.invoiceId, tx: x.refundTx, desc: x.description });
    }
    return e.sort((a, b) => b.at - a.at);
  }, [r]);
  const exportCsv = () => downloadCsv(`noren-balance-${new Date().toISOString().slice(0, 10)}.csv`, [["date", "type", "amount_usdc", "invoice_id", "description", "tx", "customer"], ...ledger.map((l) => [new Date(l.at * 1000).toISOString(), l.type, l.amount.toFixed(6), l.id, l.desc ?? "", l.tx ?? "", "private"])]);
  return (
    <>
      <PageHead title="Balances" sub="USDC settles straight to your payout address on-chain. There is no Noren-held balance to withdraw.">
        <button className="sd-btn" onClick={exportCsv} disabled={!ledger.length}>Export CSV</button>
      </PageHead>
      <section className="sd-bal">
        <div className="sd-bal-main">
          <span>Available balance</span>
          <b>{bal.value === null ? <span className="sd-skel w120" /> : fmt(n6(bal.value))} <em>USDC</em></b>
          <div className="sd-bal-bar">{bal.value !== null && (n6(bal.value) + incoming) > 0 && <><i style={{ width: `${(n6(bal.value) / (n6(bal.value) + incoming)) * 100}%` }} /><i className="b" style={{ width: `${(incoming / (n6(bal.value) + incoming)) * 100}%` }} /></>}</div>
          <ul>
            <li><i className="dot a" /><span>Available</span><b>{bal.value === null ? "…" : fmt(n6(bal.value))} USDC</b></li>
            <li><i className="dot b" /><span>Incoming (open links)</span><b>{fmt(incoming)} USDC</b></li>
          </ul>
          {bal.error && <p className="sd-err-t">{bal.error}</p>}
        </div>
        <dl className="sd-dl">
          <dt>Payout address</dt><dd className="mono">{short(bal.payout ?? cfg.merchant, 8)} <Copy text={bal.payout ?? cfg.merchant} /></dd>
          <dt>Settlement asset</dt><dd>USDC · <span className="mono">{short(cfg.deployment.usdc, 6)}</span></dd>
          <dt>Payout timing</dt><dd>Instant, in the payment transaction</dd>
          <dt>Read from</dt><dd className="mono">{cfg.rpcUrl}</dd>
        </dl>
      </section>
      <SettleToArc cfg={cfg} token={token} />
      <div className="sd-section-h"><h2>Balance transactions</h2><span className="sd-muted">{ledger.length}</span></div>
      <div className="sd-table-wrap">
        {!rows ? <div className="sd-skel-rows"><i /><i /><i /></div> : ledger.length === 0 ? <Empty title="No balance transactions yet" text="Payments and refunds appear here as they settle on-chain." /> : (
          <table className="sd-table">
            <thead><tr><th>Type</th><th className="r">Amount</th><th className="hide-s">Description</th><th className="hide-s">Transaction</th><th>Date</th></tr></thead>
            <tbody>{ledger.map((l, i) => (
              <tr key={i} onClick={() => go(`#/dashboard/payments/${l.id}`)}>
                <td><span className={`sd-type ${l.type === "Refund" ? "neg" : ""}`}>{l.type}</span></td>
                <td className={`r num ${l.amount < 0 ? "neg" : ""}`}>{l.amount < 0 ? "−" : "+"}{fmt(Math.abs(l.amount))} <span className="sd-muted">{/USDG/.test(l.type) ? "USDG" : "USDC"}</span></td>
                <td className="hide-s">{l.desc || <span className="sd-muted mono">{short(l.id, 8)}</span>}</td>
                <td className="hide-s"><TxRef cfg={cfg} hash={l.tx} /></td>
                <td className="sd-muted">{dt(l.at)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** Pay-with-stocks proceeds arrive as USDG on Robinhood Chain. Settle them to USDC on Arc through the value bridge. */
function SettleToArc({ cfg, token }: { cfg: Config; token: string }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof api.settlements>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { if (!token) return; api.settlements(cfg.merchant, token).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(msgOf(e))); }, [cfg.merchant, token]);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  const usdg = d ? Number(d.usdg) / 1e6 : 0;
  const settle = async () => {
    const v = amt ? Number(amt) : usdg; if (!(v > 0)) return;
    setBusy(true);
    try { await api.settle(cfg.merchant, BigInt(Math.round(v * 1e6)), token); toast("Settlement requested on Robinhood Chain"); setAmt(""); load(); }
    catch (e) { toast(msgOf(e), "err"); } finally { setBusy(false); }
  };
  return (
    <section className="sd-settle">
      <div className="sd-section-h"><h2>USDG on Robinhood Chain</h2>{d && <span className="sd-muted">from Pay with stocks</span>}</div>
      {!token ? <p className="sd-muted">Add your secret key to see and settle USDG.</p> : err ? <p className="sd-muted">{/Not found|404/.test(err) ? "Setup required: Settle to Arc runs with pnpm dev:all (packages/bridge-settlement)." : err}</p> : !d ? <div className="sd-skel-rows"><i /></div> : (
        <>
          <div className="sd-settle-row">
            <div><span>Available</span><b className="num">{fmt(usdg)} <em>USDG</em></b><small>NorenSettlementDesk <span className="mono">{short(d.desk, 4)}</span></small></div>
            <label className="sd-settle-amt"><span>Amount</span><input className="sd-input" inputMode="decimal" placeholder={fmt(usdg)} value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="USDG to settle" /></label>
            <button className="sd-btn primary" disabled={busy || usdg <= 0 || !d.relay} onClick={settle}>{busy ? "Requesting…" : "Settle to Arc"}</button>
          </div>
          <p className="sd-muted sm">A Chainlink CRE workflow compares live Relay and Across quotes with Chainlink USDG/USD and USDC/USD before approving; a keeper then deposits into Relay. On a local fork no real relayer fills the Arc side, so the fill stays pending.</p>
          {d.settlements.length > 0 && (
            <ul className="sd-settle-list">{d.settlements.map((x) => (
              <li key={x.id}>
                <header><b className="num">{fmt(Number(x.amountUsdg6) / 1e6)} USDG → USDC on Arc</b><span className={`sd-badge ${x.status === "executed" ? "ok" : x.status === "failed" || x.status === "rejected" ? "bad" : "info"}`}>{x.status === "executed" ? "Deposited" : x.status[0].toUpperCase() + x.status.slice(1)}</span></header>
                <ol className="sd-tl small">
                  <li data-on="true"><i /><div><b>Requested on Robinhood</b><span className="mono">{short(x.requestTx, 6)}</span></div></li>
                  <li data-on={!!x.cre?.written}><i /><div><b>Chainlink CRE approval</b><span>{x.cre?.error ? x.cre.error : x.cre ? `${x.cre.decision ?? ""}${x.cre.written ? ` · forwarder tx ${short(x.cre.written, 6)} · ${(x.cre.ms / 1000).toFixed(1)} s` : ""}` : "running the settlement workflow…"}</span>{x.quotes && <span>Relay: {x.quotes.relay ?? "–"} · Across: {x.quotes.across ?? "–"}</span>}</div></li>
                  <li data-on={!!x.deposit}><i /><div><b>Deposit on the approved route</b><span>{x.deposit ? <>tx <span className="mono">{short(x.deposit.tx, 6)}</span> · quoted {fmt(Number(x.deposit.quotedOutUsdc6) / 1e6)} USDC{x.deposit.feeUsd ? ` · fee $${Number(x.deposit.feeUsd).toFixed(3)}` : ""}</> : x.error ?? "waiting for approval"}</span></div></li>
                  <li data-on="false"><i /><div><b>USDC filled on Arc</b><span>{x.deposit ? "Pending: needs a real Relay solver, which never sees a local fork" : "–"}</span></div></li>
                </ol>
              </li>
            ))}</ul>
          )}
        </>
      )}
    </section>
  );
}

/* ================================================================== payments */
type Filter = "all" | "paid" | "refunded" | "open" | "expired";
function Payments({ rows }: { rows: Row[] | null }) {
  const [f, setF] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [range, setRange] = useState<"all" | Range>("all");
  const [pm, setPm] = useState<"all" | Method>("all");
  const r = (rows ?? []).filter((x) => pm === "all" || methodOf(x) === pm);
  const inRange = (x: Row) => { if (range === "all") return true; const b = buckets(range); const t = secs(x.paidAt ?? x.createdAt) ?? 0; return t >= b.start && t < b.end; };
  const match = (x: Row) => !q || [x.invoice.invoiceId, x.description, x.paymentTx, x.refundTx, usdc(x.invoice.amount)].some((v) => v && String(v).toLowerCase().includes(q.toLowerCase()));
  const byStatus = (x: Row, k: Filter) => k === "all" || x.status === k || (k === "open" && x.status === "draft");
  const shown = r.filter((x) => byStatus(x, f) && match(x) && inRange(x));
  const counts = Object.fromEntries((["all", "paid", "refunded", "open", "expired"] as Filter[]).map((k) => [k, r.filter((x) => byStatus(x, k) && match(x) && inRange(x)).length])) as Record<Filter, number>;
  const exportCsv = () => downloadCsv(`noren-payments-${new Date().toISOString().slice(0, 10)}.csv`, [["invoice_id", "status", "amount_usdc", "presentment", "description", "created", "paid", "refunded_usdc", "payment_tx", "refund_tx", "gas_used", "method", "customer"], ...shown.map((x) => [x.invoice.invoiceId, x.status, n6(x.invoice.amount).toFixed(6), fiatStr(x.quote) ?? "", x.description ?? "", secs(x.createdAt) ? new Date(secs(x.createdAt)! * 1000).toISOString() : "", secs(x.paidAt) ? new Date(secs(x.paidAt)! * 1000).toISOString() : "", x.refundAmount ? n6(x.refundAmount).toFixed(6) : "", x.paymentTx ?? "", x.refundTx ?? "", x.paymentGasUsed ?? "", methodOf(x) ?? "", x.method === "credit" ? `credit line ${x.creditLineId}` : "private"])]);
  return (
    <>
      <PageHead title="Payments"><button className="sd-btn" onClick={exportCsv} disabled={!shown.length}>Export</button></PageHead>
      <div className="sd-tabs" role="tablist">
        {([["all", "All"], ["paid", "Succeeded"], ["refunded", "Refunded"], ["open", "Incomplete"], ["expired", "Expired"]] as [Filter, string][]).map(([k, t]) => <button key={k} role="tab" aria-selected={f === k} onClick={() => setF(k)}><span>{t}</span><b>{counts[k]}</b></button>)}
      </div>
      <div className="sd-filters">
        <label className="sd-filter-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input placeholder="Filter by ID, description, amount or tx" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter payments" /></label>
        <Menu align="left" trigger={(o) => <button className={`sd-chip ${range !== "all" ? "on" : ""}`} onClick={o}><Icon.plus /> Date{range !== "all" && `: ${RANGES.find(([k]) => k === range)?.[1]}`}</button>} items={[["Any time", () => setRange("all")], ...RANGES.map(([k, t]) => [t, () => setRange(k)] as [string, () => void])]} />
        <Menu align="left" trigger={(o) => <button className={`sd-chip ${pm !== "all" ? "on" : ""}`} onClick={o}><Icon.plus /> Payment method{pm !== "all" && `: ${METHOD[pm][0]}`}</button>} items={[["Any method", () => setPm("all")], ...(Object.keys(METHOD) as Method[]).map((k) => [METHOD[k][0], () => setPm(k)] as [string, () => void])]} />
      </div>
      <PayTable rows={shown} loading={!rows} />
      {rows && <p className="sd-foot-n">{shown.length} result{shown.length === 1 ? "" : "s"}</p>}
    </>
  );
}

function PayTable({ rows, loading }: { rows: Row[]; loading?: boolean }) {
  if (loading) return <div className="sd-table-wrap"><div className="sd-skel-rows"><i /><i /><i /></div></div>;
  if (!rows.length) return <div className="sd-table-wrap"><Empty title="No payments match" text="Create a payment link and pay it privately on the hosted checkout. It shows up here the moment it settles." action={<a className="sd-btn sm" href="#/dashboard/links">Go to payment links</a>} /></div>;
  return (
    <div className="sd-table-wrap">
      <table className="sd-table">
        <thead><tr><th className="r">Amount</th><th />  <th>Status</th><th className="hide-s">Payment method</th><th className="hide-m">Description</th><th>Customer</th><th className="hide-s">Date</th><th /></tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={x.invoice.invoiceId} tabIndex={0} onClick={() => go(`#/dashboard/payments/${x.invoice.invoiceId}`)} onKeyDown={(e) => e.key === "Enter" && go(`#/dashboard/payments/${x.invoice.invoiceId}`)}>
            <td className="r num"><b>{usdc(x.invoice.amount)}</b></td>
            <td className="sd-cur">{x.method === "stocks" ? "USDG" : "USDC"}{x.quote && <small>{fiatStr(x.quote)}</small>}</td>
            <td><Badge s={x.status} /></td>
            <td className="hide-s"><PM r={x} /></td>
            <td className="hide-m sd-desc">{x.description || <span className="sd-muted mono">{short(x.invoice.invoiceId, 8)}</span>}</td>
            <td><Who r={x} /></td>
            <td className="hide-s sd-muted">{dt(x.paidAt ?? x.createdAt)}</td>
            <td className="r"><Menu trigger={(o) => <button className="sd-icon-btn sm" onClick={o} aria-label="Row actions">⋯</button>} items={[["View payment details", () => go(`#/dashboard/payments/${x.invoice.invoiceId}`)], ["Copy payment ID", () => { navigator.clipboard?.writeText(x.invoice.invoiceId); toast("Payment ID copied"); }], ["Copy checkout link", () => { navigator.clipboard?.writeText(payLink(x.invoice.invoiceId)); toast("Checkout link copied"); }], ["Open hosted checkout", () => go(`#/pay/${x.invoice.invoiceId}`)]]} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const Empty = ({ title, text, action }: { title: string; text: string; action?: ReactNode }) => <div className="sd-empty"><span className="sd-empty-ic"><Icon.card /></span><b>{title}</b><p>{text}</p>{action}</div>;

/* ================================================================== payment detail */
function PaymentPage({ id, rows, cfg, token, onDone, tick }: { id: string; rows: Row[] | null; cfg: Config; token: string; onDone: () => void; tick: number }) {
  const r = rows?.find((x) => x.invoice.invoiceId.toLowerCase() === id.toLowerCase());
  const [refunding, setRefunding] = useState(false);
  const [events, setEvents] = useState<NorenEvent[] | null>(null);
  useEffect(() => { if (!token) { setEvents([]); return; } api.eventLog(cfg.merchant, token).then((l) => setEvents(l.filter((e) => String(e.data?.invoiceId ?? "").toLowerCase() === id.toLowerCase()))).catch(() => setEvents([])); }, [cfg, token, id, tick]);
  if (!rows) return <div className="sd-loading"><span className="spin" /> Loading payment…</div>;
  if (!r) return <><a className="sd-back" href="#/dashboard/payments"><Icon.back /> Payments</a><Empty title="Payment not found" text={`No payment ${short(id, 10)} in this merchant's records.`} /></>;
  const credit = r.method === "credit", stock = r.method === "stocks";
  const steps: [string, number | string | undefined, ReactNode, boolean][] = stock ? [
    ["Payment link created", r.createdAt, r.description ? `“${r.description}”` : null, true],
    ["Paid with Stock Tokens on Robinhood Chain, USDG received", r.paidAt, r.paymentTx ? <><span className="mono" title="Local Robinhood Chain fork">{short(r.paymentTx, 8)}</span> · NorenGateway.pay, gas paid by the customer</> : null, settled(r)],
  ] : credit ? [
    ["Payment link created", r.createdAt, r.description ? `“${r.description}”` : null, true],
    ["Paid later from a credit line, USDC received", r.paidAt, r.paymentTx ? <><TxRef cfg={cfg} hash={r.paymentTx} /> · NorenCreditLine.payInvoice, gas paid by the customer</> : null, settled(r)],
  ] : [
    ["Payment link created", r.createdAt, r.description ? `“${r.description}”` : null, true],
    ["Customer opened the link and bound the invoice", r.boundAt, "Private refund inbox and receipt commitment fixed in the invoice", !!r.invoice.receiptCommitment],
    ["Zero-knowledge proof verified, USDC received", r.paidAt, r.paymentTx ? <><TxRef cfg={cfg} hash={r.paymentTx} />{r.paymentGasUsed && <> · {Number(r.paymentGasUsed).toLocaleString()} gas paid by you</>}</> : null, settled(r)],
    ["Refunded to the customer's private inbox", r.refundedAt, r.refundTx ? <>{usdc(r.refundAmount)} USDC · <TxRef cfg={cfg} hash={r.refundTx} /></> : null, r.status === "refunded"],
  ];
  return (
    <>
      <a className="sd-back" href="#/dashboard/payments"><Icon.back /> Payments</a>
      <div className="sd-pay-head">
        <div>
          <span className="sd-eyebrow">Payment</span>
          <h1><span className="num">{usdc(r.invoice.amount)}</span> <em>{stock ? "USDG" : "USDC"}</em> <Badge s={r.status} /></h1>
          {r.quote && <p className="sd-quote-line">Priced at <b>{fiatStr(r.quote)}</b> · Chainlink rate locked at creation</p>}
        </div>
        <div className="sd-head-act">
          {r.status === "paid" && !credit && !stock && <button className="sd-btn" disabled={!token} onClick={() => setRefunding(true)}><Icon.refund /> Refund</button>}
          <Menu trigger={(o) => <button className="sd-btn" onClick={o} aria-label="More actions">⋯</button>} items={[["Copy payment ID", () => { navigator.clipboard?.writeText(r.invoice.invoiceId); toast("Payment ID copied"); }], ["Copy checkout link", () => { navigator.clipboard?.writeText(payLink(r.invoice.invoiceId)); toast("Checkout link copied"); }], ["Open hosted checkout", () => go(`#/pay/${r.invoice.invoiceId}`)]]} />
        </div>
      </div>
      <div className="sd-summary">
        <div><span>Last update</span><b>{dt(r.refundedAt ?? r.paidAt ?? r.boundAt ?? r.createdAt)}</b></div>
        <div><span>Customer</span><b><Who r={r} /></b></div>
        <div><span>Payment method</span><b><PM r={r} /></b></div>
        <div><span>Network fee</span><b>{r.paymentGasUsed ? `${Number(r.paymentGasUsed).toLocaleString()} gas · paid by ${credit || stock ? "the customer" : "you"}` : "–"}</b></div>
      </div>

      <div className="sd-detail-grid">
        <div>
          <section className="sd-panel">
            <h2>Timeline</h2>
            <ol className="sd-tl">{steps.map(([t, at, d, on]) => <li key={t} data-on={on}><i /><div><b>{t}</b><span>{on ? dt(at, true) : "Not yet"}</span>{on && d && <p>{d}</p>}</div></li>)}</ol>
          </section>
          <section className="sd-panel">
            <h2>Events and webhooks</h2>
            {!token ? <p className="sd-muted">Add your secret key to see this payment's events.</p> : events === null ? <div className="sd-skel-rows"><i /></div> : events.length === 0 ? <p className="sd-muted">No events recorded for this payment.</p> : (
              <ul className="sd-evmini">{events.map((e) => { const d = e.deliveries ?? []; const ok = d.some((x) => x.ok); return <li key={e.id}><code>{e.type}</code><span className={`sd-badge ${d.length === 0 ? "muted" : ok ? "ok" : "bad"}`}>{d.length === 0 ? "No endpoints" : ok ? "Delivered" : `Failed · ${d.length} tries`}</span><span className="sd-muted">{dt(e.created)}</span></li>; })}</ul>
            )}
          </section>
        </div>
        <div>
          <section className="sd-panel">
            <h2>Payment details</h2>
            <dl className="sd-dl">
              <dt>Payment ID</dt><dd className="mono">{short(r.invoice.invoiceId, 10)} <Copy text={r.invoice.invoiceId} /></dd>
              <dt>Amount</dt><dd>{usdc(r.invoice.amount)} {stock ? "USDG (invoice priced in USDC, 1:1)" : "USDC"}</dd>
              {r.refundAmount && <><dt>Refunded</dt><dd>{usdc(r.refundAmount)} USDC</dd></>}
              <dt>Description</dt><dd>{r.description || "–"}</dd>
              <dt>Expires</dt><dd>{dt(r.invoice.expiry, true)}</dd>
              <dt>Checkout</dt><dd><a href={`#/pay/${r.invoice.invoiceId}`} className="mono">/pay/{short(r.invoice.invoiceId, 6)}</a></dd>
            </dl>
          </section>
          <section className="sd-panel">
            <h2>Payment method</h2>
            {stock && r.stock ? (
              <dl className="sd-dl">
                <dt>Type</dt><dd>Stock Tokens, sold {r.stock.route === "aqua-maker" ? "to a 1inch Aqua maker" : r.stock.route === "vault" ? "to Noren's stock vault" : "at the Chainlink price"}</dd>
                {r.stock.route === "aqua-maker" && <><dt>Maker</dt><dd className="mono">{short(r.stock.maker, 4)} · fee {(Number(r.stock.makerFeeUsdg ?? 0) / 1e6).toFixed(4)} USDG</dd><dt>Strategy</dt><dd className="mono">{short(r.stock.strategyHash, 6)} (SwapVM, Chainlink-pegged)</dd><dt>Engine</dt><dd className="sd-muted">Powered by SwapVM — © Degensoft Ltd 2025</dd></>}
                <dt>Shares</dt><dd className="num">{(Number(r.stock.assetIn) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 6 })} · <span className="mono">{short(r.stock.asset, 4)}</span></dd>
                <dt>Chainlink price</dt><dd>${(Number(r.stock.priceUsd8) / 1e8).toFixed(2)} per share</dd>
                <dt>You received</dt><dd>{usdc(r.stock.usdgOut)} USDG on Robinhood Chain</dd>
                <dt>Network</dt><dd>Robinhood Chain {r.stock.chainId} (local fork)</dd>
                <dt>Block</dt><dd className="mono">{r.paymentBlock ?? "–"}</dd>
              </dl>
            ) : credit ? (
              <dl className="sd-dl">
                <dt>Type</dt><dd>Credit line (pay later)</dd>
                <dt>Line ID</dt><dd className="mono">{short(r.creditLineId, 8)} {r.creditLineId && <Copy text={r.creditLineId} />}</dd>
                <dt>Collateral</dt><dd>Stock Tokens on Robinhood Chain</dd>
                <dt>Bridged by</dt><dd>Chainlink CRE workflow</dd>
                <dt>Your risk</dt><dd>None: paid in full upfront from the credit pool</dd>
                <dt>Block</dt><dd className="mono">{r.paymentBlock ?? "–"}</dd>
              </dl>
            ) : (
            <dl className="sd-dl">
              <dt>Type</dt><dd>Zero-knowledge withdrawal</dd>
              <dt>Pool</dt><dd className="mono">{short(cfg.deployment.pool, 6)}</dd>
              <dt>Payer address</dt><dd className="sd-private">none on-chain</dd>
              <dt>Receipt commitment</dt><dd className="mono">{r.invoice.receiptCommitment ? short(r.invoice.receiptCommitment, 8) : "not bound"}</dd>
              <dt>Block</dt><dd className="mono">{r.paymentBlock ?? "–"}</dd>
            </dl>
            )}
          </section>
          {r.quote && (
            <section className="sd-panel">
              <h2>Currency conversion</h2>
              <dl className="sd-dl">
                <dt>Customer saw</dt><dd>{fiatStr(r.quote)}</dd>
                <dt>Charged</dt><dd>{usdc(r.quote.usdcAmount)} USDC</dd>
                {r.quote.rate && <><dt>Rate</dt><dd>1 {r.quote.currency} = {Number(r.quote.rate).toFixed(6)} USDC</dd></>}
                {r.quote.fiatUsd && <><dt>{r.quote.currency}/USD round</dt><dd className="mono">{r.quote.fiatUsd.roundId}</dd></>}
                {r.quote.usdcUsd && <><dt>USDC/USD round</dt><dd className="mono">{r.quote.usdcUsd.roundId}</dd></>}
                <dt>Oracle</dt><dd>Chainlink Data Feeds · Arc mainnet</dd>
              </dl>
              {r.rateCheck && (() => { const rc = r.rateCheck; return <p className={`sd-ratecheck ${rc.verified ? "ok" : ""}`}>{rc.verified ? <Icon.check /> : <Icon.clock />}<span><b>{rc.verified ? "Rate verified on-chain" : "Not verified on-chain"}</b> · {rc.detail}</span></p>; })()}
              <OnchainQuote cfg={cfg} q={r.quote} />
            </section>
          )}
        </div>
      </div>
      {refunding && <RefundModal r={r} token={token} onClose={() => setRefunding(false)} onDone={() => { setRefunding(false); onDone(); }} />}
    </>
  );
}

const oracleAbi = parseAbi(["function quote(string currency, uint256 fiatAmount) view returns (uint256 usdcAmount, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId, uint256 oldestUpdatedAt)", "function lastSourceBlock() view returns (uint64)"]);
/** Re-quotes the invoice on Arc itself, from NorenRateOracle, whose rates the Chainlink CRE pricing workflow wrote. */
function OnchainQuote({ cfg, q }: { cfg: Config; q: Quote }) {
  const oracle = (creditOf(cfg) as { rateOracle?: `0x${string}` } | null)?.rateOracle;
  const [v, setV] = useState<{ usdc: bigint; block: bigint } | null>(null);
  const [e, setE] = useState<string | null>(null);
  useEffect(() => {
    if (!oracle) return;
    const c = createPublicClient({ transport: http(cfg.rpcUrl) });
    Promise.all([c.readContract({ address: oracle, abi: oracleAbi, functionName: "quote", args: [q.currency, BigInt(q.fiatAmount)] }), c.readContract({ address: oracle, abi: oracleAbi, functionName: "lastSourceBlock" })])
      .then(([r, b]) => setV({ usdc: r[0], block: b })).catch((x) => setE(msgOf(x)));
  }, [cfg, oracle, q.currency, q.fiatAmount]);
  if (!oracle) return null;
  return (
    <dl className="sd-dl sd-oracle">
      <dt>Same price on Arc</dt><dd>{e ? <span className="sd-err-t">{e}</span> : v ? <>{usdc(v.usdc)} USDC <span className="sd-muted">NorenRateOracle, rates written by the Chainlink CRE workflow (Arc mainnet block {String(v.block)})</span></> : "…"}</dd>
    </dl>
  );
}

function RefundModal({ r, token, onClose, onDone }: { r: Row; token: string; onClose: () => void; onDone: () => void }) {
  const [amt, setAmt] = useState(usdc(r.invoice.amount).replace(/,/g, ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const max = n6(r.invoice.amount), v = Number(amt || 0);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { if (!(v > 0) || v > max) throw new Error(`Enter an amount between 0.01 and ${fmt(max)} USDC`); await api.refund(r.invoice.invoiceId, BigInt(Math.round(v * 1e6)), token); toast(`Refunded ${fmt(v)} USDC to the customer's private inbox`); onDone(); }
    catch (e) { setErr(msgOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Refund payment" onClose={onClose} footer={<><button className="sd-btn" onClick={onClose}>Cancel</button><button className="sd-btn primary" disabled={busy} onClick={submit}>{busy ? <><span className="spin" /> Refunding…</> : "Refund"}</button></>}>
      <p className="sd-muted">The refund goes to the private refund inbox the customer fixed when they paid. You can't redirect it, and you won't learn whose it is. A payment can be refunded once.</p>
      <label className="sd-label" htmlFor="ramt">Refund amount</label>
      <div className="sd-input-money"><input id="ramt" inputMode="decimal" value={amt} autoFocus onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} /><span>USDC</span></div>
      <p className="sd-help">Up to {fmt(max)} USDC</p>
      {err && <p className="sd-error" role="alert">{err}</p>}
    </Modal>
  );
}

/* ================================================================== payment links */
function Links({ rows, onCreate, token }: { rows: Row[] | null; onCreate: () => void; token: string }) {
  const [qr, setQr] = useState<Row | null>(null);
  const links = (rows ?? []).filter((x) => x.status === "draft" || x.status === "open" || x.status === "expired");
  return (
    <>
      <PageHead title="Payment links" sub="Share a link anywhere. Customers pay privately on Noren's hosted checkout."><button className="sd-btn primary" disabled={!token} onClick={onCreate}><Icon.plus /> Create payment link</button></PageHead>
      <div className="sd-table-wrap">
        {!rows ? <div className="sd-skel-rows"><i /><i /></div> : links.length === 0 ? <Empty title="No open payment links" text="Create one to start accepting private payments. Paid links move to Payments." action={token ? <button className="sd-btn sm primary" onClick={onCreate}><Icon.plus /> Create payment link</button> : undefined} /> : (
          <table className="sd-table">
            <thead><tr><th>Link</th><th className="r">Price</th><th>Status</th><th className="hide-s">Created</th><th className="hide-s">Expires</th><th /></tr></thead>
            <tbody>{links.map((x) => (
              <tr key={x.invoice.invoiceId} onClick={() => go(`#/dashboard/payments/${x.invoice.invoiceId}`)}>
                <td><div className="sd-linkcell"><b>{x.description || "Payment"}</b><span className="mono">/pay/{short(x.invoice.invoiceId, 6)}</span></div></td>
                <td className="r num"><b>{usdc(x.invoice.amount)}</b> <span className="sd-muted">USDC</span>{x.quote && <small className="sd-sub">{fiatStr(x.quote)}</small>}</td>
                <td><Badge s={x.status} /></td>
                <td className="hide-s sd-muted">{dt(x.createdAt)}</td>
                <td className="hide-s sd-muted">{dt(x.invoice.expiry)}</td>
                <td className="r">{x.status !== "expired" && <span className="sd-row-act"><button className="sd-btn xs" onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(payLink(x.invoice.invoiceId)); toast("Link copied"); }}>Copy link</button><button className="sd-btn xs" onClick={(e) => { e.stopPropagation(); setQr(x); }}>QR</button></span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {qr && <Modal title="Scan to pay" onClose={() => setQr(null)}><div className="sd-qr-wrap"><QR text={payLink(qr.invoice.invoiceId)} size={220} /><b>{usdc(qr.invoice.amount)} USDC</b><span className="sd-muted">{qr.description || "Payment"}</span><Copy text={payLink(qr.invoice.invoiceId)} label="Copy link" /></div></Modal>}
    </>
  );
}

function CreateLink({ cfg, token, shop, onClose, onDone }: { cfg: Config; token: string; shop: string; onClose: () => void; onDone: (id: string) => void }) {
  const [currency, setCurrency] = useState("USDC");
  const [amount, setAmount] = useState("7.50");
  const [desc, setDesc] = useState("");
  const [mins, setMins] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [currencies, setCurrencies] = useState<Currency[] | null>(null);
  const [priceErr, setPriceErr] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const cur = currencies?.find((c) => c.code === currency);
  useEffect(() => { fetch(`${SERVER}/pricing/currencies`).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`); return r.json(); }).then((l) => setCurrencies((Array.isArray(l) ? l : l.currencies ?? []).filter((c: Currency) => c.code !== "USDC"))).catch((e) => setPriceErr(msgOf(e))); }, []);
  const minor = useMemo(() => { const d = cur?.decimals ?? 2; const v = Number(amount || 0); return v > 0 ? BigInt(Math.round(v * 10 ** d)) : 0n; }, [amount, cur]);
  const tRef = useRef<number>();
  useEffect(() => {
    setQuote(null); if (currency === "USDC" || minor <= 0n) return;
    clearTimeout(tRef.current);
    tRef.current = window.setTimeout(() => { fetch(`${SERVER}/pricing/quote?currency=${currency}&amount=${minor}`).then(async (r) => { const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`); return j; }).then((q) => { setQuote(q); setPriceErr(null); }).catch((e) => setPriceErr(msgOf(e))); }, 300);
  }, [currency, minor]);
  const usdcAmount = currency === "USDC" ? Number(amount || 0) : quote ? n6(quote.usdcAmount) : null;
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const expiry = Math.floor(Date.now() / 1000) + mins * 60;
      const body = currency === "USDC" ? { amount: String(Math.round(Number(amount) * 1e6)), expiry: String(expiry), ...(desc.trim() ? { description: desc.trim() } : {}) } : { currency, fiatAmount: minor.toString(), expiry: String(expiry), ...(desc.trim() ? { description: desc.trim() } : {}) };
      if (currency === "USDC" && !(Number(amount) > 0)) throw new Error("Enter an amount above 0");
      const res = await fetch(`${SERVER}/merchants/${cfg.merchant}/invoices`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => null); if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      toast("Payment link created"); navigator.clipboard?.writeText(payLink(j.invoice.invoiceId)).catch(() => {}); onDone(j.invoice.invoiceId);
    } catch (e) { setErr(msgOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal wide title="Create a payment link" onClose={onClose} footer={<><span className="sd-muted sm">The link is copied when you create it.</span><button className="sd-btn" onClick={onClose}>Cancel</button><button className="sd-btn primary" disabled={busy || !token || !(usdcAmount && usdcAmount > 0)} onClick={create}>{busy ? <><span className="spin" /> Creating…</> : "Create link"}</button></>}>
      <div className="sd-builder">
        <div className="sd-builder-form">
          <label className="sd-label" htmlFor="cl-desc">Product or service</label>
          <input id="cl-desc" className="sd-input" maxLength={120} placeholder="Flat white" value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus />
          <p className="sd-help">Only you and the customer see this. It never goes on-chain.</p>
          <label className="sd-label" htmlFor="cl-amt">Price</label>
          <div className="sd-input-money">
            <input id="cl-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
              <option value="USDC">USDC</option>
              {(currencies ?? []).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          </div>
          {currency !== "USDC" ? (
            <div className="sd-quote">
              <span className="sd-cl-badge"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden><path d="M12 2 3.5 7v10L12 22l8.5-5V7z" fill="none" stroke="currentColor" strokeWidth="2.2" /></svg>Chainlink</span>
              {quote ? <span>Customer pays <b>{fmt(n6(quote.usdcAmount))} USDC</b> · 1 {currency} = {quote.rate ? Number(quote.rate).toFixed(4) : "…"} USDC · {currency}/USD round <span className="mono">{quote.fiatUsd?.roundId ? String(quote.fiatUsd.roundId).slice(-6) : "…"}</span></span> : priceErr ? <span className="sd-err-t">{priceErr}</span> : <span className="sd-muted"><span className="spin xs" /> Reading Chainlink feeds…</span>}
            </div>
          ) : <p className="sd-help">{currencies ? `Or price in ${currencies.slice(0, 4).map((c) => c.code).join(", ")}… converted at the Chainlink rate.` : priceErr ? `Fiat pricing unavailable: ${priceErr}` : "Loading currencies…"}</p>}
          <label className="sd-label">Link expires after</label>
          <div className="sd-seg full">{[15, 30, 60, 1440].map((m) => <button key={m} aria-pressed={mins === m} onClick={() => setMins(m)}>{m < 60 ? `${m} min` : m === 60 ? "1 hour" : "24 hours"}</button>)}</div>
          {currency !== "USDC" && <p className="sd-help">The rate is locked until the link expires, like an FX quote. The customer's proof then fixes the USDC amount on-chain.</p>}
          {err && <p className="sd-error" role="alert">{err}</p>}
        </div>
        <div className="sd-builder-preview" aria-label="Checkout preview">
          <span className="sd-eyebrow">Preview</span>
          <div className="sd-prev">
            <div className="sd-prev-l"><span className="sd-prev-shop"><i>{shop.slice(0, 1).toUpperCase()}</i>{shop}</span><small>Pay {shop}</small><b>{usdcAmount !== null ? fmt(usdcAmount) : "…"}<em>USDC</em></b>{currency !== "USDC" && <small className="sd-prev-fiat">{amount} {currency}</small>}<span className="sd-prev-line"><span>{desc || "Payment"}</span><span>{usdcAmount !== null ? fmt(usdcAmount) : "…"}</span></span></div>
            <div className="sd-prev-r"><span>Pay <em>privately</em></span><i /><i /><i /><span className="sd-prev-btn">Pay {usdcAmount !== null ? fmt(usdcAmount) : ""} USDC</span></div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== developers */
function Developers({ cfg, token, setToken, sub, tick, store, session, onStores }: { cfg: Config; token: string; setToken: (t: string) => void; sub?: string; tick: number; store: StoreView | null; session: Session | null; onStores: () => void }) {
  const t = sub === "webhooks" || sub === "events" ? sub : "keys";
  return (
    <>
      <PageHead title={t === "keys" ? "API keys" : t === "webhooks" ? "Webhooks" : "Events"} sub={t === "keys" ? "Authenticate requests to your Noren server." : t === "webhooks" ? "Get a signed POST when payments settle." : "Everything that happened, with each webhook delivery."} />
      {t === "keys" && (store && session ? <StoreKeys store={store} session={session} onChange={onStores} /> : <Keys cfg={cfg} token={token} setToken={setToken} />)}
      {t === "webhooks" && <Hooks cfg={cfg} token={token} tick={tick} />}
      {t === "events" && <Events cfg={cfg} token={token} tick={tick} />}
    </>
  );
}

/** A signed-in store's keys: publishable key, secret keys by prefix (the server keeps only hashes), roll and revoke. */
function StoreKeys({ store, session, onChange }: { store: StoreView; session: Session; onChange: () => void }) {
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (path: string, method: string) => { const r = await fetch(`${SERVER}${path}`, { method, headers: { authorization: `Bearer ${session.session}` } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j; };
  const act = async (k: string, f: () => Promise<void>) => { setBusy(k); try { await f(); onChange(); } catch (e) { toast(msgOf(e), "err"); } finally { setBusy(null); } };
  return (
    <>
      <div className="sd-table-wrap">
        <table className="sd-table static">
          <thead><tr><th>Name</th><th>Token</th><th className="hide-s">Created</th><th /></tr></thead>
          <tbody>
            <tr><td><b>Publishable key</b><small className="sd-sub">safe in a browser</small></td><td className="mono">{store.publishableKey}</td><td className="hide-s sd-muted">{dt(store.createdAt)}</td><td className="r"><Copy text={store.publishableKey} /></td></tr>
            <tr><td><b>Merchant ID</b><small className="sd-sub">on-chain, registered on Arc</small></td><td className="mono">{short(store.merchant, 10)}</td><td className="hide-s sd-muted mono">{short(store.registerTx, 6)}</td><td className="r"><Copy text={store.merchant} /></td></tr>
            {store.keys.map((k) => (
              <tr key={k.id}><td><b>Secret key</b><small className="sd-sub">{k.revokedAt ? `revoked ${dt(k.revokedAt)}` : "test mode"}</small></td><td className="mono">{k.prefix}{"•".repeat(16)}</td><td className="hide-s sd-muted">{dt(k.createdAt)}</td><td className="r">{!k.revokedAt && <button className="sd-btn xs" disabled={!!busy} onClick={() => { if (confirm("Revoke this secret key? Requests using it fail immediately.")) act(k.id, async () => { await call(`/stores/${store.id}/keys/${k.id}`, "DELETE"); toast("Secret key revoked"); }); }}>{busy === k.id ? "Revoking…" : "Revoke"}</button>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="sd-panel narrow">
        <h2>Secret keys</h2>
        <p className="sd-muted">Noren stores only a hash of each secret key, so a key is shown once, when you create it.</p>
        {fresh && <div className="sd-secret"><code className="mono">{fresh}</code><Copy text={fresh} /></div>}
        <div className="sd-row"><button className="sd-btn primary" disabled={!!busy} onClick={() => act("new", async () => { const r = await call(`/stores/${store.id}/keys`, "POST"); setFresh(r.secretKey); toast("New secret key created"); })}>{busy === "new" ? "Creating…" : "Create secret key"}</button></div>
      </section>
    </>
  );
}

function Keys({ cfg, token, setToken }: { cfg: Config; token: string; setToken: (t: string) => void }) {
  const [show, setShow] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <>
      <div className="sd-table-wrap">
        <table className="sd-table static">
          <thead><tr><th>Name</th><th>Token</th><th className="hide-s">Used for</th><th /></tr></thead>
          <tbody>
            <tr><td><b>Merchant ID</b><small className="sd-sub">publishable</small></td><td className="mono">{short(cfg.merchant, 10)}</td><td className="hide-s sd-muted">Public reads, checkout, profile</td><td className="r"><Copy text={cfg.merchant} /></td></tr>
            <tr><td><b>Secret key</b><small className="sd-sub">test mode</small></td><td className="mono">{token ? (show ? token : `${token.slice(0, 6)}${"•".repeat(18)}${token.slice(-4)}`) : <span className="sd-muted">not added in this browser</span>}</td><td className="hide-s sd-muted">Create links, refund, webhooks, events</td><td className="r">{token && <span className="sd-row-act"><button className="sd-btn xs" onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Reveal"}</button><button className="sd-btn xs" onClick={() => { setToken(""); toast("Secret key removed from this browser"); }}>Remove</button></span>}</td></tr>
          </tbody>
        </table>
      </div>
      {!token && (
        <section className="sd-panel narrow">
          <h2>Add your secret key</h2>
          <p className="sd-muted">Paste the merchant token that <code>pnpm dev:stack</code> printed. It's stored in this browser only and sent only to {SERVER}.</p>
          <div className="sd-row"><input className="sd-input mono" type="password" placeholder="Merchant token" value={draft} onChange={(e) => setDraft(e.target.value.trim())} aria-label="Secret key" autoComplete="off" /><button className="sd-btn primary" disabled={!draft} onClick={() => { setToken(draft); setDraft(""); toast("Secret key saved in this browser"); }}>Save</button></div>
        </section>
      )}
      <div className="sd-detail-grid">
        <section className="sd-panel">
          <h2>Environment</h2>
          <dl className="sd-dl">
            <dt>API base</dt><dd className="mono">{SERVER} <Copy text={SERVER} /></dd>
            <dt>Checkout contract</dt><dd className="mono">{short(cfg.deployment.checkout, 8)} <Copy text={cfg.deployment.checkout} /></dd>
            <dt>Privacy pool</dt><dd className="mono">{short(cfg.deployment.pool, 8)} <Copy text={cfg.deployment.pool} /></dd>
            <dt>Entrypoint</dt><dd className="mono">{short(cfg.deployment.entrypoint, 8)}</dd>
            <dt>Network</dt><dd>{isFork(cfg) ? "Arc testnet fork" : "Arc testnet"} · {cfg.chainId}</dd>
          </dl>
        </section>
        <section className="sd-panel sd-code">
          <h2>Quickstart</h2>
          <pre>{`import { createNoren } from "@noren/core/merchant";

const noren = createNoren({
  server: "${SERVER}",
  token: process.env.NOREN_SECRET_KEY,
  merchant: "${cfg.merchant}",
});

await noren.invoices.create({
  currency: "EUR", fiatAmount: 690n,   // €6.90 at the Chainlink rate
  description: "Flat white", expiresIn: 1800,
});`}</pre>
        </section>
      </div>
    </>
  );
}

function Hooks({ cfg, token, tick }: { cfg: Config; token: string; tick: number }) {
  const [list, setList] = useState<Webhook[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [fresh, setFresh] = useState<Webhook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<NorenEvent[]>([]);
  const load = useCallback(() => { if (!token) { setList([]); return; } api.webhooks(cfg.merchant, token).then(setList).catch((e) => { setErr(msgOf(e)); setList([]); }); api.eventLog(cfg.merchant, token).then(setEvents).catch(() => setEvents([])); }, [cfg, token]);
  useEffect(load, [load, tick]);
  const add = async () => { setBusy(true); setErr(null); try { const w = await api.addWebhook(cfg.merchant, url.trim(), token); setFresh(w); setUrl(""); setAdding(false); load(); } catch (e) { setErr(msgOf(e)); } finally { setBusy(false); } };
  const del = async (id: string) => { try { await api.deleteWebhook(cfg.merchant, id, token); toast("Endpoint removed"); load(); } catch (e) { toast(msgOf(e), "err"); } };
  const stats = (id: string) => { const d = events.flatMap((e) => (e.deliveries ?? []).filter((x) => x.endpointId === id)); return { total: d.length, ok: d.filter((x) => x.ok).length }; };
  return (
    <>
      <div className="sd-head-act end"><button className="sd-btn primary" disabled={!token} onClick={() => setAdding(true)}><Icon.plus /> Add endpoint</button></div>
      {err && <p className="sd-error">{err}</p>}
      {fresh?.secret && (
        <div className="sd-callout ok"><Icon.lock /><span><b>Signing secret for {fresh.url}</b>, shown once. Verify the <code>noren-signature</code> header with it.<code className="sd-secret">{fresh.secret}</code></span><span className="sd-row-act"><Copy text={fresh.secret} label="Copy secret" /><button className="sd-btn xs" onClick={() => setFresh(null)}>Done</button></span></div>
      )}
      <div className="sd-table-wrap">
        {!list ? <div className="sd-skel-rows"><i /></div> : list.length === 0 ? <Empty title="No webhook endpoints" text={token ? "Add an endpoint to receive invoice.created, invoice.bound, payment.succeeded and refund.succeeded." : "Add your secret key under API keys first."} /> : (
          <table className="sd-table static">
            <thead><tr><th>Endpoint</th><th className="hide-s">Deliveries</th><th className="hide-s">Created</th><th /></tr></thead>
            <tbody>{list.map((w) => { const s = stats(w.id); return (
              <tr key={w.id}><td><b className="mono sd-break">{w.url}</b><small className="sd-sub mono">{w.id}</small></td><td className="hide-s">{s.total ? <span className={`sd-badge ${s.ok === s.total ? "ok" : "bad"}`}>{s.ok}/{s.total} succeeded</span> : <span className="sd-muted">none yet</span>}</td><td className="hide-s sd-muted">{dt(w.createdAt)}</td><td className="r"><Menu trigger={(o) => <button className="sd-icon-btn sm" onClick={o} aria-label="Endpoint actions">⋯</button>} items={[["Copy URL", () => { navigator.clipboard?.writeText(w.url); toast("URL copied"); }], ["Remove endpoint", () => del(w.id)]]} /></td></tr>
            ); })}</tbody>
          </table>
        )}
      </div>
      <section className="sd-panel sd-code">
        <h2>Verify a delivery</h2>
        <pre>{`import { verifyWebhook } from "@noren/core/merchant";

// noren-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, \`\${t}.\${rawBody}\`)>
const event = await verifyWebhook(rawBody, req.headers["noren-signature"], secret);
if (event.type === "payment.succeeded") fulfil(event.data.invoiceId);`}</pre>
      </section>
      {adding && (
        <Modal title="Add a webhook endpoint" onClose={() => setAdding(false)} footer={<><button className="sd-btn" onClick={() => setAdding(false)}>Cancel</button><button className="sd-btn primary" disabled={busy || !url.trim()} onClick={add}>{busy ? <span className="spin" /> : "Add endpoint"}</button></>}>
          <label className="sd-label" htmlFor="wh">Endpoint URL</label>
          <input id="wh" className="sd-input mono" placeholder="https://your-shop.example/noren" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
          <p className="sd-help">All four events are sent, signed with HMAC-SHA256, and retried 3 times (after 1 s and 4 s).</p>
          {err && <p className="sd-error">{err}</p>}
        </Modal>
      )}
    </>
  );
}

function Events({ cfg, token, tick }: { cfg: Config; token: string; tick: number }) {
  const [list, setList] = useState<NorenEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<NorenEvent | null>(null);
  const [type, setType] = useState("all");
  useEffect(() => { if (!token) { setList([]); return; } api.eventLog(cfg.merchant, token).then((l) => { setList(l); setErr(null); }).catch((e) => { setErr(msgOf(e)); setList([]); }); }, [cfg, token, tick]);
  const types = ["all", ...Array.from(new Set((list ?? []).map((e) => e.type)))];
  const shown = (list ?? []).filter((e) => type === "all" || e.type === type);
  const cur = sel && shown.find((e) => e.id === sel.id) ? sel : shown[0] ?? null;
  return (
    <>
      <div className="sd-filters">{types.map((t) => <button key={t} className={`sd-chip ${type === t ? "on" : ""}`} onClick={() => setType(t)}>{t === "all" ? "All events" : t}</button>)}</div>
      {err && <p className="sd-error">{err}</p>}
      {!token ? <div className="sd-table-wrap"><Empty title="Add your secret key" text="The event log is private to the merchant." /></div> : !list ? <div className="sd-table-wrap"><div className="sd-skel-rows"><i /><i /></div></div> : shown.length === 0 ? <div className="sd-table-wrap"><Empty title="No events yet" text="Create a payment link to emit invoice.created." /></div> : (
        <div className="sd-split">
          <ul className="sd-evlist">{shown.map((e) => { const d = e.deliveries ?? []; const ok = d.some((x) => x.ok); return (
            <li key={e.id}><button aria-current={cur?.id === e.id} onClick={() => setSel(e)}><code>{e.type}</code><span className="sd-muted">{dt(e.created)}</span><span className={`sd-dot ${d.length === 0 ? "" : ok ? "ok" : "bad"}`} title={d.length === 0 ? "No endpoints" : ok ? "Delivered" : "Failed"} /></button></li>
          ); })}</ul>
          {cur && (
            <section className="sd-evdetail">
              <header><code>{cur.type}</code><span className="sd-muted mono">{cur.id}</span></header>
              {String(cur.data?.invoiceId ?? "") && <a className="sd-link" href={`#/dashboard/payments/${cur.data.invoiceId}`}>View payment <Icon.arrow /></a>}
              <h3>Event data</h3>
              <pre>{JSON.stringify({ id: cur.id, type: cur.type, created: cur.created, data: cur.data }, null, 2)}</pre>
              <h3>Webhook attempts</h3>
              {(cur.deliveries ?? []).length === 0 ? <p className="sd-muted">No endpoints were registered when this happened.</p> : <ul className="sd-deliv">{cur.deliveries!.map((x, i) => <li key={i}><span className={`sd-badge ${x.ok ? "ok" : "bad"}`}>{x.status ?? "error"}</span><span className="mono sd-break">{x.url}</span><span className="sd-muted">try {x.attempt}{x.ms !== undefined ? ` · ${x.ms} ms` : ""}{x.error ? ` · ${x.error}` : ""}</span></li>)}</ul>}
            </section>
          )}
        </div>
      )}
    </>
  );
}

/* ================================================================== settings */
function Settings({ cfg, token, name, onSaved }: { cfg: Config; token: string; name: string | null; onSaved: (n: string) => void }) {
  const [v, setV] = useState(name ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (name) setV(name); }, [name]);
  const save = async () => { setBusy(true); try { const p = await api.setProfile(cfg.merchant, v.trim(), token); onSaved(p.name ?? ""); toast("Business name saved. Your checkout shows it now."); } catch (e) { toast(msgOf(e), "err"); } finally { setBusy(false); } };
  return (
    <>
      <PageHead title="Settings" />
      <section className="sd-panel narrow">
        <h2>Public details</h2>
        <label className="sd-label" htmlFor="bn">Business name</label>
        <div className="sd-row"><input id="bn" className="sd-input" maxLength={48} value={v} placeholder="Takumi Coffee" onChange={(e) => setV(e.target.value)} /><button className="sd-btn primary" disabled={!token || busy || !v.trim() || v.trim() === name} onClick={save}>{busy ? <span className="spin" /> : "Save"}</button></div>
        <p className="sd-help">Shown on your hosted checkout. It's the only thing customers learn about you, and they show you nothing at all.</p>
      </section>
      <section className="sd-panel narrow">
        <h2>Settlement</h2>
        <dl className="sd-dl">
          <dt>Payout address</dt><dd className="mono">{short(cfg.merchant, 10)} <Copy text={cfg.merchant} /></dd>
          <dt>Asset</dt><dd>USDC (6 decimals)</dd>
          <dt>Compliance</dt><dd>Deposits are screened against USDC's blacklist by the ASP before they can pay you</dd>
          <dt>Pricing</dt><dd>USDC, or fiat converted with Chainlink Data Feeds</dd>
        </dl>
      </section>
    </>
  );
}

/* ================================================================== command palette */
function Palette({ rows, onClose, onCreate }: { rows: Row[]; onClose: () => void; onCreate: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const pages: [string, string][] = [["Home", "#/dashboard"], ["Balances", "#/dashboard/balances"], ["Payments", "#/dashboard/payments"], ["Payment links", "#/dashboard/links"], ["API keys", "#/dashboard/developers"], ["Webhooks", "#/dashboard/developers/webhooks"], ["Events", "#/dashboard/developers/events"], ["Settings", "#/dashboard/settings"]];
  const ql = q.toLowerCase();
  const items: { label: string; hint: string; run: () => void }[] = [
    { label: "Create payment link", hint: "Action", run: onCreate },
    ...pages.filter(([t]) => t.toLowerCase().includes(ql)).map(([t, h]) => ({ label: t, hint: "Go to", run: () => { go(h); onClose(); } })),
    ...rows.filter((x) => !q || [x.invoice.invoiceId, x.description, x.paymentTx, usdc(x.invoice.amount)].some((v) => v && String(v).toLowerCase().includes(ql))).slice(0, 8).map((x) => ({ label: `${usdc(x.invoice.amount)} USDC · ${x.description || short(x.invoice.invoiceId, 8)}`, hint: STATUS[x.status]?.[0] ?? x.status, run: () => { go(`#/dashboard/payments/${x.invoice.invoiceId}`); onClose(); } })),
  ].filter((it) => !q || it.label.toLowerCase().includes(ql) || it.hint === "Succeeded" || it.hint === "Refunded" || it.hint === "Incomplete" || it.hint === "Link sent" || it.hint === "Expired");
  useEffect(() => setI(0), [q]);
  return (
    <div className="sd-modal-bg top" onMouseDown={onClose}>
      <div className="sd-palette" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Search payments, pages and actions…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
          else if (e.key === "Enter") items[i]?.run();
          else if (e.key === "Escape") onClose();
        }} aria-label="Search" />
        <ul>{items.length === 0 ? <li className="sd-muted pad">Nothing matches “{q}”.</li> : items.map((it, k) => <li key={it.label + k}><button aria-current={k === i} onMouseEnter={() => setI(k)} onClick={it.run}><span>{it.label}</span><em>{it.hint}</em></button></li>)}</ul>
        <footer className="mono"><span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span></footer>
      </div>
    </div>
  );
}
