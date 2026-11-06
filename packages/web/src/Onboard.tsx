/**
 * Noren Merchant first run: sign in with Ethereum (EIP-4361) → business name → payouts → first payment link → SDK.
 * The server verifies the SIWE signature, gives the store its own on-chain merchant account
 * (NorenCheckout.registerMerchant(payout) on Arc), a publishable key and a secret key shown once.
 */
import { ARC_LABEL, HOSTED } from "./network";
import { useEffect, useState } from "react";
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { isAddress, toHex, type Address, type Hex } from "viem";
import { PRIVY_APP_ID, privyActions, waitForPrivy } from "./signer";
import { connectWallet, useBrowserWallets, type InjectedWallet } from "./browser-wallet";
import { SERVER, usdc, type Config } from "./api";
import { Copy, Icon, Logo, msgOf } from "./ui";
import { QR } from "./kit";
import "./onboard.css";
import { TxLink } from "./tx";

export type Session = { session: string; address: Address; expiresAt: number; via?: "siwe" | "privy" };
export type StoreView = { id: string; name: string; payout: Address; merchant: Address; publishableKey: string; keys: { id: string; prefix: string; createdAt: number; revokedAt?: number }[]; createdAt: number; registerTx: Hex };
const SESSION_KEY = "noren.merchant.session", STORE_KEY = "noren.merchant.store", WALLET_KEY = "noren.merchant.wallet.v1";
export const readSession = (): Session | null => { try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null"); return s && s.expiresAt > Date.now() / 1000 ? s : null; } catch { return null; } };
export const saveSession = (s: Session | null) => { try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } };
export const readStoreId = () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };
export const saveStoreId = (id: string) => { try { localStorage.setItem(STORE_KEY, id); } catch { /* private mode */ } };

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  let r: Response;
  try { r = await fetch(`${SERVER}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }); }
  catch { throw new Error(`Can't reach the Noren server at ${SERVER}. Start it with pnpm dev:all`); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && /^\/(auth|stores)/.test(path)) throw new Error("Setup required: this Noren server has no store sign-up yet (restart pnpm dev:all on the app-dex branch)");
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}
export const listStores = (token: string) => call<StoreView[]>("/stores", { token });

/** Sign in with Ethereum, with this browser's test wallet or a browser wallet (EIP-6963 or window.ethereum). */
async function signIn(cfg: Config, via: "local" | InjectedWallet): Promise<Session> {
  const { nonce } = await call<{ nonce: string }>("/auth/nonce");
  let address: Address, sign: (m: string) => Promise<Hex>;
  if (via === "local") {
    let k: Hex | null = null;
    try { k = localStorage.getItem(WALLET_KEY) as Hex | null; } catch { /* below */ }
    if (!k) { k = generatePrivateKey(); try { localStorage.setItem(WALLET_KEY, k); } catch { /* tab-only */ } }
    const a = privateKeyToAccount(k); address = a.address; sign = (message) => a.signMessage({ message });
  } else {
    const eth = via.provider, a = await connectWallet(eth); address = a;
    sign = (message) => eth.request({ method: "personal_sign", params: [toHex(message), a] }) as Promise<Hex>;
  }
  const message = createSiweMessage({ domain: location.host, address, uri: location.origin, version: "1", chainId: cfg.chainId, nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 10 * 60_000), statement: "Sign in to Noren Merchant. This costs nothing and sends no transaction." });
  const s = await call<Session>("/auth/siwe", { method: "POST", body: JSON.stringify({ message, signature: await sign(message) }) });
  saveSession(s);
  return s;
}

const isEmbedded = (t: string) => t === "privy" || t === "privy-v2";
/**
 * Sign in with Privy (email, external wallet or embedded wallet). The server checks the Privy access token against
 * Privy's public keys, and a SIWE signature from the user's wallet, bound to that Privy user, picks the address the
 * store belongs to: the wallet they logged in with, else their embedded wallet.
 */
