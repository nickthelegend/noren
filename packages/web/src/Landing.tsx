import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui";
import { Mark } from "./logos";
import { AQUA_LIVE, CCTP_CHAINS, CCTP_RUNS, CCIP_MESSAGES, CHAIN_MARK, ccipMsgUrl, explorerTx, shortChain } from "./crosschain";
import { HOSTED, LIVE } from "./network";
import "./landing.css";

/* Every number on this page comes from TESTING.md (local Arc testnet fork and Robinhood Chain mainnet snapshot, Nov 6 2026).
   Screens are real captures of this app. Art: ChatGPT (stills) and Google Gemini Veo (film), see README. */

/** Honest status of each piece. Flip a value here when its branch lands. */
type Status = "live" | "key" | "wip" | "quotes" | "testnet" | "local";
const STATUS: Record<Status, string> = { live: HOSTED ? "Runs end to end" : "Runs on Arc testnet fork", key: "Needs key", wip: "In progress", quotes: "Live quotes", testnet: "Live on testnets", local: "Local stack only" };
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
    cap: "The hosted checkout the SDK links to, with the four ways to pay." },
];

type Power = { k: string; t: string; s: Status[]; d: string; m?: string; art?: string; alt?: string; tone?: "dark" };
const POWERS: Power[] = [
  { k: "private", t: "Pay privately", s: ["live"], art: "/art/iso-privacy.jpg", alt: "A coin stack passes behind a noren curtain; only a receipt comes out the other side",
    d: "Pay from a Kohaku privacy pool. Your browser makes a zero-knowledge proof for exactly this invoice, and the shop gets paid without ever learning your address.",
    m: "Proof in the browser: 1.09–1.13 s" },
  { k: "stocks", t: "Pay with stocks or crypto", s: ["live"],
    d: "Spend any Stock Token you hold (NVDA, TSLA, AAPL…) or ETH. A 1inch Aqua maker buys it at the Chainlink price and the merchant receives USDG.",
    m: "0.040798 NVDA at $184.61 → 7.50 USDG" },
  { k: "in3", t: "Pay in 3", s: [HOSTED ? "local" : "live"],
    d: "Pay later on your credit line, then repay in three parts in USDC before the line expires.",
    m: "14.02 USDC checkout → 4.67 × 3" },
  { k: "earn", t: "Deposit stock, get credit", s: ["live"], art: "/art/render-earn.jpg", alt: "Stock and ether tokens float into a softly glowing glass vault", tone: "dark",
    d: "Deposit NVDA, TSLA, AAPL or ETH into Noren's 1inch Aqua pools instead of selling. Borrow up to 80% of their value. The fees they earn pay the loan back. $100 of NVDA borrows $66 today, up to $80 at the top tier. You get receipt shares; the vault is a 1inch Aqua maker: your deposit stays in it, its spread on real fills is your yield, and the same shares are collateral in Borrow. Withdraw any time." },
  { k: "borrow", t: "Borrow at a Chainlink price", s: ["live"],
    d: "Lock your Earn receipt shares and borrow USDG at your reputation LTV: 66% to start, then 70, 75 and 80% as World ID and on-time repayments raise your tier, with the health factor and liquidation price from Chainlink. Or lock Stock Tokens for a USDC line on Arc, opened by a CRE workflow.",
    m: "2 NVDA locked = $371.41 collateral" },
  { k: "human", t: "Credit for real humans", s: ["live"], art: "/art/render-credit.jpg", alt: "A card made of light floats in front of a glowing orb", tone: "dark",
    d: "No stock? Verify with World ID (production; verified for real with an Orb credential in World App) for one small starter line per human and a reputation milestone. Noren keeps only the nullifier. A sealed second opinion runs on 0G Private Computer, verified independently as TeeML." },
  { k: "bridge", t: "From any chain", s: ["testnet", "live"], art: "/art/iso-bridge.jpg", alt: "Two chain platforms joined by an arched bridge; one coin crosses",
    d: "Bring USDC to Arc with Circle CCTP from 10 supported chains (live runs from Base, Arbitrum, Ethereum Sepolia and Robinhood), or pay an invoice on arrival. Robinhood Chain ⇄ Arc both ways from the app. Sell stock on Robinhood and get USDC on Arc from a 1inch Aqua maker, with Chainlink CRE carrying the order. Swaps go to Uniswap v4 unless Noren's Aqua maker quotes better.",
    m: "Base Sepolia → Arc: invoice paid on arrival" },
];

