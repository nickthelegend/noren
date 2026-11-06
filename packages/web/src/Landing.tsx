import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui";
import "./landing.css";

/* Every number on this page comes from TESTING.md (local Arc testnet fork and Robinhood Chain mainnet snapshot, Nov 6 2026).
   Screens are real captures of this app. Art: ChatGPT (stills) and Google Gemini Veo (film), see README. */

/** Honest status of each piece. Flip a value here when its branch lands. */
type Status = "live" | "key" | "wip" | "quotes";
const STATUS: Record<Status, string> = { live: "Live on fork", key: "Needs key", wip: "In progress", quotes: "Live quotes" };
const Chip = ({ s }: { s: Status }) => <span className={`nx-chip ${s} mono`}><i />{STATUS[s]}</span>;

const CODE: Record<string, { file: string; lines: [string, string][] }> = {
  link: { file: "server.ts", lines: [
    ["c", "// Merchant side: create a payment link"],
    ["k", "import { createNoren } from \"@noren/core/merchant\";"],
    ["", ""],
    ["", "const noren = createNoren({ server, token, merchant });"],
    ["", "const { invoice } = await noren.invoices.create({"],
    ["", "  amount: 7_500_000n,        // 7.50 USDC (6 decimals)"],
    ["", "  description: \"Flat white\","],
    ["", "  expiresIn: 1800,"],
    ["", "});"],
    ["s", "// → send the customer to /pay/{invoice.invoiceId}"],
  ] },
  hook: { file: "webhook.ts", lines: [
    ["c", "// Signed webhooks, verified like you're used to"],
    ["k", "import { verifyWebhook } from \"@noren/core/merchant\";"],
    ["", ""],
    ["", "app.post(\"/noren\", async (req, res) => {"],
    ["", "  const event = await verifyWebhook("],
    ["", "    req.rawBody, req.headers[\"noren-signature\"], secret);"],
    ["", "  if (event.type === \"payment.succeeded\") fulfil(event.data);"],
    ["", "  res.sendStatus(200);"],
    ["", "});"],
    ["s", "// event.data has the invoice, the amount and the tx. Never a payer."],
  ] },
  pay: { file: "checkout.ts", lines: [
    ["c", "// Customer side, in the browser: prove, don't reveal"],
    ["k", "import { createCustomer } from \"@noren/core/customer\";"],
    ["", ""],
    ["", "const me = createCustomer({ deployment, rpcUrl, aspUrl, deriveAt });"],
    ["", "await me.shield(20_000_000n);           // once: USDC into the pool"],
    ["", "const proof = await me.proveInvoicePayment(invoice);"],
    ["s", "// 1.09–1.13 s in a browser (measured). The merchant relays it and pays the gas."],
  ] },
};

const SURFACES = [
  { k: "merchant", name: "Noren Merchant", href: "#/dashboard", cta: "Open Noren Merchant", img: "/art/surface-merchant.jpg", w: 1200, h: 750,
    line: "The merchant dashboard. Payments with the method used, payment links priced in 9 currencies by Chainlink, refunds, balances, signed webhooks, API keys and credit-line exposure.",
    cap: "Home: today against yesterday, USDC balance on Arc, payment-method mix." },
  { k: "app", name: "Noren app", href: "#/app", cta: "Open the Noren app", img: "/art/surface-app.jpg", w: 500, h: 1040,
    line: "The customer's side. A private balance, Stock Tokens at live Chainlink prices, a credit score from on-chain history and a USDC line on Arc.",
    cap: "At 375 px: private balance, credit limit, stock held." },
  { k: "sdk", name: "Noren SDK", href: "#developers", cta: "Read the SDK", img: "/art/surface-checkout.jpg", w: 1200, h: 750,
    line: "Drop-in hosted checkout and a TypeScript merchant API. Create a link, send the customer to it, verify the signed webhook.",
    cap: "The hosted checkout the SDK links to, with all three ways to pay." },
];