async function signInPrivy(cfg: Config): Promise<Session> {
  if (!PRIVY_APP_ID) throw new Error("Setup required: VITE_PRIVY_APP_ID");
  const a = privyActions(); if (!a) throw new Error("Privy is still starting. Try again in a second.");
  const userId = await a.login();
  const st = await waitForPrivy((x) => (x.authenticated && x.userId === userId ? x : null));
  const want = st.primaryWallet?.toLowerCase();
  const wallet = await waitForPrivy((x) => x.wallets.find((w) => w.address.toLowerCase() === want) ?? x.wallets.find((w) => isEmbedded(w.walletClientType)));
  const token = await st.getAccessToken(); if (!token) throw new Error("Privy returned no access token. Sign in again.");
  const provider = await wallet.getEthereumProvider();
  const { nonce } = await call<{ nonce: string }>("/auth/nonce");
  const message = createSiweMessage({ domain: location.host, address: wallet.address, uri: location.origin, version: "1", chainId: cfg.chainId, nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 10 * 60_000), statement: "Sign in to Noren Merchant. This costs nothing and sends no transaction.", resources: [userId] });
  const signature = (await provider.request({ method: "personal_sign", params: [toHex(message), wallet.address] })) as Hex;
  const s = await call<Session>("/auth/privy", { method: "POST", body: JSON.stringify({ accessToken: token, message, signature }) });
  saveSession(s);
  return s;
}

const STEPS = ["Sign in", "Business", "Payouts", "First payment link", "Developers"];

