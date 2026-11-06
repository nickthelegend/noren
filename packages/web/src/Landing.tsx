import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui";

/* Every number on this page was measured on the local Arc testnet fork (TESTING.md). Screens are real captures of this app. */

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
    ["s", "// ~1–5 s in a browser (warm vs first proof). The merchant relays it and pays the gas."],
  ] },
};

const SPECS: [string, string][] = [
  ["Payment links", "Create a link in the dashboard or with one SDK call. It carries the amount, a private description and an expiry. Share it anywhere."],
  ["Hosted checkout", "The customer opens the link, binds the invoice, proves on their own device and is done in seconds. No gas, no public wallet, no extension."],
  ["Private refunds", "Full or partial refunds go back into the customer's shielded inbox, fixed at payment time. You can't redirect it and you never learn whose it is."],
  ["Signed webhooks", "invoice.created, invoice.bound, payment.succeeded and refund.succeeded. HMAC-SHA256 signed, retried 3 times, every delivery logged."],
  ["Compliance built in", "An ASP postman screens every deposit against USDC's own blacklist before it can pay you. Blocked funds never reach your till."],
  ["Selective receipts", "Each payment carries a receipt commitment the customer can open later for a warranty or tax, and only if they choose to."],
];

const SCREENS: [string, string, string][] = [
  ["dash-home", "Dashboard", "Gross volume, net, refunds and the privacy ledger. Customers identified: 0."],
  ["dash-drawer", "Payment", "Timeline from link to refund, with gas and transactions. The customer is unknown."],
  ["dash-events", "Events", "Every webhook event and delivery attempt, newest first."],
  ["checkout-refunded", "Checkout", "The hosted checkout after a private payment and a partial refund."],
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

export function Landing() {
  const [tab, setTab] = useState<keyof typeof CODE>("link");
  const [spec, setSpec] = useState(0);
  const [screen, setScreen] = useState(0);
  const ref = useReveal();
  return (
    <div className="lp" ref={ref}>
      {/* ---------------------------------------------------------------- hero */}
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

      {/* ---------------------------------------------------------------- statement */}
      <section className="lx-statement">
        <h2 data-reveal>Get paid like a card.<br /><span>Links, checkout, refunds and webhooks</span><br /><span>for any EVM chain. Private by default.</span></h2>
        <figure className="lx-film" data-reveal>
          <video src="/art/curtain.mp4" poster="/art/curtain-poster.jpg" autoPlay muted loop playsInline preload="metadata" aria-label="A noren curtain parts and light comes through" />
          <figcaption className="mono">The curtain parts for the payment, not for the payer · film generated with Google Gemini (Veo)</figcaption>
        </figure>
        <div className="lx-icon" data-reveal aria-hidden><img src="/art/icon.jpg" alt="" width={320} height={320} /></div>
        <div className="lx-beam" aria-hidden />
      </section>

      {/* ---------------------------------------------------------------- what */}
      <section className="lx-what">
        <div className="lx-what-grid">
          <div className="lx-what-copy" data-reveal>
            <span className="lx-tag mono">■ What Noren does</span>
            <h2>The payments stack you know. <span>The privacy you can't get anywhere else.</span></h2>
          </div>
          <div className="lx-what-art" data-reveal><img className="lx-iso" src="/art/iso-pool.jpg" alt="Invoices drop into a privacy pool; a single receipt leaves for the shop, with no payer attached" width={900} height={900} loading="lazy" /><span className="lx-scroll mono">Keep scrolling <i /></span></div>
          <ul className="lx-specs">
            {SPECS.map(([t, d], i) => (
              <li key={t} data-open={spec === i}>
                <button className="mono" onClick={() => setSpec(i)} aria-expanded={spec === i}>{t}</button>
                <p className="mono">{d}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------------------------------------------------------------- product */}
      <section className="lx-product">
        <div className="lx-product-head" data-reveal>
          <h2>Know every payment. <span>Know none of your customers.</span></h2>
          <div className="lx-big"><b>0</b><span>payer addresses in the merchant's records. On-chain, the payment comes from the pool, not a person.</span></div>
        </div>
        <div className="lx-frame" data-reveal>
          <div className="lx-frame-bar">
            <div className="lx-frame-tabs" role="tablist">{SCREENS.map(([k, t], i) => <button key={k} role="tab" aria-selected={screen === i} onClick={() => setScreen(i)} className="mono">{t}</button>)}</div>
            <a className="lx-btn dark sm" href="#/dashboard">Open it</a>
          </div>
          <div className="lx-frame-shot"><img key={SCREENS[screen][0]} src={`/shots/${SCREENS[screen][0]}.jpg`} alt={`${SCREENS[screen][1]}: ${SCREENS[screen][2]}`} loading="lazy" width={1440} height={900} /></div>
          <p className="lx-frame-cap mono">{SCREENS[screen][2]} Real capture, local Arc testnet fork.</p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- problem */}
      <section className="lp-sec split">
        <div className="lp-head" data-reveal>
          <span className="lx-tag mono">■ The problem with crypto checkout</span>
          <h2>Paying with a wallet hands over <em>your whole wallet.</em></h2>
          <p>Send USDC to a shop and the shop, its analytics vendor and anyone on a block explorer can see your balance, your salary and every shop you've paid. Card networks never worked like that. Noren puts the curtain back.</p>
        </div>
        <img className="lp-head-art" data-reveal src="/art/iso-shop.jpg" alt="A coffee stand with a noren curtain and a card terminal; the payment goes to a safe, not to a public wallet" width={900} height={900} loading="lazy" />
        <div className="lp-compare">
          <div className="lp-cmp bad" data-reveal>
            <span className="lx-tag mono">A plain USDC transfer</span>
            <h3>What the merchant learns</h3>
            <ul>
              <li><Icon.x /> The payer's address, forever</li>
              <li><Icon.x /> Their full balance, right now</li>
              <li><Icon.x /> Every other payment they've made</li>
              <li><Icon.x /> Refunds go back to the same public wallet</li>
            </ul>
            <div className="lp-trace mono"><span>0x9f2c…41aa</span><Icon.arrow /><span>Takumi Coffee</span><em>visible to anyone</em></div>
          </div>
          <div className="lp-cmp good" data-reveal>
            <span className="lx-tag mono">A Noren payment</span>
            <h3>What the merchant learns</h3>
            <ul>
              <li><Icon.check /> The invoice was paid, in full, on time</li>
              <li><Icon.check /> The money came from screened funds</li>
              <li><Icon.check /> A receipt the customer can open later, if they choose</li>
              <li><Icon.check /> Refunds land in a private inbox only the customer sees</li>
            </ul>
            <div className="lp-trace mono"><span>privacy pool</span><Icon.arrow /><span>Takumi Coffee</span><em>payer: unknown</em></div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- developers */}
      <section className="lp-dev" id="developers">
        <div className="lp-dev-in">
          <div className="lp-dev-copy" data-reveal>
            <span className="lx-tag mono dark">■ For developers</span>
            <h2>Get paid in <em>about ten lines.</em></h2>
            <p>A REST API, a TypeScript SDK and webhooks that feel familiar. Plain Solidity on 0xbow's Privacy Pools contracts, so it ports to any EVM chain with USDC. We start on Arc.</p>
            <ul className="lp-endpoints mono">
              <li><b>POST</b> /merchants/:id/invoices</li>
              <li><b>GET</b>  /invoices/:id</li>
              <li><b>POST</b> /invoices/:id/refund</li>
              <li><b>POST</b> /merchants/:id/webhooks</li>
              <li><b>GET</b>  /merchants/:id/events</li>
            </ul>
          </div>
          <div className="lp-code" data-reveal>
            <div className="lp-code-tabs" role="tablist">
              {(Object.keys(CODE) as (keyof typeof CODE)[]).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="mono">{k === "link" ? "Create a link" : k === "hook" ? "Webhooks" : "Customer pays"}</button>
              ))}
            </div>
            <div className="lp-code-file mono"><span>{CODE[tab].file}</span><span>TypeScript</span></div>
            <pre className="mono" key={tab}>{CODE[tab].lines.map(([t, l], i) => <span key={i} className={`ln ${t}`}><i>{i + 1}</i>{l || " "}</span>)}</pre>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- how */}
      <section className="lp-sec split">
        <div className="lp-head" data-reveal>
          <span className="lx-tag mono">■ How a payment works</span>
          <h2>Four steps. The customer's address <em>shows up in none.</em></h2>
          <p>The last step fires a signed <span className="mono">payment.succeeded</span> webhook to your server, with the invoice, the amount and the transaction. There's no payer field to fill.</p>
        </div>
        <img className="lp-head-art" data-reveal src="/art/iso-dev.jpg" alt="A laptop sends a signed webhook, sealed like a letter" width={900} height={900} loading="lazy" />
        <ol className="lp-steps">
          {[
            ["Shield", "The customer deposits USDC into a Kohaku privacy pool once. A compliance postman approves it in seconds."],
            ["Bind", "Opening your link binds the invoice to their private refund inbox and a receipt commitment. It's fixed from then on."],
            ["Prove", "Their browser makes a zero-knowledge proof for exactly this invoice. Secrets never leave the device."],
            ["Relay", "Your server submits the proof and pays about a cent of gas. USDC lands at your payout address and your webhook fires."],
          ].map(([t, d], i) => <li key={t} data-reveal style={{ transitionDelay: `${i * 70}ms` }}><span className="lp-step-n mono">0{i + 1}</span><b>{t}</b><p>{d}</p></li>)}
        </ol>
      </section>

      {/* ---------------------------------------------------------------- proof */}
      <section className="lp-sec">
        <div className="lp-proof" data-reveal>
          <div><b>1.1–4.8<em>s</em></b><span>to prove a payment in a browser (warm / first proof)</span></div>
          <div><b>583k</b><span>gas per checkout, paid by the merchant</span></div>
          <div><b>0</b><span>payer addresses in the merchant's records</span></div>
          <div><b>5/5</b><span>attacks rejected on-chain: replay, tamper, squat, expiry, stale root</span></div>
        </div>
        <p className="lp-proof-note mono">Measured on a local fork of Arc testnet (chain 5042002), Nov 6 2026. Public Arc testnet deployment is next. See TESTING.md.</p>
      </section>

      {/* ---------------------------------------------------------------- cta */}
      <section className="lx-cta" data-reveal>
        <h2>Open your shop's <em>curtain.</em></h2>
        <p>Run it locally in two commands and take a private payment in under a minute.</p>
        <pre className="mono">pnpm dev:stack{"\n"}pnpm --filter @noren/web dev</pre>
        <div className="lx-ctas"><a className="lx-btn light" href="#/dashboard">Open dashboard</a><a className="lx-btn dark" href="https://github.com/nickthelegend/noren" target="_blank" rel="noreferrer">Source on GitHub</a></div>
      </section>
    </div>
  );
}