type Power = { k: string; t: string; s: Status[]; d: string; m?: string; art?: string; alt?: string; tone?: "dark" };
const POWERS: Power[] = [
  { k: "private", t: "Pay privately", s: ["live"], art: "/art/iso-privacy.jpg", alt: "A coin stack passes behind a noren curtain; only a receipt comes out the other side",
    d: "Pay from a Kohaku privacy pool. Your browser makes a zero-knowledge proof for exactly this invoice, and the shop gets paid without ever learning your address.",
    m: "Proof in the browser: 1.09–1.13 s" },
  { k: "stocks", t: "Pay with stocks", s: ["live"],
    d: "Spend NVDA, TSLA or other Stock Tokens. A 1inch Aqua maker buys them at the Chainlink price and the merchant receives USDG.",
    m: "0.040798 NVDA at $184.61 → 7.50 USDG" },
  { k: "in3", t: "Pay in 3", s: ["live"],
    d: "Pay later on your credit line, then repay in three parts in USDC before the line expires.",
    m: "14.02 USDC checkout → 4.67 × 3" },
  { k: "earn", t: "Earn", s: ["live"], art: "/art/render-earn.jpg", alt: "Stock and ether tokens float into a softly glowing glass vault", tone: "dark",
    d: "Deposit NVDA, TSLA, AAPL or ETH into a deposit vault and get receipt shares. The vault backs its own 1inch Aqua maker, so its spread on real fills is your yield, and you can withdraw any time." },
  { k: "borrow", t: "Borrow at a Chainlink price", s: ["live"],
    d: "Lock your Earn receipt shares and borrow USDG at your reputation LTV (66% up to 80%), with the health factor and liquidation price from Chainlink. Or lock Stock Tokens for a USDC line on Arc, opened by a CRE workflow.",
    m: "2 NVDA locked = $371.41 collateral" },
  { k: "human", t: "Credit for real humans", s: ["live"], art: "/art/render-credit.jpg", alt: "A card made of light floats in front of a glowing orb", tone: "dark",
    d: "No stock? Verify with World ID (production, Selfie Check in World App) for one small starter line per human and a reputation milestone. Noren keeps only the nullifier. A sealed second opinion runs on 0G Private Computer, verified independently as TeeML." },
  { k: "bridge", t: "Swap and bridge", s: ["live", "quotes"], art: "/art/iso-bridge.jpg", alt: "Two chain platforms joined by an arched bridge; one coin crosses",
    d: "Swap stock, ETH and USDG at the better of a 1inch Aqua maker and Uniswap v4. Move USDG on Robinhood Chain to USDC on Arc through Relay or Across, with a Chainlink CRE workflow approving the route against the Chainlink fair value.",
    m: "7.50 USDG: Relay 7.475568 · Across 7.491332 USDC" },
];

const BUILT: { name: string; use: string; s: Status; note?: string }[] = [
  { name: "Kohaku privacy pools", use: "The Ethereum Foundation's Kohaku SDK on 0xbow's Privacy Pools contracts: the pool customers pay from, with Groth16 proofs made in the browser.", s: "live" },
  { name: "Chainlink Data Feeds + CRE", use: "Fiat feeds price payment links, and stock and ETH feeds value collateral. CRE workflows bridge credit lines, write FX rates and approve settlements (CRE simulator).", s: "live" },
  { name: "1inch Aqua + SwapVM", use: "Makers fill stock payments at a Chainlink-pegged price through a SwapVM instruction we added, NorenOraclePeg.", s: "live", note: "Powered by SwapVM — © Degensoft Ltd 2025" },
  { name: "Uniswap v4", use: "Best-execution quotes from the official V4Quoter and swaps through the Universal Router and Permit2 on Robinhood Chain, in the Noren app and at checkout.", s: "live" },
  { name: "World ID", use: "One starter credit line per verified human and a NorenReputation milestone. Noren stores the nullifier, not the person.", s: "live", note: "Production World ID; a real check needs World App" },
  { name: "0G Private Computer", use: "A sealed AI second opinion on credit. It sees numeric features only, inside a TEE, and Noren verifies the TeeML provider independently.", s: "live" },
  { name: "Relay / Across", use: "USDG on Robinhood Chain to USDC on Arc for merchant settlement. Quotes are live; no relayer fills a local fork.", s: "quotes" },
];

const ONBOARD: [string, string][] = [
  ["Sign in and create your store", "Sign in with your wallet (Sign-In with Ethereum), name your store and choose where USDC lands on Arc. Noren registers the store on-chain and gives you API keys."],
  ["Create a payment link", "Price it in USDC, or in EUR, JPY and seven more currencies. Chainlink locks the USDC quote until the link expires. One SDK call does the same."],
  ["Get paid, then get the webhook", "USDC lands at your payout address and a signed payment.succeeded webhook arrives with the invoice, the amount and the tx. There's no payer field."],
];

