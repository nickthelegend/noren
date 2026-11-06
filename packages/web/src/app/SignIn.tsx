/**
 * Noren app home when signed out: sign in with Privy (email or a wallet; you get an embedded wallet), connect a browser
 * wallet (EIP-6963 or window.ethereum), or use this browser's test wallet. Without VITE_PRIVY_APP_ID there's no Privy
 * sign-in, and the app says so.
 */
import { useEffect, useState } from "react";
import { Logo, msgOf } from "../ui";
import { PRIVY_APP_ID, connectBrowserWallet, disconnectBrowserWallet, privyActions, setWalletMode, useSigner, type WalletMode } from "../signer";
import { discoverWallets, type InjectedWallet } from "../browser-wallet";
import { Mark } from "../logos";

/** Injected wallets on this page, re-scanned on mount and when a wallet announces itself later. */
export function useBrowserWallets() {
  const [list, setList] = useState<InjectedWallet[] | null>(null);
  useEffect(() => {
    let on = true;
    const scan = () => discoverWallets().then((l) => on && setList(l));
    scan(); addEventListener("eip6963:announceProvider", scan);
    return () => { on = false; removeEventListener("eip6963:announceProvider", scan); };
  }, []);
  return list;
}

function BrowserWallets({ onError }: { onError: (e: string | null) => void }) {
  const list = useBrowserWallets();
  const [busy, setBusy] = useState<string | null>(null);
  if (list === null) return null;
  if (!list.length) return <p className="nk-bw-none">No browser wallet found on this page. Install MetaMask or Rabby to use one.</p>;
  return (
    <div className="nk-bw" role="group" aria-label="Browser wallets">
      {list.map((w) => (
        <button key={w.info.uuid} className="nk-bw-row" disabled={!!busy} onClick={async () => { setBusy(w.info.uuid); onError(null); try { await connectBrowserWallet(w); } catch (e) { onError(msgOf(e)); } finally { setBusy(null); } }}>
          {w.info.icon ? <img src={w.info.icon} alt="" width={24} height={24} /> : <i aria-hidden />}
          <span>{busy === w.info.uuid ? `Waiting for ${w.info.name}…` : `Connect ${w.info.name}`}</span>
        </button>
      ))}
    </div>
  );
}

export function SignIn() {
  const s = useSigner();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const login = async () => {
    setBusy(true); setErr(null);
    try { const a = privyActions(); if (!a) throw new Error("Privy is still starting. Try again in a second."); await a.login(); }
    catch (e) { setErr(msgOf(e)); } finally { setBusy(false); }
  };
  const starting = s.status === "loading", creating = s.status === "creating";
  const browser = s.mode === "browser";
  return (
    <section className="nk-signin" aria-labelledby="nk-signin-h">
      <div className="nk-signin-mark"><Logo size={56} /></div>
      <h1 id="nk-signin-h">Pay privately with Noren</h1>
      <p>{browser ? "Connect your browser wallet. It pays with USDC on Arc, bridges and swaps, and opens your private balance with one signature." : "Sign in with your email or a wallet. You get a Noren wallet that pays with USDC on Arc, bridges and swaps, and opens your private balance."}</p>
      {browser ? <BrowserWallets onError={setErr} /> : !PRIVY_APP_ID ? (
        <div className="nk-setup" role="alert"><span className="nk-tag">Setup required: VITE_PRIVY_APP_ID</span><b>Email sign-in isn't configured.</b><p>Add VITE_PRIVY_APP_ID to the gitignored .env and restart the web app. Until then, use a browser wallet or the test wallet.</p></div>
      ) : (
        <button className="nk-cta" onClick={login} disabled={busy || starting || creating} aria-busy={busy || starting || creating}>
          {starting ? "Starting sign-in…" : creating ? "Creating your Noren wallet…" : busy ? "Waiting for sign-in…" : "Sign in with email or wallet"}
        </button>
      )}
      {(err || s.error) && <div className="nk-err" role="alert">{err ?? s.error}</div>}
      <div className="nk-signin-alt">
        {browser ? (PRIVY_APP_ID && <button className="nk-cta soft" onClick={() => setWalletMode("privy")}>Sign in with email instead</button>)
          : <button className="nk-cta soft" onClick={() => setWalletMode("browser")}>Use a browser wallet</button>}
        <button className="nk-cta soft" onClick={() => setWalletMode("test")}>Use a test wallet</button>
      </div>
      <ul className="nk-signin-notes">
        <li><Mark id="ARC" size={16} />Arc testnet and local forks. No real money.</li>
        <li><Mark id="KOHAKU" size={16} />Your private balance's keys come from a signature by your wallet, made on this device.</li>
      </ul>
    </section>
  );
}

/** Profile menu: which wallet signs, and signing out. */
export function WalletSwitch() {
  const s = useSigner();
  const [err, setErr] = useState<string | null>(null);
  const modes: [WalletMode, string][] = [...(PRIVY_APP_ID ? [["privy", "Noren wallet"] as [WalletMode, string]] : []), ["browser", "Browser wallet"], ["test", "Test wallet"]];
  const who = s.mode === "privy" ? (s.status === "in" ? `Signed in as ${s.wallet!.login} (Privy)` : "Not signed in")
    : s.mode === "browser" ? (s.browser ? `${s.browser.name}, chain switches happen in your wallet` : "Not connected")
    : "A key kept in this browser, for the local forks";
  return (
    <div className="nk-wmode">
      <div className="nk-seg" role="radiogroup" aria-label="Wallet" style={{ gridTemplateColumns: `repeat(${modes.length}, 1fr)` }}>
        {modes.map(([m, label]) => <button key={m} role="radio" aria-checked={s.mode === m} onClick={() => setWalletMode(m)}>{label}</button>)}
      </div>
      <small className="nk-wmode-who">{who}{!PRIVY_APP_ID && " · Email sign-in: Setup required: VITE_PRIVY_APP_ID"}</small>
      {s.mode === "privy" && s.status === "in" && <button className="nk-btn ghost" onClick={() => privyActions()?.logout().catch((e) => setErr(msgOf(e)))}>Sign out</button>}
      {s.mode === "browser" && s.browser && <button className="nk-btn ghost" onClick={disconnectBrowserWallet}>Disconnect</button>}
      {err && <div className="nk-err" role="alert">{err}</div>}
    </div>
  );
}
