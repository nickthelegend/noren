import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui";

/* Every number on this page was measured on the local Arc testnet fork (TESTING.md). No invented volume, logos or quotes. */

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
    ["", "const { nextPrecommitment } = await me.refundInbox();"],
    ["", "const proof = await me.proveInvoicePayment(invoice);"],
    ["s", "// 2–5 s in a browser. The merchant relays it and pays the gas."],
  ] },
};

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current; if (!root) return;
    const els = root.querySelectorAll<HTMLElement>("[data-reveal]");
    if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -10% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  return ref;
}

export function Landing() {
  const [tab, setTab] = useState<keyof typeof CODE>("link");
  const ref = useReveal();
  return (
    <div className="lp" ref={ref}>
      {/* ---------------------------------------------------------------- hero */}
      <section className="lp-hero">
        <div className="lp-hero-grid" aria-hidden />
        <div className="lp-hero-in">
          <div className="lp-hero-copy">
            <span className="tag dark"><i />Private payments for EVM · USDC</span>
            <h1>Take payments on&nbsp;EVM.<br /><em>Never see who paid.</em></h1>
            <p>Payment links, hosted checkout, refunds, signed webhooks and a TypeScript SDK. Customers pay from a Kohaku privacy pool, so you get the money and the receipt, and nobody gets their wallet.</p>
            <div className="lp-ctas">
              <a className="btn kaki lg" href="#/dashboard">Open the dashboard <Icon.arrow /></a>
              <a className="btn glass lg" href="#developers">Read the API</a>
            </div>
            <ul className="lp-hero-meta">
              <li><b>2–5 s</b> proof, in the browser</li>
              <li><b>0</b> payer addresses stored</li>
              <li><b>MIT</b> open source</li>
            </ul>
          </div>

          <div className="lp-stage" aria-label="Noren hosted checkout and the merchant's payment record">
            <div className="lp-rod" />
            <div className="lp-curtain l" /><div className="lp-curtain r" />
            <div className="lp-checkout">
              <div className="lp-co-top"><span className="lp-co-shop">Takumi Coffee</span><span className="pill moss sm"><Icon.check /> Paid</span></div>
              <small>Flat white</small>
              <b className="lp-co-amt">7.50 <em>USDC</em></b>
              <ol className="lp-co-steps">
                <li><i /><span>Invoice bound to your private refund inbox</span></li>
                <li><i /><span>Proof made on this device <b className="mono">2.18 s</b></span></li>
                <li><i /><span>Merchant relayed it and paid the gas</span></li>
              </ol>
            </div>
            <div className="lp-record">
              <div className="lp-rec-h"><small>Dashboard · Payments</small><span className="mono faint">0x7c1e…a3f0</span></div>
              <dl>
                <dt>Amount</dt><dd>7.50 USDC</dd>
                <dt>Status</dt><dd><span className="pill moss sm">Succeeded</span></dd>
                <dt>Customer</dt><dd className="unk"><Icon.eyeOff /> unknown</dd>
              </dl>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- problem */}
      <section className="lp-sec">
        <div className="lp-head" data-reveal>
          <span className="eyebrow">The problem with crypto checkout</span>
          <h2>Paying with a wallet hands over your whole wallet.</h2>
          <p>Send USDC to a shop and the shop, its analytics vendor and everyone on a block explorer can see your balance, your salary and every shop you've paid. Card networks never worked like that. Noren puts the curtain back.</p>
        </div>
        <div className="lp-compare">
          <div className="lp-cmp bad" data-reveal>
            <span className="eyebrow">A plain USDC transfer</span>
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
            <span className="eyebrow">A Noren payment</span>
            <h3>What the merchant learns</h3>
            <ul>
              <li><Icon.check /> The invoice was paid, in full, on time</li>
              <li><Icon.check /> The money came from screened, compliant funds</li>
              <li><Icon.check /> A receipt the customer can open later, if they choose</li>
              <li><Icon.check /> Refunds land in a private inbox only the customer can see</li>
            </ul>
            <div className="lp-trace mono"><span>privacy pool</span><Icon.arrow /><span>Takumi Coffee</span><em>payer: unknown</em></div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- product */}
      <section className="lp-sec">
        <div className="lp-head" data-reveal>
          <span className="eyebrow">Everything a merchant expects</span>
          <h2>The payments stack you know. The privacy you don't get anywhere else.</h2>
        </div>
        <div className="lp-bento">
          <article className="bx big" data-reveal>
            <Icon.link /><h3>Payment links and hosted checkout</h3>
            <p>Create a link in the dashboard or with one SDK call. The customer opens it, proves on their own device and is done in a few seconds. No gas, no public wallet, no browser extension.</p>
            <div className="bx-art link"><span className="mono">/pay/0x7c1e…a3f0</span><span className="pill ink sm">7.50 USDC</span></div>
          </article>
          <article className="bx" data-reveal><Icon.refund /><h3>Private refunds</h3><p>Full or partial refunds go back into the customer's shielded inbox. Their wallet finds them; you never learn whose they are.</p></article>
          <article className="bx" data-reveal><Icon.hook /><h3>Signed webhooks</h3><p><span className="mono">payment.succeeded</span> and <span className="mono">refund.succeeded</span>, HMAC-SHA256 signed with retries and a delivery log.</p></article>
          <article className="bx" data-reveal><Icon.shield /><h3>Compliance built in</h3><p>Deposits are screened against USDC's own blacklist before they can pay you. Blocked funds can't reach your till.</p></article>
          <article className="bx" data-reveal><Icon.receipt /><h3>Selective receipts</h3><p>Each payment carries a receipt commitment. The customer can open it for a warranty claim or for tax.</p></article>
          <article className="bx wide" data-reveal>
            <Icon.lock /><h3>Bound to the invoice, enforced on-chain</h3>
            <p>The zero-knowledge proof commits to the invoice, the merchant, the amount and the refund address. Change any of them and the pool rejects it. Only the merchant can relay, so nobody can grab a customer's invoice first.</p>
            <div className="bx-art chips"><span>replay <b>rejected</b></span><span>tampered amount <b>rejected</b></span><span>invoice squatting <b>rejected</b></span><span>expired <b>rejected</b></span><span>stale compliance root <b>rejected</b></span></div>
          </article>
        </div>
      </section>

      {/* ---------------------------------------------------------------- developers */}
      <section className="lp-dev" id="developers">
        <div className="lp-dev-in">
          <div className="lp-dev-copy" data-reveal>
            <span className="eyebrow light">For developers</span>
            <h2>Get paid in about ten lines.</h2>
            <p>A REST API, a TypeScript SDK and webhooks that feel familiar. It's plain Solidity on 0xbow's Privacy Pools contracts, so it ports to any EVM chain with USDC. We launch on Arc.</p>
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
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{k === "link" ? "Create a link" : k === "hook" ? "Webhooks" : "Customer pays"}</button>
              ))}
            </div>
            <div className="lp-code-file mono"><span>{CODE[tab].file}</span><span className="faint">TypeScript</span></div>
            <pre className="mono" key={tab}>{CODE[tab].lines.map(([t, l], i) => <span key={i} className={`ln ${t}`}><i>{i + 1}</i>{l || " "}</span>)}</pre>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- how */}
      <section className="lp-sec">
        <div className="lp-head" data-reveal>
          <span className="eyebrow">How a payment works</span>
          <h2>Four steps. The customer's address shows up in none of them.</h2>
        </div>
        <ol className="lp-steps">
          {[
            ["Shield", "The customer deposits USDC into a Kohaku privacy pool once. A compliance postman approves it in seconds."],
            ["Bind", "Opening your link binds the invoice to their private refund inbox and a receipt commitment. It can't be changed after that."],
            ["Prove", "Their browser makes a zero-knowledge proof for exactly this invoice. Secrets never leave the device."],
            ["Relay", "Your server submits the proof and pays about a cent of gas. USDC lands at your payout address, and you get a webhook."],
          ].map(([t, d], i) => <li key={t} data-reveal style={{ transitionDelay: `${i * 70}ms` }}><span className="lp-step-n">{["一", "二", "三", "四"][i]}</span><b>{t}</b><p>{d}</p></li>)}
        </ol>
      </section>

      {/* ---------------------------------------------------------------- proof */}
      <section className="lp-sec">
        <div className="lp-proof" data-reveal>
          <div><b>2.2–4.8<em>s</em></b><span>to prove a payment in a browser</span></div>
          <div><b>583k</b><span>gas per checkout, paid by the merchant</span></div>
          <div><b>0</b><span>payer addresses in the merchant's records</span></div>
          <div><b>5 / 5</b><span>attacks rejected on-chain</span></div>
        </div>
        <p className="lp-proof-note">Measured on a local fork of Arc testnet (chain 5042002), Nov 6 2026. The public Arc testnet deployment is next. See TESTING.md in the repo.</p>
      </section>

      {/* ---------------------------------------------------------------- cta */}
      <section className="lp-cta" data-reveal>
        <h2>Open your shop's curtain.</h2>
        <p>Run it locally in two commands and take a private payment in under a minute.</p>
        <pre className="mono">pnpm dev:stack{"\n"}pnpm --filter @noren/web dev</pre>
        <div className="lp-ctas center"><a className="btn ink lg" href="#/dashboard">Open the dashboard <Icon.arrow /></a><a className="btn line lg" href="https://github.com/nickthelegend/noren" target="_blank" rel="noreferrer">Source on GitHub</a></div>
      </section>
    </div>
  );
}
