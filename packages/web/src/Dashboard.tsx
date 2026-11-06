import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, secs, short, toBase, usdc, when, SERVER, type Config, type InvoiceView, type NorenEvent, type Webhook } from "./api";
import { Copy, Icon, Logo, Setup, TxRef, isFork, msgOf } from "./ui";

type Tab = "home" | "payments" | "links" | "developers" | "settings";
const TOKEN_KEY = "noren.merchant.token";
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
const link = (id: string) => `${location.origin}${location.pathname}#/pay/${id}`;
const label = (s: string) => ({ paid: "Succeeded", refunded: "Refunded", open: "Awaiting payment", draft: "Link sent", expired: "Expired" } as Record<string, string>)[s] ?? s;
const tone = (s: string) => ({ paid: "moss", refunded: "kaki", open: "ink", draft: "ink", expired: "grey" } as Record<string, string>)[s] ?? "ink";

export function Dashboard({ tab, sub }: { tab: Tab; sub?: string }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<InvoiceView[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [token, setTokenState] = useState(readToken);
  const [tick, setTick] = useState(0);
  const [menu, setMenu] = useState(false);
  const setToken = (t: string) => { setTokenState(t); try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } };

  useEffect(() => { api.config().then(setCfg).catch((e) => setErr(msgOf(e))); }, []);
  const refresh = useCallback(async () => {
    if (!cfg) return;
    try { setRows(await api.listInvoices(cfg.merchant)); } catch (e) { setErr(msgOf(e)); }
    api.profile(cfg.merchant).then((p) => setName(p.name)).catch(() => { /* older server: no profile endpoint */ });
    setTick((t) => t + 1);
  }, [cfg]);
  useEffect(() => {
    if (!cfg) return;
    refresh();
    const es = api.events();
    const on = () => refresh();
    ["message", "invoice_created", "invoice_bound", "paid", "refunded"].forEach((t) => es.addEventListener(t, on));
    return () => es.close();
  }, [cfg, refresh]);
  useEffect(() => setMenu(false), [tab, sub]);

  const nav: [Tab, string, () => JSX.Element][] = [["home", "Home", Icon.home], ["payments", "Payments", Icon.card], ["links", "Payment links", Icon.link], ["developers", "Developers", Icon.code], ["settings", "Settings", Icon.gear]];
  const shop = name ?? "Your shop";

  return (
    <div className="db">
      <aside className={`db-side ${menu ? "open" : ""}`}>
        <div className="db-side-top">
          <a className="db-brand" href="#/"><Logo /><span>Noren</span></a>
          <button className="db-menu btn ghost icon" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}><Icon.menu /></button>
        </div>
        <div className="db-acct">
          <span className="db-avatar" aria-hidden>{shop.slice(0, 1).toUpperCase()}</span>
          <div><b>{shop}</b><span className="mono">{cfg ? short(cfg.merchant, 8) : "…"}</span></div>
        </div>
        <nav className="db-nav">
          {nav.map(([k, t, I]) => <a key={k} href={`#/dashboard${k === "home" ? "" : `/${k}`}`} aria-current={tab === k ? "page" : undefined}><I /><span>{t}</span>{k === "payments" && rows && rows.length > 0 && <em>{rows.length}</em>}</a>)}
        </nav>
        <div className="db-side-foot">
          <span className="testmode"><i />Test mode</span>
          <p>{cfg ? (isFork(cfg) ? "Arc testnet fork · chain 5042002" : `Arc testnet · chain ${cfg.chainId}`) : "Connecting…"}</p>
        </div>
      </aside>

      <main className="db-main">
        {err ? <Setup err={err} /> : !cfg ? <div className="db-loading"><span className="spin" /> Connecting to {SERVER}…</div> : (
          <>
            {!token && tab !== "developers" && (
              <div className="banner"><Icon.lock /><span>Add your secret key to create links, refund and manage webhooks.</span><a className="btn ink sm" href="#/dashboard/developers">Add key</a></div>
            )}
            {tab === "home" && <HomeTab rows={rows} shop={shop} />}
            {tab === "payments" && <PaymentsTab rows={rows} cfg={cfg} token={token} sel={sub} onDone={refresh} />}
            {tab === "links" && <LinksTab rows={rows} cfg={cfg} token={token} onDone={refresh} />}
            {tab === "developers" && <DevTab cfg={cfg} token={token} setToken={setToken} sub={sub} tick={tick} />}
            {tab === "settings" && <SettingsTab cfg={cfg} token={token} name={name} onSaved={(n) => setName(n)} />}
          </>
        )}
      </main>
    </div>
  );
}