/** Each partner's one job in Noren, in the order of the positioning: shared liquidity, the rails, orchestration, credit. */
const BUILT: { name: string; logos: string[]; use: string; s: Status; note?: string }[] = [
  { name: "1inch Aqua + SwapVM", logos: ["1INCH"], use: "Shared liquidity: the lender pool and the Earn vaults are Aqua makers, and funds stay in them. One balance backs loans, earns fees from fills (stock payments, cross-chain orders, swaps when it beats Uniswap) and buys liquidated collateral, including partial Dutch auctions. Priced by NorenOraclePeg, a SwapVM instruction we added that pegs makers to Chainlink. Official Aqua v1.0.0 is live on Arc testnet.", s: "testnet", note: "Powered by SwapVM — © Degensoft Ltd 2025" },
  { name: "Circle CCTP V2", logos: ["CIRCLE"], use: "Native USDC into Arc from 10 testnets, burned and minted by Circle. A hook can pay an invoice, open an Aqua order or fund Earn on arrival.", s: "testnet" },
  { name: "Chainlink CCIP", logos: ["CHAINLINK"], use: "Orders and credit instructions from Ethereum, Base and Robinhood Chain into Arc (Robinhood through a Base hub, since there is no direct lane).", s: "testnet" },
  { name: "Chainlink CRE + Data Feeds", logos: ["CHAINLINK"], use: "Orchestration and price checks: CRE relays CCTP burns, carries Aqua orders and credit lines between chains, writes FX rates and approves settlements. Feeds price every invoice and every stock.", s: "testnet", note: "CRE runs in the simulator with --broadcast; not on a DON" },
  { name: "World ID + 0G", logos: ["WORLD", "0G"], use: "How credit reaches real humans safely: one starter line per verified human (Noren keeps only the nullifier), and a sealed AI second opinion inside a 0G TEE.", s: "live", note: "Production World ID; a real check needs World App" },
  { name: "Kohaku privacy pools", logos: ["KOHAKU"], use: "Why the shop never sees who paid: the Ethereum Foundation's Kohaku SDK on 0xbow's Privacy Pools, with the proof made in the browser.", s: "testnet" },
  { name: "Uniswap v4", logos: ["UNISWAP"], use: "The default swap route. On Arc testnet: the USDC/EURC pool through V4Quoter and the Universal Router at Arc mainnet's v4 addresses (not in Uniswap's docs for the testnet). On Robinhood Chain: the same contracts on the mainnet snapshot. Noren's Aqua maker fills only when it beats Uniswap.", s: "testnet" },
  { name: "Relay / Across", logos: ["RELAY", "ACROSS"], use: "The mainnet route for USDG on Robinhood Chain to USDC on Arc. Quotes are live; no relayer fills a local test chain.", s: "quotes" },
];

