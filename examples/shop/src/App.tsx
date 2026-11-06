import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { bySlug, PRODUCTS, usd, type Length, type Product, type Shade } from './catalog.ts';
import { api, bagActions, bagCount, bagTotal, eur, go, setDrawer, useBag, useConfig, useDrawer, useFx, useRoute, type Config } from './store.ts';
import integrationSource from '../server/noren.ts?raw';

const img = (slug: string) => `/products/${slug}.webp`;

export function App() {
  const route = useRoute();
  useEffect(() => { window.scrollTo({ top: 0 }); setDrawer(false); }, [route.path]);
  const parts = route.path.split('/').filter(Boolean);
  let page: ReactNode;
  if (parts.length === 0) page = <Home />;
  else if (parts[0] === 'shop') page = <Shop query={route.query} />;
  else if (parts[0] === 'p' && parts[1] && bySlug(parts[1])) page = <ProductPage product={bySlug(parts[1])!} />;
  else if (parts[0] === 'bag') page = <BagPage />;
  else if (parts[0] === 'order' && parts[1]) page = <OrderPage id={parts[1]} />;
  else if (parts[0] === 'noren') page = <IntegrationPage />;
  else page = <NotFound />;
  return (
    <>
      <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      <Announcement />
      <Header />
      <main id="main" tabIndex={-1}>{page}</main>
      <Footer />
      <Drawer />
    </>
  );
}

function Announcement() {
  return <div className="announce"><span className="hide-sm">Complimentary shipping on every order</span><span className="dot hide-sm" aria-hidden>·</span><span>Pay privately with <b>Noren</b></span></div>;
}

function Header() {
  const lines = useBag();
  const count = bagCount(lines);
  return (
    <header className="hdr">
      <nav className="hdr-nav" aria-label="Main">
        <a href="#/shop">Dresses</a>
        <a href="#/shop?tag=New" className="hide-sm">New in</a>
        <a href="#/noren" className="hide-sm">Atelier notes</a>
      </nav>
      <a className="wordmark" href="#/" aria-label="Aubelle home">Aubelle</a>
      <div className="hdr-actions">
        <button className="bag-btn" onClick={() => setDrawer(true)} aria-label={`Open bag, ${count} item${count === 1 ? '' : 's'}`}>
          <BagIcon /><span className="hide-sm">Bag</span>{count > 0 && <span className="bag-count">{count}</span>}
        </button>
      </div>
    </header>
  );
}

function BagIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M5 8h14l-1 12H6L5 8Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></svg>;
}