const Head = ({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) => (
  <header className="db-head"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>{children && <div className="db-head-act">{children}</div>}</header>
);

/* ------------------------------------------------------------------ home */
function HomeTab({ rows, shop }: { rows: InvoiceView[] | null; shop: string }) {
  const s = useMemo(() => {
    const r = rows ?? [];
    const settled = r.filter((x) => x.status === "paid" || x.status === "refunded");
    const gross = settled.reduce((a, x) => a + BigInt(x.invoice.amount), 0n);
    const refunds = r.reduce((a, x) => a + (x.refundAmount ? BigInt(x.refundAmount) : 0n), 0n);
    const open = r.filter((x) => x.status === "open" || x.status === "draft").length;
    return { gross, refunds, net: gross - refunds, count: settled.length, refundCount: r.filter((x) => x.status === "refunded").length, open, settled };
  }, [rows]);
  return (
    <>
      <Head title={<>{greeting()}, <em>{shop}</em></>} sub="Everything here is read from your merchant server and the chain. Nothing about your customers is." />
      <div className="kpis">
        <Kpi k="Gross volume" v={usdc(s.gross)} u="USDC" note={`${s.count} payment${s.count === 1 ? "" : "s"}`} />
        <Kpi k="Net volume" v={usdc(s.net)} u="USDC" note="after refunds" />
        <Kpi k="Refunded" v={usdc(s.refunds)} u="USDC" note={`${s.refundCount} refund${s.refundCount === 1 ? "" : "s"}`} />
        <Kpi k="Customers identified" v="0" note={`of ${s.count} paying customers`} accent />
      </div>
      <div className="db-grid2">
        <section className="panel">
          <div className="panel-h"><h2>Volume, last 24 hours</h2><span className="faint sm">USDC by hour</span></div>
          <Chart rows={s.settled} />
        </section>
        <section className="panel">
          <div className="panel-h"><h2>Privacy ledger</h2></div>
          <ul className="ledger">
            <li><span>Payer addresses stored</span><b>0</b></li>
            <li><span>Payments relayed by you</span><b>{s.count}</b></li>
            <li><span>Refunds to private inboxes</span><b>{s.refundCount}</b></li>
            <li><span>Links awaiting payment</span><b>{s.open}</b></li>
          </ul>
          <p className="faint sm">The proof binds each payment to its invoice, so you know it was paid in full without learning who paid.</p>
        </section>
      </div>
      <section className="panel">
        <div className="panel-h"><h2>Recent payments</h2><a className="btn ghost sm" href="#/dashboard/payments">View all <Icon.arrow /></a></div>
        <PayTable rows={(rows ?? []).slice(0, 6)} loading={!rows} compact />
      </section>
    </>
  );
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const Kpi = ({ k, v, u, note, accent }: { k: string; v: string; u?: string; note?: string; accent?: boolean }) => (
  <div className={`kpi ${accent ? "accent" : ""}`}><span>{k}</span><b>{v}{u && <em>{u}</em>}</b>{note && <small>{note}</small>}</div>
);

function Chart({ rows }: { rows: InvoiceView[] }) {
  const now = Math.floor(Date.now() / 1000), hour = 3600, start = Math.floor(now / hour) * hour - 23 * hour;
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const r of rows) { const t = secs(r.paidAt); if (!t || t < start) continue; const i = Math.min(23, Math.floor((t - start) / hour)); buckets[i] += Number(BigInt(r.invoice.amount)) / 1e6; }
  const max = Math.max(...buckets);
  if (max === 0) return <div className="empty sm"><b>No payments in the last 24 hours</b><span>Create a payment link and pay it to see it here.</span></div>;
  const top = niceMax(max);
  return (
    <div className="chart" role="img" aria-label={`Hourly USDC volume, peak ${max.toFixed(2)} USDC`}>
      <div className="chart-y mono"><span>{top}</span><span>{top / 2}</span><span>0</span></div>
      <div className="chart-bars">
        {buckets.map((b, i) => <div key={i} className="bar" title={`${new Date((start + i * hour) * 1000).toLocaleTimeString([], { hour: "2-digit" })}: ${b.toFixed(2)} USDC`}><i style={{ height: `${(b / top) * 100}%` }} data-on={b > 0} /></div>)}
      </div>
      <div className="chart-x mono"><span>{new Date(start * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span>now</span></div>
    </div>
  );
}
const niceMax = (m: number) => { const p = 10 ** Math.floor(Math.log10(m)); const n = m / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };

/* ------------------------------------------------------------------ payments */
function PaymentsTab({ rows, cfg, token, sel, onDone }: { rows: InvoiceView[] | null; cfg: Config; token: string; sel?: string; onDone: () => void }) {
  const [f, setF] = useState<"all" | "paid" | "refunded" | "open" | "expired">("all");
  const r = rows ?? [];
  const counts = { all: r.length, paid: r.filter((x) => x.status === "paid").length, refunded: r.filter((x) => x.status === "refunded").length, open: r.filter((x) => x.status === "open" || x.status === "draft").length, expired: r.filter((x) => x.status === "expired").length };
  const shown = r.filter((x) => f === "all" || x.status === f || (f === "open" && x.status === "draft"));
  const current = sel ? r.find((x) => x.invoice.invoiceId.toLowerCase() === sel.toLowerCase()) : undefined;
  return (
    <>
      <Head title="Payments" sub="Every payment is a zero-knowledge withdrawal from the privacy pool, relayed by you."><a className="btn ink" href="#/dashboard/links"><Icon.plus /> New payment link</a></Head>
      <div className="seg" role="tablist">
        {(["all", "paid", "refunded", "open", "expired"] as const).map((k) => <button key={k} role="tab" aria-selected={f === k} onClick={() => setF(k)}>{k === "all" ? "All" : k === "paid" ? "Succeeded" : k === "open" ? "Open" : label(k)}<em>{counts[k]}</em></button>)}
      </div>
      <section className="panel flush"><PayTable rows={shown} loading={!rows} /></section>
      {current && <Drawer r={current} cfg={cfg} token={token} onDone={onDone} />}
      {sel && rows && !current && <div className="banner warn"><span>Payment {short(sel, 10)} isn't in this merchant's records.</span></div>}
    </>
  );
}

function PayTable({ rows, loading, compact }: { rows: InvoiceView[]; loading?: boolean; compact?: boolean }) {
  if (loading) return <div className="skel">{[0, 1, 2].map((i) => <i key={i} />)}</div>;
  if (rows.length === 0) return <div className="empty"><b>No payments yet</b><span>Create a payment link, open it, and pay it privately. It shows up here the moment it settles.</span><a className="btn line sm" href="#/dashboard/links"><Icon.plus /> Create a link</a></div>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>Amount</th><th>Status</th><th className="hide-s">Description</th><th>Customer</th><th className={compact ? "hide-m" : ""}>Date</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.invoice.invoiceId} onClick={() => { location.hash = `#/dashboard/payments/${r.invoice.invoiceId}`; }} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") location.hash = `#/dashboard/payments/${r.invoice.invoiceId}`; }}>
              <td className="amt"><b>{usdc(r.invoice.amount)}</b> <span className="faint">USDC</span></td>
              <td><span className={`pill ${tone(r.status)}`}>{r.status === "paid" && <Icon.check />}{label(r.status)}</span></td>
              <td className="hide-s">{r.description || <span className="faint mono">{short(r.invoice.invoiceId, 8)}</span>}</td>
              <td className="unk">{r.status === "paid" || r.status === "refunded" ? <><Icon.eyeOff /> unknown</> : <span className="faint">–</span>}</td>
              <td className={`faint ${compact ? "hide-m" : ""}`}>{when(r.paidAt ?? r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Drawer({ r, cfg, token, onDone }: { r: InvoiceView; cfg: Config; token: string; onDone: () => void }) {
  const [amt, setAmt] = useState(() => usdc(r.invoice.amount).replace(/,/g, ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = () => { location.hash = "#/dashboard/payments"; };
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && close(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);
  const refund = async () => {
    setBusy(true); setErr(null);
    try { const v = toBase(amt); if (v <= 0n) throw new Error("Enter an amount above 0"); await api.refund(r.invoice.invoiceId, v, token); onDone(); } catch (e) { setErr(msgOf(e)); } finally { setBusy(false); }
  };
  const steps: [string, string | undefined, ReactNode][] = [
    ["Payment link created", r.createdAt as string, r.description ? `“${r.description}”` : null],
    ["Customer opened and bound it", r.boundAt as string, "Private refund inbox and receipt commitment fixed"],
    ["Proof verified, USDC received", r.paidAt as string, r.paymentTx ? <><TxRef cfg={cfg} hash={r.paymentTx} />{r.paymentGasUsed && <span className="faint"> · {Number(r.paymentGasUsed).toLocaleString()} gas</span>}</> : null],
    ["Refunded to private inbox", r.refundedAt as string, r.refundTx ? <><b>{usdc(r.refundAmount)} USDC</b> · <TxRef cfg={cfg} hash={r.refundTx} /></> : null],
  ];
  const reached = [true, !!r.invoice.receiptCommitment, r.status === "paid" || r.status === "refunded", r.status === "refunded"];
  return (
    <div className="drawer-bg" onClick={close}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Payment details">
        <div className="drawer-h"><span className="eyebrow">Payment</span><button className="btn ghost icon" onClick={close} aria-label="Close"><Icon.x /></button></div>
        <div className="drawer-amt"><b>{usdc(r.invoice.amount)}</b><em>USDC</em><span className={`pill ${tone(r.status)}`}>{label(r.status)}</span></div>
        <div className="who"><Icon.eyeOff /><div><b>Customer: unknown</b><span>Paid from a Kohaku privacy pool. There is no payer address to show, here or on-chain.</span></div></div>
        <h3>Timeline</h3>
        <ol className="tl">{steps.map(([t, at, d], i) => <li key={t} data-on={reached[i]}><i /><div><b>{t}</b><span className="faint sm">{reached[i] ? when(at) : "–"}</span>{reached[i] && d && <p>{d}</p>}</div></li>)}</ol>
        <h3>Details</h3>
        <dl className="kv">
          <dt>Invoice ID</dt><dd className="mono">{short(r.invoice.invoiceId, 12)} <Copy text={r.invoice.invoiceId} label="Copy" /></dd>
          <dt>Payment link</dt><dd><a href={`#/pay/${r.invoice.invoiceId}`} className="mono">/pay/{short(r.invoice.invoiceId, 8)}</a></dd>
          <dt>Expires</dt><dd>{when(r.invoice.expiry)}</dd>
          <dt>Receipt commitment</dt><dd className="mono">{r.invoice.receiptCommitment ? short(r.invoice.receiptCommitment, 10) : "not bound yet"}</dd>
          <dt>Settled to</dt><dd className="mono">{short(r.invoice.merchant, 8)}</dd>
          <dt>Checkout contract</dt><dd className="mono">{short(cfg.deployment.checkout, 8)}</dd>
        </dl>
        {r.status === "paid" && (
          <div className="refund">
            <h3>Refund</h3>
            <p className="faint sm">It goes to the customer's private refund inbox, which was fixed when they paid. You can't redirect it, and you won't learn whose it is.</p>
            <div className="field-row">
              <div className="money"><input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Refund amount" /><span>USDC</span></div>
              <button className="btn kaki" disabled={busy || !token} onClick={refund}>{busy ? <><span className="spin" /> Refunding…</> : <><Icon.refund /> Refund</>}</button>
            </div>
            {!token && <p className="faint sm">Add your secret key under Developers to refund.</p>}
            {err && <p className="err" role="alert">{err}</p>}
          </div>
        )}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ links */
function LinksTab({ rows, cfg, token, onDone }: { rows: InvoiceView[] | null; cfg: Config; token: string; onDone: () => void }) {
  const [amount, setAmount] = useState("7.50");
  const [desc, setDesc] = useState("");
  const [mins, setMins] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const create = async () => {
    setBusy(true); setErr(null); setMade(null);
    try {
      const base = toBase(amount); if (base <= 0n) throw new Error("Enter an amount above 0");
      const r = await api.createInvoice(cfg.merchant, base, BigInt(Math.floor(Date.now() / 1000) + mins * 60), token, desc.trim() || undefined);
      setMade(r.invoice.invoiceId); onDone();
    } catch (e) { setErr(msgOf(e)); } finally { setBusy(false); }
  };
  const links = (rows ?? []).filter((r) => r.status === "draft" || r.status === "open" || r.status === "expired");
  return (
    <>
      <Head title="Payment links" sub="Share a link. The customer pays privately on Noren's hosted checkout." />
      <div className="db-grid2 links">
        <section className="panel">
          <div className="panel-h"><h2>New link</h2></div>
          <label className="lbl" htmlFor="amt">Amount</label>
          <div className="money big"><input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span>USDC</span></div>
          <label className="lbl" htmlFor="desc">Description <span className="faint">(only you see this)</span></label>
          <input id="desc" className="input" maxLength={120} placeholder="Flat white" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <label className="lbl">Expires after</label>
          <div className="seg small">{[15, 30, 60, 1440].map((m) => <button key={m} aria-selected={mins === m} onClick={() => setMins(m)}>{m < 60 ? `${m} min` : m === 60 ? "1 hour" : "24 hours"}</button>)}</div>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn ink full lg" disabled={busy || !token} onClick={create}>{busy ? <><span className="spin" /> Creating…</> : "Create payment link"}</button>
          {!token && <p className="faint sm">Add your secret key under <a href="#/dashboard/developers">Developers</a> first.</p>}
          {made && (
            <div className="made">
              <span className="eyebrow">Link ready</span>
              <code className="mono">{link(made)}</code>
              <div className="row"><Copy text={link(made)} label="Copy link" /><a className="btn ghost xs" href={`#/pay/${made}`}>Open checkout <Icon.arrow /></a></div>
            </div>
          )}
        </section>
        <section className="panel flush">
          <div className="panel-h pad"><h2>Open links</h2><span className="faint sm">{links.length}</span></div>
          {!rows ? <div className="skel">{[0, 1].map((i) => <i key={i} />)}</div> : links.length === 0 ? <div className="empty"><b>No open links</b><span>Links that haven't been paid show up here.</span></div> : (
            <ul className="linklist">
              {links.map((r) => (
                <li key={r.invoice.invoiceId}>
                  <div><b>{usdc(r.invoice.amount)} USDC</b><span>{r.description || short(r.invoice.invoiceId, 8)}</span></div>
                  <span className={`pill ${tone(r.status)}`}>{label(r.status)}</span>
                  <span className="faint sm hide-s"><Icon.clock /> {r.status === "expired" ? "expired" : `until ${when(r.invoice.expiry)}`}</span>
                  {r.status !== "expired" && <Copy text={link(r.invoice.invoiceId)} label="Copy" />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ developers */
function DevTab({ cfg, token, setToken, sub, tick }: { cfg: Config; token: string; setToken: (t: string) => void; sub?: string; tick: number }) {
  const t = (sub === "webhooks" || sub === "events" ? sub : "keys") as "keys" | "webhooks" | "events";
  return (
    <>
      <Head title="Developers" sub="REST API, signed webhooks and the TypeScript SDK." />
      <div className="seg" role="tablist">
        {(["keys", "webhooks", "events"] as const).map((k) => <a key={k} role="tab" aria-selected={t === k} href={`#/dashboard/developers${k === "keys" ? "" : `/${k}`}`}>{k === "keys" ? "API keys" : k === "webhooks" ? "Webhooks" : "Events"}</a>)}
      </div>
      {t === "keys" && <Keys cfg={cfg} token={token} setToken={setToken} />}
      {t === "webhooks" && <Hooks cfg={cfg} token={token} />}
      {t === "events" && <Events cfg={cfg} token={token} tick={tick} />}
    </>
  );
}

function Keys({ cfg, token, setToken }: { cfg: Config; token: string; setToken: (t: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="db-grid2">
      <section className="panel">
        <div className="panel-h"><h2>Secret key</h2><span className="testmode sm"><i />Test</span></div>
        <p className="faint sm">The bearer token that creates links, refunds and manages webhooks. <span className="mono">pnpm dev:stack</span> prints one. It stays in this browser and is sent only to your own server.</p>
        <div className="field-row">
          <input className="input mono" type={show ? "text" : "password"} placeholder="Paste the merchant token" value={token} onChange={(e) => setToken(e.target.value.trim())} aria-label="Secret key" autoComplete="off" spellCheck={false} />
          <button className="btn line" onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Reveal"}</button>
        </div>
        <dl className="kv">
          <dt>API base</dt><dd className="mono">{SERVER} <Copy text={SERVER} /></dd>
          <dt>Merchant ID</dt><dd className="mono">{short(cfg.merchant, 10)} <Copy text={cfg.merchant} /></dd>
          <dt>Checkout contract</dt><dd className="mono">{short(cfg.deployment.checkout, 10)} <Copy text={cfg.deployment.checkout} /></dd>
          <dt>Privacy pool</dt><dd className="mono">{short(cfg.deployment.pool, 10)} <Copy text={cfg.deployment.pool} /></dd>
          <dt>Network</dt><dd>{isFork(cfg) ? "Arc testnet fork" : "Arc testnet"} · {cfg.chainId}</dd>
        </dl>
      </section>
      <section className="panel code-panel">
        <div className="panel-h"><h2>Quickstart</h2><span className="faint sm">@noren/core/merchant</span></div>
        <pre className="mono">{`import { createNoren } from "@noren/core/merchant";

const noren = createNoren({
  server: "${SERVER}",
  token: process.env.NOREN_SECRET_KEY,
  merchant: "${short(cfg.merchant, 10)}",
});

const { invoice } = await noren.invoices.create({
  amount: 7_500_000n,          // 7.50 USDC
  description: "Flat white",
  expiresIn: 1800,
});`}</pre>
        <pre className="mono">{`curl -X POST ${SERVER}/merchants/${short(cfg.merchant, 6)}/invoices \\
  -H "authorization: Bearer $NOREN_SECRET_KEY" \\
  -d '{"amount":"7500000","expiry":"<unix>"}'`}</pre>
      </section>
    </div>
  );
}

function Hooks({ cfg, token }: { cfg: Config; token: string }) {
  const [list, setList] = useState<Webhook[] | null>(null);
  const [url, setUrl] = useState("");
  const [fresh, setFresh] = useState<Webhook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { if (!token) { setList([]); return; } api.webhooks(cfg.merchant, token).then(setList).catch((e) => { setErr(msgOf(e)); setList([]); }); }, [cfg, token]);
  useEffect(load, [load]);
  const add = async () => { setBusy(true); setErr(null); try { const w = await api.addWebhook(cfg.merchant, url.trim(), token); setFresh(w); setUrl(""); load(); } catch (e) { setErr(msgOf(e)); } finally { setBusy(false); } };
  const del = async (id: string) => { setErr(null); try { await api.deleteWebhook(cfg.merchant, id, token); load(); } catch (e) { setErr(msgOf(e)); } };
  return (
    <div className="db-grid2">
      <section className="panel">
        <div className="panel-h"><h2>Add an endpoint</h2></div>
        <p className="faint sm">Noren POSTs <span className="mono">invoice.created</span>, <span className="mono">invoice.bound</span>, <span className="mono">payment.succeeded</span> and <span className="mono">refund.succeeded</span>, signed with HMAC-SHA256 in the <span className="mono">noren-signature</span> header. Failed deliveries are retried 3 times.</p>
        <div className="field-row"><input className="input mono" placeholder="https://your-shop.example/noren" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Endpoint URL" /><button className="btn ink" disabled={!token || busy || !url.trim()} onClick={add}>{busy ? <span className="spin" /> : <><Icon.plus /> Add</>}</button></div>
        {!token && <p className="faint sm">Add your secret key first.</p>}
        {err && <p className="err" role="alert">{err}</p>}
        {fresh?.secret && (
          <div className="made">
            <span className="eyebrow">Signing secret, shown once</span>
            <code className="mono">{fresh.secret}</code>
            <div className="row"><Copy text={fresh.secret} label="Copy secret" /><button className="btn ghost xs" onClick={() => setFresh(null)}>I've saved it</button></div>
          </div>
        )}
      </section>
      <section className="panel flush">
        <div className="panel-h pad"><h2>Endpoints</h2><span className="faint sm">{list?.length ?? 0}</span></div>
        {!list ? <div className="skel"><i /></div> : list.length === 0 ? <div className="empty"><b>No endpoints yet</b><span>Add one to get signed events when a payment settles.</span></div> : (
          <ul className="linklist">{list.map((w) => <li key={w.id}><div><b className="mono">{w.url}</b><span className="mono">{w.id} · since {when(w.createdAt)}</span></div><button className="btn ghost xs" onClick={() => del(w.id)}><Icon.x /> Remove</button></li>)}</ul>
        )}
      </section>
    </div>
  );
}

function Events({ cfg, token, tick }: { cfg: Config; token: string; tick: number }) {
  const [list, setList] = useState<NorenEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (!token) { setList([]); return; } api.eventLog(cfg.merchant, token).then((l) => { setList(l); setErr(null); }).catch((e) => { setErr(msgOf(e)); setList([]); }); }, [cfg, token, tick]);
  return (
    <section className="panel flush">
      <div className="panel-h pad"><h2>Events</h2><span className="faint sm">live · newest first</span></div>
      {err && <p className="err pad" role="alert">{err}</p>}
      {!token ? <div className="empty"><b>Add your secret key</b><span>The event log is private to the merchant.</span></div> : !list ? <div className="skel"><i /><i /></div> : list.length === 0 ? <div className="empty"><b>No events yet</b><span>Create a payment link to emit <span className="mono">invoice.created</span>.</span></div> : (
        <ul className="evlist">
          {list.map((e) => {
            const d = e.deliveries ?? [];
            const ok = d.some((x) => x.ok), failed = d.length > 0 && !ok;
            return (
              <li key={e.id} data-open={open === e.id}>
                <button onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                  <span className={`evtype ${e.type.split(".")[0]}`}>{e.type}</span>
                  <span className="mono faint hide-s">{e.id}</span>
                  <span className={`pill sm ${d.length === 0 ? "grey" : ok ? "moss" : "rust"}`}>{d.length === 0 ? "no endpoints" : ok ? `delivered${d.length > 1 ? ` · ${d.length} tries` : ""}` : failed ? `failed · ${d.length} tries` : ""}</span>
                  <span className="faint sm">{when(e.created)}</span>
                </button>
                {open === e.id && (
                  <div className="evbody">
                    <pre className="mono">{JSON.stringify({ id: e.id, type: e.type, created: e.created, data: e.data }, null, 2)}</pre>
                    {d.length > 0 && <ul className="deliv">{d.map((x, i) => <li key={i}><span className={`pill sm ${x.ok ? "moss" : "rust"}`}>{x.status ?? "error"}</span><span className="mono">{x.url}</span><span className="faint sm">try {x.attempt}{x.ms !== undefined ? ` · ${x.ms} ms` : ""}{x.error ? ` · ${x.error}` : ""}</span></li>)}</ul>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ settings */
function SettingsTab({ cfg, token, name, onSaved }: { cfg: Config; token: string; name: string | null; onSaved: (n: string) => void }) {
  const [v, setV] = useState(name ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  useEffect(() => { if (name) setV(name); }, [name]);
  const save = async () => { setBusy(true); setMsg(null); try { const p = await api.setProfile(cfg.merchant, v.trim(), token); onSaved(p.name ?? ""); setMsg({ ok: true, t: "Saved. Your checkout shows the new name." }); } catch (e) { setMsg({ ok: false, t: msgOf(e) }); } finally { setBusy(false); } };
  return (
    <>
      <Head title="Settings" />
      <section className="panel narrow">
        <div className="panel-h"><h2>Public business name</h2></div>
        <p className="faint sm">Shown to customers on your hosted checkout. It's the only thing about you they see. They show you nothing at all.</p>
        <div className="field-row"><input className="input" maxLength={48} value={v} placeholder="Takumi Coffee" onChange={(e) => setV(e.target.value)} aria-label="Business name" /><button className="btn ink" disabled={!token || busy || !v.trim()} onClick={save}>{busy ? <span className="spin" /> : "Save"}</button></div>
        {msg && <p className={msg.ok ? "note" : "err"} role="status">{msg.t}</p>}
        <dl className="kv">
          <dt>Payout address</dt><dd className="mono">{short(cfg.merchant, 10)} <Copy text={cfg.merchant} /></dd>
          <dt>Settlement asset</dt><dd>USDC (6 decimals) · {short(cfg.deployment.usdc, 8)}</dd>
          <dt>Compliance</dt><dd>Deposits screened against USDC's blacklist by the ASP postman</dd>
        </dl>
      </section>
    </>
  );
}