/** Real public-testnet transactions (docs/LIVE.md, docs/CCTP.md, docs/CCIP.md), linked to their explorers. */
const pick = (re: RegExp) => LIVE.e2e.steps.find((x) => re.test(x.step))?.tx;
const cctpIn = (from: string, kind: string) => CCTP_RUNS.find((r) => r.from === from && r.to === "arc-testnet" && r.kind === kind && (kind !== "pay-invoice" || r.events.includes("InvoicePaid")));
const LIVE_STRIP: { t: string; d: string; href: string; marks: string[] }[] = [
  { t: "Private payment on Arc", d: "2.50 USDC, no payer address in the tx", href: `${LIVE.explorer}/tx/${pick(/^pay \d/i)}`, marks: ["KOHAKU", "ARC"] },
  { t: "Refund into a shielded inbox", d: "1.00 USDC back, still private", href: `${LIVE.explorer}/tx/${pick(/^refund \d/i)}`, marks: ["ARC"] },
  { t: "CRE writes FX rates", d: "9 currencies from Chainlink feeds", href: `${LIVE.explorer}/tx/${LIVE.pricing.simulateTx}`, marks: ["CHAINLINK", "ARC"] },
  ...([["base-sepolia", "pay-invoice", "Invoice paid on arrival"], ["robinhood-testnet", "plain", "USDC into Arc"]] as const).flatMap(([from, kind, t]) => {
    const r = cctpIn(from, kind); if (!r) return [];
    return [{ t: `${shortChain(r.from)} → Arc: ${t}`, d: `CCTP V2, relayed by CRE · ${(Number(r.minted) / 1e6).toFixed(2)} USDC`, href: explorerTx("arc-testnet", r.mintTx), marks: [CHAIN_MARK[r.from], "CIRCLE"] }];
  }),
  ...CCTP_RUNS.filter((r) => r.from === "arc-testnet" && r.to === "robinhood-testnet").map((r) => ({ t: "Arc → Robinhood", d: `CCTP V2 out of Arc, ${(Number(r.minted) / 1e6).toFixed(2)} USDC`, href: explorerTx("robinhood-testnet", r.mintTx), marks: ["ARC", "ROBINHOOD"] })),
  { t: "1inch Aqua on Arc: USDC → EURC", d: "Official Aqua v1.0.0, maker strategy pegged to Chainlink", href: explorerTx("arc-testnet", AQUA_LIVE.directSwap), marks: ["1INCH", "ARC"] },
  ...AQUA_LIVE.fills.slice(0, 1).map((f) => ({ t: `${shortChain(f.from)} → Arc: Aqua fill`, d: "CCTP burn with AQUA_ORDER, filled on Arc via CRE", href: explorerTx("arc-testnet", f.fill), marks: [CHAIN_MARK[f.from], "1INCH"] })),
  ...CCIP_MESSAGES.filter((m) => m.arcTx && !(m.from === "robinhood-testnet" && /CREDIT_LINE/.test(m.action))).map((m) => ({ t: `CCIP: ${m.route}`, d: `${m.action} · delivered`, href: ccipMsgUrl(m.id), marks: [CHAIN_MARK[m.from], "CHAINLINK"] })),
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
  { v: "4.5–7.4", u: "s", l: "for CRE to carry a new credit line from Robinhood to Arc" },
  { v: "8/8", l: "steps of the stocks + pay-later run, end to end, in 30 s" },
  { v: "656", l: "tests passing across 21 suites, local chains and live testnets included" },
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
          <span className="lx-pill mono"><i />Live on Arc, CCTP and CCIP testnets</span>
          <h1>Stablecoin Payments That <em>Never See</em><br /><em>Who</em> Paid You</h1>
          <p>Noren lets merchants accept stablecoins, stocks or credit — privately. A DEX and stablecoin payment network on Arc: private settlement for merchants, credit from lending pools that are 1inch Aqua liquidity, and USDC from any chain.</p>
          <div className="lx-ctas">
            <a className="lx-btn light" href="#/dashboard">Open dashboard</a>
            <a className="lx-btn dark" href="#developers">Read the API</a>
          </div>
        </div>
        <div className="lx-horizon" aria-hidden />
      </section>

      {/* ---------------------------------------------------------------- live on public testnets */}
      <section className="nx-live" aria-label="Live on public testnets">
        <div className="nx-live-in">
          <span className="nx-live-h mono"><i aria-hidden />Live on public testnets</span>
          <ul>
            {LIVE_STRIP.map((x) => (
              <li key={x.href}><a href={x.href} target="_blank" rel="noreferrer"><span className="nx-live-m" aria-hidden>{x.marks.map((m) => <Mark key={m} id={m} size={18} />)}</span><span><b>{x.t}</b><small>{x.d}</small></span><Icon.ext /></a></li>
            ))}
          </ul>
          <p className="mono">Every link opens a block explorer or ccip.chain.link. The Robinhood Chain side of stocks and Aqua runs on a Robinhood Chain mainnet snapshot; see the README's "Honest limits".</p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- (a) what Noren is */}
      <section className="nx-one">
        <div className="nx-one-in">
          <div data-reveal><Tag dark>What Noren is</Tag></div>
          <h2 data-reveal>A DEX and payment rails on Arc, and the merchant <em>never</em> learns who paid. <span>Liquidity from 1inch Aqua makers, credit lines, and settlement from other chains, all landing as USDC on Arc.</span></h2>
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
                <figcaption className="mono">{s.cap} Real capture on the local test chains.</figcaption>
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
          <p>Pay privately and Pay later, privately hide you from the shop. Paying with USDC or stocks, Pay in 3 and borrowing come from your public wallets, and the app says so on every screen. Swaps and bridges are public.</p>
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
        <p className="nx-legend mono"><Chip s="live" /> runs end to end against the real contracts, on Arc testnet and a Robinhood Chain mainnet snapshot. <Chip s="quotes" /> real third-party quotes, not filled on a test chain. <Chip s="key" /> code ready, waiting for an API key. <Chip s="wip" /> being built now.</p>
      </section>

      {/* ---------------------------------------------------------------- (d) built with */}
      <section className="nx-built" id="built-with">
        <div className="nx-built-in">
          <div className="nx-head" data-reveal>
            <Tag dark>Built with</Tag>
            <h2>One job each. <span>Aqua lets one balance back loans, fills and liquidations, CCTP and CCIP bring money to Arc, CRE orchestrates and checks prices, World ID and 0G keep credit human. Each labelled with what runs today.</span></h2>
          </div>
          <ul className="nx-built-list">
            {BUILT.map((b, i) => (
              <li key={b.name} data-reveal style={{ transitionDelay: `${i * 50}ms` }}>
                <b className="nx-built-name"><span className="nx-built-logos">{b.logos.map((l) => <Mark key={l} id={l} size={24} />)}</span>{b.name}</b>
                <p>{b.use}{b.note && <small className="mono">{b.note}</small>}</p>
                <Chip s={b.s} />
              </li>
            ))}
          </ul>
          <div className="nx-built-chains" aria-label="Chains and assets">
            <span><Mark id="ARC" size={24} /><b>Arc</b><small><span className="nx-chunk">by <Mark id="CIRCLE" size={16} /> Circle ·</span><span className="nx-chunk"><Mark id="USDC" size={16} /> USDC checkout and credit lines</span></small></span>
            <span><Mark id="ROBINHOOD" size={24} /><b>Robinhood Chain</b><small><span className="nx-stock-row" aria-hidden>{["NVDA", "TSLA", "AAPL", "SPY", "MSFT", "GOOGL", "AMZN", "META"].map((t) => <Mark key={t} id={t} size={16} />)}</span> Stock Tokens ·<span className="nx-chunk"><Mark id="USDG" size={16} /> USDG</span></small></span>
          </div>
          <p className="nx-built-foot mono">Runs on Arc (USDC checkout and credit lines), Robinhood Chain (Stock Tokens, USDG) and {Object.keys(CCTP_CHAINS).length - 1} CCTP testnets that feed Arc. Logos belong to their owners and are shown only to name each project; no endorsement by any of them is implied.</p>
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
        <p className="nx-note mono">Measured on a local copy of Arc testnet (chain 5042002) and a snapshot of Robinhood Chain mainnet, Nov 6 2026. Public testnet transactions are in the strip at the top and in docs/LIVE.md, docs/CCTP.md and docs/CCIP.md.</p>
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