// ---------------- Home ----------------
function Home() {
  const newIn = PRODUCTS.filter(p => p.tag === 'New' || p.tag === 'Bestseller').slice(0, 4);
  const lengths: { name: Length; slug: string; note: string }[] = [
    { name: 'Mini', slug: 'juliette-puff', note: 'Short, sweet, a little playful' },
    { name: 'Midi', slug: 'camille-slip', note: 'The length that goes everywhere' },
    { name: 'Maxi', slug: 'seraphine-pleated', note: 'For long dinners and longer nights' },
  ];
  return (
    <>
      <section className="hero">
        <img className="hero-img" src="/editorial/hero-1.webp" alt="A rail of blush, champagne and cream dresses in a sunlit atelier" />
        <div className="hero-copy">
          <p className="eyebrow">The Rosewater edit · Autumn 2026</p>
          <h1>Dresses for the <em>soft hours.</em></h1>
          <p className="lede">Fifteen dresses in blush, rose and cream. Cut in silk, linen and lace, made to be lived in.</p>
          <div className="hero-ctas"><a className="btn btn-dark" href="#/shop">Shop the edit</a><a className="btn btn-ghost" href="#/shop?tag=New">New in</a></div>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Shop by <em>length</em></h2></div>
        <div className="lengths">
          {lengths.map(l => (
            <a key={l.name} className="length-card" href={`#/shop?length=${l.name}`}>
              <img src={img(l.slug)} alt="" loading="lazy" />
              <span className="length-name">{l.name}</span>
              <span className="length-note">{l.note}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>New <em>&amp; adored</em></h2><a className="link" href="#/shop">View all 15</a></div>
        <div className="grid">{newIn.map(p => <ProductCard key={p.slug} product={p} />)}</div>
      </section>

      <section className="editorial">
        <img src="/editorial/hero-2.webp" alt="A blush silk dress and a cream lace dress laid on linen with rose petals" />
        <div className="editorial-copy">
          <p className="eyebrow">From the atelier</p>
          <h2>Silk that remembers <em>the shape of you.</em></h2>
          <p>Our slips are cut on the bias from mulberry silk, so they fall close and move with you. Finished by hand in small runs, because we would rather sell out than overmake.</p>
          <a className="btn btn-dark" href="#/p/camille-slip">Meet the Camille</a>
        </div>
      </section>

      <section className="section">
        <IntegrationPanel />
      </section>
    </>
  );
}

// ---------------- Product card / grid ----------------
function ProductCard({ product }: { product: Product }) {
  const fx = useFx();
  return (
    <a className="card" href={`#/p/${product.slug}`}>
      <div className="card-img"><img src={img(product.slug)} alt={`${product.name}, ${product.shade.toLowerCase()} ${product.fabric.toLowerCase()} ${product.length.toLowerCase()} dress`} loading="lazy" />{product.tag && <span className="tag">{product.tag}</span>}</div>
      <div className="card-meta">
        <span className="card-name">{product.name}</span>
        <span className="card-price">{usd(product.price)}{fx && <span className="eur"> · {eur(product.price, fx)}</span>}</span>
      </div>
      <span className="card-sub">{product.fabric} · {product.length}</span>
    </a>
  );
}

const LENGTHS: Length[] = ['Mini', 'Midi', 'Maxi'];
const SHADES: Shade[] = ['Blush', 'Rose', 'Cream', 'Champagne'];
const SWATCH: Record<Shade, string> = { Blush: '#f1c9c6', Rose: '#c97f88', Cream: '#f3e8d8', Champagne: '#e6d2b0' };
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const SORTS = [['featured', 'Featured'], ['price-asc', 'Price, low to high'], ['price-desc', 'Price, high to low']] as const;

function Shop({ query }: { query: URLSearchParams }) {
  const length = query.get('length') as Length | null, shade = query.get('shade') as Shade | null, size = query.get('size'), tag = query.get('tag'), sort = query.get('sort') ?? 'featured';
  const set = (k: string, v: string | null) => { const q = new URLSearchParams(query); if (v === null || q.get(k) === v) q.delete(k); else q.set(k, v); const s = q.toString(); go(`#/shop${s ? `?${s}` : ''}`); };
  const list = useMemo(() => {
    let l = PRODUCTS.filter(p => (!length || p.length === length) && (!shade || p.shade === shade) && (!size || (p.sizes.includes(size) && !p.soldOut?.includes(size))) && (!tag || p.tag === tag));
    if (sort === 'price-asc') l = [...l].sort((a, b) => a.price - b.price);
    if (sort === 'price-desc') l = [...l].sort((a, b) => b.price - a.price);
    return l;
  }, [length, shade, size, tag, sort]);
  const active = [length, shade, size, tag].filter(Boolean).length;
  return (
    <section className="section shop">
      <div className="shop-head">
        <p className="eyebrow">{tag === 'New' ? 'Just arrived' : 'The collection'}</p>
        <h1>{tag === 'New' ? <>New <em>in</em></> : <>All <em>dresses</em></>}</h1>
      </div>
      <div className="filters" role="group" aria-label="Filters">
        <div className="filter-row">
          <span className="filter-label">Length</span>
          {LENGTHS.map(l => <button key={l} className="chip" aria-pressed={length === l} onClick={() => set('length', l)}>{l}</button>)}
        </div>
        <div className="filter-row">
          <span className="filter-label">Shade</span>
          {SHADES.map(s => <button key={s} className="chip" aria-pressed={shade === s} onClick={() => set('shade', s)}><i className="swatch" style={{ background: SWATCH[s] }} />{s}</button>)}
        </div>
        <div className="filter-row">
          <span className="filter-label">Size</span>
          {SIZES.map(s => <button key={s} className="chip chip-sq" aria-pressed={size === s} onClick={() => set('size', s)}>{s}</button>)}
        </div>
        <div className="filter-foot">
          <span className="count">{list.length} {list.length === 1 ? 'dress' : 'dresses'}{active > 0 && <button className="link-btn" onClick={() => go('#/shop')}>Clear filters</button>}</span>
          <label className="sort">Sort
            <select value={sort} onChange={e => set('sort', e.target.value === 'featured' ? null : e.target.value)}>
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>
      </div>
      {list.length ? <div className="grid">{list.map(p => <ProductCard key={p.slug} product={p} />)}</div> : (
        <div className="empty"><h2>Nothing in that <em>combination.</em></h2><p>Try another size or shade, or see everything.</p><button className="btn btn-dark" onClick={() => go('#/shop')}>Clear filters</button></div>
      )}
    </section>
  );
}

// ---------------- Product page ----------------
function ProductPage({ product }: { product: Product }) {
  const fx = useFx();
  const [size, setSize] = useState<string | null>(null);
  const [nudge, setNudge] = useState(false);
  useEffect(() => { setSize(null); setNudge(false); }, [product.slug]);
  const related = PRODUCTS.filter(p => p.slug !== product.slug && (p.shade === product.shade || p.length === product.length)).slice(0, 4);
  const add = () => { if (!size) { setNudge(true); return; } bagActions.add(product.slug, size); setDrawer(true); };
  return (
    <>
      <section className="pdp">
        <div className="pdp-img"><img src={img(product.slug)} alt={`${product.name} on a dress form`} />{product.tag && <span className="tag">{product.tag}</span>}</div>
        <div className="pdp-info">
          <nav className="crumbs" aria-label="Breadcrumb"><a href="#/shop">Dresses</a><span aria-hidden>/</span><a href={`#/shop?length=${product.length}`}>{product.length}</a></nav>
          <h1>{product.name}</h1>
          <p className="pdp-price">{usd(product.price)}{fx && <span className="eur" title={`Chainlink EUR/USD on Arc mainnet, via Noren`}>≈ {eur(product.price, fx)}</span>}</p>
          <p className="pdp-desc">{product.description}</p>
          <fieldset className="sizes">
            <legend>Size {nudge && !size && <span className="nudge" role="alert">Choose a size first</span>}</legend>
            <div className="size-row">
              {product.sizes.map(s => { const out = product.soldOut?.includes(s); return (
                <button key={s} className="size" aria-pressed={size === s} disabled={out} onClick={() => { setSize(s); setNudge(false); }} aria-label={out ? `${s}, sold out` : s}>{s}</button>
              ); })}
            </div>
          </fieldset>
          <button className="btn btn-dark btn-wide" onClick={add}>{size ? `Add to bag · ${usd(product.price)}` : 'Add to bag'}</button>
          <p className="pdp-note">Free shipping and returns · Pay privately with Noren at checkout</p>
          <details className="acc" open><summary>Details</summary><ul>{product.details.map(d => <li key={d}>{d}</li>)}</ul></details>
          <details className="acc"><summary>Fit</summary><p>True to size. Our model-free fittings use a size S dress form (bust 86 cm, waist 68 cm).</p></details>
        </div>
      </section>
      {related.length > 0 && <section className="section"><div className="section-head"><h2>You may <em>also love</em></h2></div><div className="grid">{related.map(p => <ProductCard key={p.slug} product={p} />)}</div></section>}
    </>
  );
}

// ---------------- Bag (drawer + page) ----------------
function BagLines({ compact }: { compact?: boolean }) {
  const lines = useBag();
  const fx = useFx();
  return (
    <ul className={`lines${compact ? ' compact' : ''}`}>
      {lines.map(l => { const p = bySlug(l.slug)!; return (
        <li key={`${l.slug}-${l.size}`} className="line">
          <a href={`#/p/${p.slug}`} className="line-img"><img src={img(p.slug)} alt="" /></a>
          <div className="line-info">
            <a href={`#/p/${p.slug}`} className="line-name">{p.name}</a>
            <span className="line-sub">Size {l.size} · {p.shade}</span>
            <div className="qty" role="group" aria-label={`Quantity of ${p.name}`}>
              <button onClick={() => bagActions.setQty(l.slug, l.size, l.qty - 1)} aria-label="Decrease quantity">−</button>
              <span aria-live="polite">{l.qty}</span>
              <button onClick={() => bagActions.setQty(l.slug, l.size, l.qty + 1)} disabled={l.qty >= 5} aria-label="Increase quantity">+</button>
            </div>
          </div>
          <div className="line-end">
            <span className="line-price">{usd(p.price * l.qty)}</span>
            {!compact && fx && <span className="eur">{eur(p.price * l.qty, fx)}</span>}
            <button className="link-btn" onClick={() => bagActions.setQty(l.slug, l.size, 0)}>Remove</button>
          </div>
        </li>
      ); })}
    </ul>
  );
}

function CheckoutButton() {
  const lines = useBag();
  const { config, error } = useConfig();
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setFail(null);
    try { const { orderId, checkoutUrl } = await api.checkout(lines); try { sessionStorage.setItem('aubelle.lastOrder', orderId); } catch { /* ignore */ } location.href = checkoutUrl; }
    catch (e: any) { setFail(e.message); setBusy(false); }
  };
  if (error) return <SetupNote title="The shop backend is not reachable" body={error} />;
  if (config && !config.ready) return <SetupRequired config={config} />;
  return (
    <>
      <button className="btn btn-noren btn-wide" onClick={start} disabled={busy || !config || lines.length === 0} aria-busy={busy}>
        {busy ? 'Opening Noren…' : <>Checkout with <NorenMark /> <span className="noren-word">Noren</span></>}
      </button>
      <p className="noren-note">Four ways at Noren's checkout: pay privately, pay with USDC, pay with stocks, or Pay in 3 / pay later, privately. Pay privately (or later, privately) and Aubelle never sees your wallet.</p>
      {fail && <p className="error" role="alert">{fail}</p>}
    </>
  );
}

function SetupRequired({ config }: { config: Config }) {
  const items = [...config.missing, ...(config.webhookError ? [config.webhookError] : [])];
  return <SetupNote title="Setup required" body={<>This shop has no Noren connection yet. Add {items.length ? items.map((m, i) => <span key={i}>{i > 0 && (i === items.length - 1 ? ' and ' : ', ')}<code>{m}</code></span>) : 'the Noren webhook'} to <code>examples/shop/.env</code> (see <code>.env.example</code>), then restart the shop.</>} />;
}
function SetupNote({ title, body }: { title: string; body: ReactNode }) {
  return <div className="setup" role="status"><b>{title}</b><p>{body}</p></div>;
}

function NorenMark() {
  // A noren: the split curtain hung at a shop's entrance.
  return <svg className="noren-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden><rect x="1" y="2" width="14" height="1.6" rx=".8" fill="currentColor" /><path d="M2 4.5h3.4v8.2L3.7 14 2 12.7Z M6.3 4.5h3.4v8.2L8 14l-1.7-1.3Z M10.6 4.5H14v8.2L12.3 14l-1.7-1.3Z" fill="currentColor" /></svg>;
}

function Drawer() {
  const open = useDrawer();
  const lines = useBag();
  const fx = useFx();
  useEffect(() => { if (!open) return; const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false); addEventListener('keydown', onKey); document.body.style.overflow = 'hidden'; return () => { removeEventListener('keydown', onKey); document.body.style.overflow = ''; }; }, [open]);
  const total = bagTotal(lines);
  return (
    <div className={`drawer-wrap${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="scrim" onClick={() => setDrawer(false)} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Your bag">
        <div className="drawer-head"><h2>Your <em>bag</em></h2><button className="x" onClick={() => setDrawer(false)} aria-label="Close bag">×</button></div>
        {lines.length === 0 ? (
          <div className="empty small"><p>Your bag is empty.</p><a className="btn btn-dark" href="#/shop" onClick={() => setDrawer(false)}>Shop dresses</a></div>
        ) : (
          <>
            <div className="drawer-body"><BagLines compact /></div>
            <div className="drawer-foot">
              <div className="sum-row total"><span>Subtotal</span><span>{usd(total)}{fx && <span className="eur"> · {eur(total, fx)}</span>}</span></div>
              {open && <CheckoutButton />}
              <a className="btn btn-ghost btn-wide" href="#/bag" onClick={() => setDrawer(false)}>View bag</a>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function BagPage() {
  const lines = useBag();
  const fx = useFx();
  const total = bagTotal(lines);
  if (lines.length === 0) return <section className="section"><div className="empty"><h1>Your bag is <em>empty.</em></h1><p>Fifteen dresses are waiting.</p><a className="btn btn-dark" href="#/shop">Shop dresses</a></div></section>;
  return (
    <section className="section bag-page">
      <h1>Your <em>bag</em></h1>
      <div className="bag-grid">
        <BagLines />
        <aside className="summary">
          <h2>Order summary</h2>
          <div className="sum-row"><span>Subtotal · {bagCount(lines)} item{bagCount(lines) === 1 ? '' : 's'}</span><span>{usd(total)}</span></div>
          <div className="sum-row"><span>Shipping</span><span>Free</span></div>
          <div className="sum-row total"><span>Total</span><span>{usd(total)}</span></div>
          {fx && <div className="sum-row fx"><span>In euros</span><span>≈ {eur(total, fx)}</span></div>}
          {fx && <p className="fx-note">Euro estimate from Chainlink EUR/USD on Arc mainnet, read by Noren. You pay {usd(total)} in USDC.</p>}
          <CheckoutButton />
        </aside>
      </div>
    </section>
  );
}

// ---------------- Order confirmation ----------------
const METHOD: Record<string, string> = { usdc: 'Noren · USDC on Arc', private: 'Noren · private balance (privacy pool)', stocks: 'Noren · stocks, paid in USDG on Robinhood Chain', credit: 'Noren · Pay in 3 / pay later on credit' };
const short = (s: string, n = 6) => s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s;
/**
 * The payment transaction, opened in a new tab: the Arc testnet explorer when Noren runs on the public network, and
 * Noren's local fork transaction page (#/tx/<chain>/<hash>) when it runs on local forks, which have no public explorer.
 * Stock payments settle on Robinhood Chain, everything else on Arc.
 */
function TxLink({ hash, method, config }: { hash: string; method?: string | null; config: Config | null }) {
  const chain = method === 'stocks' ? 'robinhood' : 'arc';
  const local = !config?.server || /127\.0\.0\.1|localhost/.test(config.server);
  const href = !local && chain === 'arc' ? `https://explorer.testnet.arc.io/tx/${hash}` : `${config?.checkoutBase ?? 'http://localhost:5190'}/#/tx/${chain}/${hash}`;
  return (
    <a className="mono tx-link" href={href} target="_blank" rel="noreferrer" title={`${hash}: opens ${local ? `the local ${chain === 'arc' ? 'Arc' : 'Robinhood'} fork transaction page` : 'the Arc testnet explorer'} in a new tab`}>
      {short(hash)}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>
    </a>
  );
}
function OrderPage({ id }: { id: string }) {
  const { config } = useConfig();
  const [order, setOrder] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false, timer: number | undefined;
    const tick = async () => {
      try { const o = await api.order(id); if (stop) return; setOrder(o); setError(null); if (o.status === 'paid') { bagActions.clear(); return; } if (o.status !== 'awaiting_payment') return; }
      catch (e: any) { if (!stop) setError(e.message); }
      if (!stop) timer = window.setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);
  if (error && !order) return <section className="section"><div className="empty"><h1>Order <em>not found</em></h1><p>{error}</p><a className="btn btn-dark" href="#/shop">Back to the shop</a></div></section>;
  if (!order) return <section className="section"><div className="empty"><p className="muted">Loading your order…</p></div></section>;
  const paid = order.status === 'paid';
  return (
    <section className="section order">
      <p className="eyebrow">Order {order.id}</p>
      <h1>{paid ? <>Thank you. <em>It's yours.</em></> : order.status === 'awaiting_payment' ? <>Waiting for <em>payment</em></> : <>Order <em>{order.status.replace('_', ' ')}</em></>}</h1>
      <p className="lede">{paid ? (order.method === 'stocks' ? 'Your payment settled through Noren: your shares were sold and Aubelle received USDG on Robinhood Chain. We are wrapping your dress in tissue now.' : 'Your payment settled on Arc through Noren. We are wrapping your dress in tissue now.') : order.status === 'awaiting_payment' ? 'This page updates the moment Noren confirms the payment.' : 'This order was not paid.'}</p>
      <div className="order-grid">
        <div className="order-card">
          <div className={`status status-${order.status}`}><i aria-hidden />{paid ? 'Paid' : order.status === 'awaiting_payment' ? 'Awaiting payment' : order.status.replace('_', ' ')}</div>
          <dl className="facts">
            <dt>Paid with</dt><dd>{paid || order.method ? METHOD[order.method ?? ''] ?? 'Noren' : 'Noren checkout'}</dd>
            <dt>Noren payment</dt><dd className="mono" title={order.invoiceId}>{short(order.invoiceId)}</dd>
            {order.paymentTx && <><dt>Transaction</dt><dd><TxLink hash={order.paymentTx} method={order.method} config={config} /></dd></>}
            {order.paidVia === 'webhook' && <><dt>Confirmed by</dt><dd>Signed Noren webhook <span className="ok">✓ signature verified</span></dd></>}
            {paid && order.paidVia !== 'webhook' && <><dt>Confirmed by</dt><dd>Noren API (webhook not received yet)</dd></>}
          </dl>
          {order.status === 'awaiting_payment' && <a className="btn btn-noren btn-wide" href={order.checkoutUrl}>Return to Noren checkout</a>}
        </div>
        <div className="order-card">
          <ul className="order-lines">{order.lines.map((l: any) => <li key={`${l.slug}-${l.size}`}><img src={img(l.slug)} alt="" /><span><b>{l.name}</b><small>Size {l.size} · Qty {l.qty}</small></span><span>{usd(l.price * l.qty)}</span></li>)}</ul>
          <div className="sum-row total"><span>Total</span><span>{usd(order.totalCents)}</span></div>
        </div>
      </div>
      <a className="link" href="#/shop">Continue shopping</a>
    </section>
  );
}

// ---------------- Integration panel ----------------
function highlight(src: string) {
  return src.split('\n').map((line, i) => {
    const comment = line.indexOf('//');
    const code = comment >= 0 ? line.slice(0, comment) : line, note = comment >= 0 ? line.slice(comment) : '';
    const parts: ReactNode[] = [];
    let last = 0;
    code.replace(/('[^']*'|`[^`]*`)|\b(import|from|export|const|async|function|await|return|if|null)\b|\b(\d[\d_]*n?)\b/g, (m, str, kw, num, at) => {
      parts.push(code.slice(last, at)); parts.push(<span key={at} className={str ? 'tk-s' : kw ? 'tk-k' : 'tk-n'}>{m}</span>); last = at + m.length; return m;
    });
    parts.push(code.slice(last));
    return <span key={i} className="code-line">{parts}{note && <span className="tk-c">{note}</span>}{'\n'}</span>;
  });
}

function IntegrationPanel() {
  const lines = integrationSource.trimEnd().split('\n').length;
  return (
    <div className="integration">
      <div className="integration-copy">
        <p className="eyebrow">For developers</p>
        <h2>How this shop <em>added Noren</em></h2>
        <p>Aubelle's whole payment integration is one file of {lines} lines on the shop's backend: create a Noren invoice for the bag, send the shopper to Noren's hosted checkout, and trust the order only after a signed webhook.</p>
        <ol className="steps">
          <li><b>Invoice</b> for the bag total, with the order ID in metadata.</li>
          <li><b>Redirect</b> to Noren's hosted checkout: pay privately, with USDC, with stocks, or Pay in 3 / pay later, privately.</li>
          <li><b>Webhook</b> signed with HMAC-SHA256; the shop verifies it and marks the order paid.</li>
        </ol>
        <p className="muted small">The secret key stays on the server. Prices are recomputed there, never taken from the browser.</p>
      </div>
      <figure className="code">
        <figcaption><span>server/noren.ts</span><span className="muted">@noren/core/merchant</span></figcaption>
        <pre><code>{highlight(integrationSource.trimEnd())}</code></pre>
      </figure>
    </div>
  );
}

function IntegrationPage() {
  return <section className="section"><IntegrationPanel /></section>;
}

function NotFound() {
  return <section className="section"><div className="empty"><h1>This page has <em>wandered off.</em></h1><a className="btn btn-dark" href="#/">Back home</a></div></section>;
}

function Footer() {
  return (
    <footer className="ftr">
      <div className="ftr-brand"><span className="wordmark">Aubelle</span><p>Maison de robes. A demo boutique built to show Noren checkout; the dresses are imagined, the payments are real on a local Arc fork.</p></div>
      <div className="ftr-cols">
        <div><b>Shop</b><a href="#/shop?length=Mini">Mini</a><a href="#/shop?length=Midi">Midi</a><a href="#/shop?length=Maxi">Maxi</a></div>
        <div><b>Help</b><a href="#/bag">Your bag</a><a href="#/noren">Payments by Noren</a></div>
      </div>
      <p className="ftr-legal">© 2026 Aubelle (demo). MIT licensed example in the Noren repo. Product photos generated with AI.</p>
    </footer>
  );
}