export function Onboard({ cfg, session, onSession, onStore, onDone }: { cfg: Config; session: Session | null; onSession: (s: Session) => void; onStore: (s: StoreView) => void; onDone: () => void }) {
  const [step, setStep] = useState(session ? 1 : 0);
  const [name, setName] = useState("");
  const [payoutMode, setPayoutMode] = useState<"self" | "other">("self");
  const [payout, setPayout] = useState("");
  const [store, setStore] = useState<StoreView | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [amount, setAmount] = useState("12.50");
  const [desc, setDesc] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const wallets = useBrowserWallets();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (session && step === 0) setStep(1); }, [session]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (k: string, f: () => Promise<void>) => { setBusy(k); setErr(null); try { await f(); } catch (e) { setErr(msgOf(e)); } finally { setBusy(null); } };
  const payTo = (payoutMode === "self" ? session?.address : payout) ?? "";

  const snippet = store ? `import { createNoren } from "@noren/core/merchant";

const noren = createNoren({
  server: "${SERVER}",
  token: process.env.NOREN_SECRET_KEY, // ${secret ? secret.slice(0, 14) + "…" : "sk_test_…"}
  merchant: "${store.merchant}",
});

const { invoice } = await noren.invoices.create({
  amount: 12_500_000n, // 12.50 USDC
  expiresIn: 1800,
  description: "Order #1001",
  successUrl: "https://your-shop.example/thanks",
  cancelUrl: "https://your-shop.example/cart",
  metadata: { orderId: "1001" },
});
// send the customer to ${location.origin}/#/pay/\${invoice.invoiceId}` : "";

  return (
    <div className="ob">
      <aside className="ob-side">
        <div className="ob-brand"><Logo size={28} /><b>Noren Merchant</b></div>
        <p>Set up your store in a minute. Customers can pay privately, with USDC, with stocks or crypto, or in 3 parts; you get USDC on Arc.</p>
        <ol className="ob-steps">{STEPS.map((t, i) => <li key={t} data-state={i < step ? "done" : i === step ? "now" : "todo"}><i>{i < step ? <Icon.check /> : i + 1}</i><span>{t}</span></li>)}</ol>
        <p className="ob-fine">{HOSTED ? "Test mode: Arc testnet and a Robinhood Chain mainnet snapshot. No real funds." : "Test mode: Arc testnet and Robinhood Chain run as local forks. No real money."}</p>
      </aside>

      <section className="ob-main" aria-live="polite">
        {step === 0 && (
          <div className="ob-card">
            <span className="ob-k">Sign in</span>
            <h1>Sign in to Noren Merchant</h1>
            <p>Use your email or a wallet. Either way you sign a message (Sign-In with Ethereum, EIP-4361), the server checks it, and nothing is sent on-chain.</p>
            <div className="ob-choices">
              <button className="ob-choice" disabled={!!busy || !PRIVY_APP_ID} onClick={() => run("privy", async () => { onSession(await signInPrivy(cfg)); setStep(1); })}>
                <Icon.user /><span><b>{busy === "privy" ? "Waiting for Privy…" : "Sign in with Privy"}</b><small>{PRIVY_APP_ID ? "Email, a wallet, or a new embedded wallet" : "Setup required: VITE_PRIVY_APP_ID"}</small></span><Icon.arrow />
              </button>
              <button className="ob-choice" disabled={!!busy} onClick={() => run("local", async () => { onSession(await signIn(cfg, "local")); setStep(1); })}>
                <Icon.lock /><span><b>{busy === "local" ? "Signing in…" : "Use a test wallet"}</b><small>{HOSTED ? "A key kept in this browser, for Arc testnet and the Robinhood Chain mainnet snapshot" : "A key kept in this browser, for the local forks"}</small></span><Icon.arrow />
              </button>
              {wallets?.length ? wallets.map((w) => (
                <button key={w.info.uuid} className="ob-choice" disabled={!!busy} onClick={() => run(w.info.uuid, async () => { onSession(await signIn(cfg, w)); setStep(1); })}>
                  {w.info.icon ? <img src={w.info.icon} alt="" width={16} height={16} style={{ borderRadius: 4 }} /> : <Icon.shield />}<span><b>{busy === w.info.uuid ? `Waiting for ${w.info.name}…` : w.info.name}</b><small>Browser wallet: sign one message, nothing is sent on-chain</small></span><Icon.arrow />
                </button>
              )) : (
                <button className="ob-choice" disabled><Icon.shield /><span><b>Browser wallet</b><small>{wallets === null ? "Looking for wallets…" : "No browser wallet detected"}</small></span><Icon.arrow /></button>
              )}
            </div>
            {err && <p className="err" role="alert">{err}</p>}
          </div>
        )}

        {step === 1 && (
          <form className="ob-card" onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep(2); }}>
            <span className="ob-k">Step 1 of 3</span>
            <h1>What's your business called?</h1>
            <p>Customers see this name on your checkout and receipts.</p>
            <label className="ob-field"><span>Business name</span><input autoFocus maxLength={48} value={name} onChange={(e) => setName(e.target.value)} placeholder="Chai Point, Bandra" /></label>
            <p className="ob-who mono">Signed in as {session?.address}</p>
            <button className="ob-cta" disabled={!name.trim()}>Continue <Icon.arrow /></button>
          </form>
        )}

        {step === 2 && (
          <div className="ob-card">
            <span className="ob-k">Step 2 of 3</span>
            <h1>Where should payouts go?</h1>
            <p>Every payment settles as USDC on Arc to one address. Stock payments arrive as USDG on Robinhood Chain first; “Settle to Arc” moves them with a Chainlink CRE-approved Relay or Across quote.</p>
            <div className="ob-choices" role="radiogroup" aria-label="Payout address">
              <button role="radio" aria-checked={payoutMode === "self"} className="ob-choice" onClick={() => setPayoutMode("self")}><Icon.card /><span><b>USDC on Arc to my wallet</b><small className="mono">{session?.address}</small></span></button>
              <button role="radio" aria-checked={payoutMode === "other"} className="ob-choice" onClick={() => setPayoutMode("other")}><Icon.link /><span><b>USDC on Arc to another address</b><small>A treasury, a multisig or an exchange deposit</small></span></button>
            </div>
            {payoutMode === "other" && <label className="ob-field"><span>Payout address on Arc</span><input className="mono" value={payout} onChange={(e) => setPayout(e.target.value.trim())} placeholder="0x…" /></label>}
            {err && <p className="err" role="alert">{err}</p>}
            <div className="ob-row">
              <button className="ob-ghost" onClick={() => setStep(1)}>Back</button>
              <button className="ob-cta" disabled={!!busy || !isAddress(payTo)} onClick={() => run("store", async () => {
                const r = await call<{ store: StoreView; secretKey: string }>("/stores", { method: "POST", token: session!.session, body: JSON.stringify({ name: name.trim(), payout: payTo }) });
                setStore(r.store); setSecret(r.secretKey); saveStoreId(r.store.id); onStore(r.store); setStep(3);
              })}>{busy === "store" ? <><span className="spin" /> Registering on Arc…</> : <>Create store <Icon.arrow /></>}</button>
            </div>
            <p className="ob-fine">Creating the store registers its merchant account on Arc with <code>NorenCheckout.registerMerchant(payout)</code>.</p>
          </div>
        )}

        {step === 3 && store && (
          <div className="ob-card">
            <span className="ob-k">Step 3 of 3</span>
            <h1>Create your first payment link</h1>
            <p><b>{store.name}</b> is live on {ARC_LABEL} (registered in tx <TxLink chain="arc" cfg={cfg} hash={store.registerTx} n={8} />). Make a link and share it, or print its QR at the counter.</p>
            {!link ? (
              <>
                <div className="ob-row2">
                  <label className="ob-field"><span>Amount (USDC)</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /></label>
                  <label className="ob-field"><span>Description</span><input value={desc} maxLength={120} onChange={(e) => setDesc(e.target.value)} placeholder="Masala chai, large" /></label>
                </div>
                {err && <p className="err" role="alert">{err}</p>}
                <button className="ob-cta" disabled={!!busy || !(Number(amount) > 0)} onClick={() => run("link", async () => {
                  const r = await call<{ invoice: { invoiceId: string } }>(`/merchants/${store.merchant}/invoices`, { method: "POST", token: secret!, body: JSON.stringify({ amount: String(Math.round(Number(amount) * 1e6)), expiry: String(Math.floor(Date.now() / 1000) + 7 * 86400), ...(desc.trim() ? { description: desc.trim() } : {}) }) });
                  setLink(`${location.origin}${location.pathname}#/pay/${r.invoice.invoiceId}`);
                })}>{busy === "link" ? <><span className="spin" /> Creating…</> : <>Create link <Icon.arrow /></>}</button>
                <p className="ob-fine">Created with your new secret key, exactly as your server would.</p>
              </>
            ) : (
              <div className="ob-link">
                <div className="ob-qr"><QR text={link} size={168} /></div>
                <div>
                  <b>{usdc(BigInt(Math.round(Number(amount) * 1e6)))} USDC{desc ? ` · ${desc}` : ""}</b>
                  <code className="ob-url">{link}</code>
                  <div className="ob-row"><Copy text={link} label="Copy link" /><a className="ob-ghost" href={link.slice(link.indexOf("#"))} target="_blank" rel="noreferrer">Open checkout <Icon.ext /></a></div>
                </div>
              </div>
            )}
            {link && <button className="ob-cta" onClick={() => setStep(4)}>Continue <Icon.arrow /></button>}
          </div>
        )}

        {step === 4 && store && (
          <div className="ob-card">
            <span className="ob-k">Developers</span>
            <h1>Your API keys</h1>
            <p>The secret key is shown <b>once</b>. Noren keeps only its hash; you can revoke it or make a new one in Developers.</p>
            <dl className="ob-keys">
              <dt>Publishable key</dt><dd><code>{store.publishableKey}</code><Copy text={store.publishableKey} /></dd>
              <dt>Secret key</dt><dd>{secret ? <><code>{secret}</code><Copy text={secret} /></> : <span className="faint">Already shown. Make a new one in Developers.</span>}</dd>
              <dt>Merchant ID</dt><dd><code>{store.merchant}</code><Copy text={store.merchant} /></dd>
            </dl>
            <div className="ob-snip"><header><span>server.ts</span><Copy text={snippet} label="Copy SDK snippet" /></header><pre>{snippet}</pre></div>
            <button className="ob-cta" onClick={() => { setSecret(null); onDone(); }}>Go to your dashboard <Icon.arrow /></button>
          </div>
        )}
      </section>
    </div>
  );
}