const NUMBERS: { v: string; u?: string; l: string }[] = [
  { v: "1.09–1.13", u: "s", l: "to make the payment proof in a browser" },
  { v: "0", l: "payer addresses in the private payment tx" },
  { v: "5/5", l: "attacks reverted on-chain: stale root, tamper, outsider relay, expiry, replay" },
  { v: "5.0–7.0", u: "s", l: "for CRE to carry a new credit line from Robinhood to Arc" },
  { v: "8/8", l: "steps of the stocks + pay-later run, end to end" },
  { v: "346", l: "tests passing: 99 + 112 + 18 + 47 + 22 + 31 + 8 + 9 across the suites" },
];

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current; if (!root) return;
    const els = root.querySelectorAll<HTMLElement>("[data-reveal]");
    if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  return ref;
}

/** Plays a muted ambient film only while it is on screen, and never under reduced motion. */
function Film({ src, poster, label }: { src: string; poster: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current; if (!v) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) v.play().catch(() => {}); else v.pause(); }, { threshold: .25 });
    io.observe(v);
    return () => io.disconnect();
  }, []);
  return <video ref={ref} src={src} poster={poster} muted loop playsInline preload="metadata" aria-label={label} />;
}

/** A field of tiny noren marks that brightens toward a horizon, with a slow shimmer. Deterministic, cheap, pauses offscreen. */
function GlyphField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!; const ctx = c.getContext("2d")!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0, visible = true, last = 0;
    const dpr = Math.min(devicePixelRatio || 1, 2), cell = 15;
    const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
    const resize = () => { const r = c.getBoundingClientRect(); w = r.width; h = r.height; c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw(performance.now()); };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell), time = reduce ? 0 : t / 1000;
      for (let j = 0; j < rows; j++) {
        const fy = j / rows;
        for (let i = 0; i < cols; i++) {
          const n = hash(i, j), cx = i / cols - .5;
          // vertical light: strongest near the horizon (bottom), shaped like a wide dome, rippled by a slow wave
          const dome = Math.max(0, 1 - (cx * cx) * 2.2 - Math.pow(1 - fy, 1.6) * 1.15);
          const wave = .55 + .45 * Math.sin(time * .8 + i * .21 + j * .13 + n * 6.28);
          // keep the copy legible: clear an ellipse behind the headline and paragraph
          const dx = cx / .3, dy = (fy - .5) / .26, hole = Math.min(1, Math.max(0, (dx * dx + dy * dy - .55) / .9));
          const a = dome * (n > .42 ? 1 : .25) * wave * hole;
          if (a < .04) continue;
          const x = i * cell + 4, y = j * cell + 4;
          ctx.fillStyle = `rgba(${150 + 90 * fy | 0}, ${185 + 60 * fy | 0}, 255, ${Math.min(1, a * 1.1)})`;
          ctx.fillRect(x, y, 1.6, 6); ctx.fillRect(x + 3, y, 1.6, 7); ctx.fillRect(x + 6, y, 1.6, 6);
        }
      }
    };
    const loop = (t: number) => { raf = requestAnimationFrame(loop); if (!visible || t - last < 50) return; last = t; draw(t); };
    resize(); addEventListener("resize", resize);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }); io.observe(c);
    if (!reduce) raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", resize); io.disconnect(); };
  }, []);
  return <canvas ref={ref} className="lx-field" aria-hidden />;
}

const Tag = ({ children, dark }: { children: string; dark?: boolean }) => <span className={`lx-tag mono ${dark ? "dark" : ""}`}>■ {children}</span>;

export function Landing() {
  const [tab, setTab] = useState<keyof typeof CODE>("link");
  const ref = useReveal();
  return (
    <div className="lp" ref={ref}>
      {/* ---------------------------------------------------------------- hero (unchanged) */}
      <section className="lx-hero">
        <GlyphField />
        <div className="lx-hero-in">
          <span className="lx-pill mono"><i />New: private payments for EVM</span>
          <h1>Stablecoin Payments That <em>Never See</em><br /><em>Who</em> Paid You</h1>
          <p>Payment links, hosted checkout, refunds and signed webhooks. Customers pay from a Kohaku privacy pool. You get the USDC and the receipt; nobody gets their wallet.</p>
          <div className="lx-ctas">
            <a className="lx-btn light" href="#/dashboard">Open dashboard</a>
            <a className="lx-btn dark" href="#developers">Read the API</a>
          </div>
        </div>
        <div className="lx-horizon" aria-hidden />
      </section>

      {/* ---------------------------------------------------------------- (a) what Noren is */}
      <section className="nx-one">
        <div className="nx-one-in">
          <div data-reveal><Tag dark>What Noren is</Tag></div>
          <h2 data-reveal>Noren lets shops take stablecoins <em>without</em> seeing who paid. <span>Merchants get USDC on Arc. Customers pay privately, with stock, or later.</span></h2>
          <figure className="nx-film" data-reveal>
            <Film src="/art/vault.mp4" poster="/art/vault-poster.jpg" label="Glossy coins drift behind a noren curtain; only a point of light reaches the vault" />
            <figcaption className="mono">The coins go behind the curtain. Only the payment comes out. <span>Film generated with Google Gemini (Veo); Gemini's mark is kept, bottom right.</span></figcaption>
          </figure>
        </div>
      </section>

      {/* ---------------------------------------------------------------- (b) three surfaces */}
      <section className="nx-sec nx-surf" id="surfaces">
        <div className="nx-head" data-reveal>
          <Tag>One product, three surfaces</Tag>
          <h2>One Noren. <span>A dashboard for the shop, an app for the customer, an SDK for the developer.</span></h2>
        </div>
        <div className="nx-surf-grid">
          {SURFACES.map((s, i) => (
            <article key={s.k} className={`nx-surf-card ${s.k}`} data-reveal style={{ transitionDelay: `${i * 80}ms` }}>
              <div className="nx-surf-copy">
                <span className="nx-num mono">0{i + 1}</span>
                <h3>{s.name}</h3>
                <p>{s.line}</p>
                <a className="nx-link mono" href={s.href}>{s.cta} <Icon.arrow /></a>
              </div>
              <figure className={`nx-shot ${s.k === "app" ? "phone" : "browser"}`}>
                {s.k !== "app" && <span className="nx-dots" aria-hidden><i /><i /><i /></span>}
                <img src={s.img} alt={`${s.name}: ${s.cap}`} width={s.w} height={s.h} loading="lazy" />
                <figcaption className="mono">{s.cap} Real capture on the local forks.</figcaption>
              </figure>
            </article>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------------- (c) consumer powers */}
      <section className="nx-sec nx-powers" id="app">
        <div className="nx-head split" data-reveal>
          <div>
            <Tag>In the Noren app</Tag>
            <h2>Everything your money can do. <span>Only one of them shows nobody who you are.</span></h2>
          </div>
          <p>Pay privately is the only private path. Paying with stocks, paying later and borrowing come from your public Robinhood Chain wallet, and the app says so on every screen.</p>
        </div>
        <div className="nx-bento">
          {POWERS.map((p, i) => (
            <article key={p.k} className={`nx-pw ${p.k} ${p.tone ?? ""}`} data-reveal style={{ transitionDelay: `${(i % 4) * 60}ms` }}>
              <div className="nx-pw-top">{p.s.map((s) => <Chip key={s} s={s} />)}</div>
              <h3>{p.t}</h3>
              <p>{p.d}</p>
              {p.m && <span className="nx-pw-m mono">{p.m}</span>}
              {p.k === "in3" && <ol className="nx-in3 mono" aria-label="Three equal parts">{["First", "Part 2", "Last"].map((x) => <li key={x}><span>{x}</span><b>4.67</b></li>)}</ol>}
              {p.art && <img className="nx-pw-art" src={p.art} alt={p.alt} width={900} height={900} loading="lazy" />}
            </article>
          ))}
        </div>
        <p className="nx-legend mono"><Chip s="live" /> runs end to end on local Anvil forks of Arc testnet and Robinhood Chain mainnet, against the real contracts. <Chip s="quotes" /> real third-party quotes, not filled on a fork. <Chip s="key" /> code ready, waiting for an API key. <Chip s="wip" /> being built now.</p>
      </section>

      {/* ---------------------------------------------------------------- (d) built with */}
      <section className="nx-built" id="built-with">
        <div className="nx-built-in">
          <div className="nx-head" data-reveal>
            <Tag dark>Built with</Tag>
            <h2>Seven protocols. <span>Each one labelled with what actually runs today.</span></h2>
          </div>
          <ul className="nx-built-list">
            {BUILT.map((b, i) => (
              <li key={b.name} data-reveal style={{ transitionDelay: `${i * 50}ms` }}>
                <b>{b.name}</b>
                <p>{b.use}{b.note && <small className="mono">{b.note}</small>}</p>
                <Chip s={b.s} />
              </li>
            ))}
          </ul>
          <p className="nx-built-foot mono">Runs on Arc (USDC checkout and credit lines) and Robinhood Chain (Stock Tokens, USDG). No endorsement by any of these projects is implied.</p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- (e) merchant onboarding */}
      <section className="nx-sec nx-onb" id="merchants">
        <figure className="nx-onb-art" data-reveal><img src="/art/iso-merchant.jpg" alt="A laptop shows a merchant dashboard next to a card terminal printing a receipt" width={900} height={900} loading="lazy" /></figure>
        <div>
          <div className="nx-head" data-reveal>
            <Tag>For merchants</Tag>
            <h2>Start taking private payments <em>in three steps.</em></h2>
          </div>
          <ol className="nx-steps">
            {ONBOARD.map(([t, d], i) => (
              <li key={t} data-reveal style={{ transitionDelay: `${i * 80}ms` }}><span className="mono">0{i + 1}</span><div><b>{t}</b><p>{d}</p></div></li>
            ))}
          </ol>
          <a className="lx-btn dark" href="#/dashboard/onboard">Set up your store</a>
        </div>
      </section>

      {/* ---------------------------------------------------------------- (f) SDK */}
      <section className="nx-dev" id="developers">
        <div className="nx-dev-in">
          <div className="nx-dev-copy" data-reveal>
            <Tag dark>Noren SDK</Tag>
            <h2>Get paid in <em>about ten lines.</em></h2>
            <p>A TypeScript SDK, a REST API and signed webhooks that feel familiar. Plain Solidity on 0xbow's Privacy Pools contracts, so it ports to any EVM chain with USDC. We start on Arc.</p>
            <ul className="nx-endpoints mono">
              <li><b>POST</b> /merchants/:id/invoices</li>
              <li><b>GET</b> /invoices/:id</li>
              <li><b>POST</b> /invoices/:id/refund</li>
              <li><b>POST</b> /merchants/:id/webhooks</li>
              <li><b>GET</b> /merchants/:id/events</li>
            </ul>
          </div>
          <div className="nx-code" data-reveal>
            <div className="nx-code-tabs" role="tablist" aria-label="SDK examples">
              {(Object.keys(CODE) as (keyof typeof CODE)[]).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="mono">{k === "link" ? "Create a link" : k === "hook" ? "Webhooks" : "Customer pays"}</button>
              ))}
            </div>
            <div className="nx-code-file mono"><span>{CODE[tab].file}</span><span>TypeScript</span></div>
            <pre className="mono" key={tab} role="tabpanel">{CODE[tab].lines.map(([t, l], i) => <span key={i} className={`ln ${t}`}><i>{i + 1}</i>{l || " "}</span>)}</pre>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- (g) measured */}
      <section className="nx-sec nx-nums" id="numbers">
        <div className="nx-head" data-reveal>
          <Tag>Measured, not promised</Tag>
          <h2>The numbers from our last run. <span>Every one is in TESTING.md with the command that made it.</span></h2>
        </div>
        <div className="nx-num-grid" data-reveal>
          {NUMBERS.map((n) => <div key={n.l}><b>{n.v}{n.u && <em>{n.u}</em>}</b><span>{n.l}</span></div>)}
        </div>
        <p className="nx-note mono">Local Anvil fork of Arc testnet (chain 5042002) and a snapshot of Robinhood Chain mainnet, Nov 6 2026. No public transaction was sent. The public Arc testnet deploy waits on testnet USDC.</p>
      </section>

      {/* ---------------------------------------------------------------- (h) cta */}
      <section className="nx-cta" data-reveal>
        <img src="/art/icon.jpg" alt="" width={640} height={640} loading="lazy" aria-hidden />
        <h2>Open your shop's <em>curtain.</em></h2>
        <p>Run every chain, contract and workflow locally in one command, then take a private payment in under a minute.</p>
        <pre className="mono">pnpm install{"\n"}pnpm dev:all{"\n"}pnpm --filter @noren/web dev</pre>
        <div className="lx-ctas"><a className="lx-btn light" href="#/dashboard">Open Noren Merchant</a><a className="lx-btn dark" href="#/app">Open the Noren app</a></div>
      </section>
    </div>
  );
}
