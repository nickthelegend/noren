/**
 * Noren app home when signed out: sign in with Privy (email or a wallet; you get an embedded wallet), or use this
 * browser's test wallet. Without VITE_PRIVY_APP_ID there's no Privy sign-in at all, and the app says so.
 */
import { useState } from "react";
import { Logo, msgOf } from "../ui";
import { PRIVY_APP_ID, privyActions, setWalletMode, useSigner } from "../signer";
import { Mark } from "../logos";

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
  return (
    <section className="nk-signin" aria-labelledby="nk-signin-h">
      <div className="nk-signin-mark"><Logo size={56} /></div>
      <h1 id="nk-signin-h">Pay privately with Noren</h1>
      <p>Sign in with your email or a wallet. You get a Noren wallet that pays with USDC on Arc, bridges and swaps, and opens your private balance.</p>
      {!PRIVY_APP_ID ? (
        <div className="nk-setup" role="alert"><span className="nk-tag">Setup required: VITE_PRIVY_APP_ID</span><b>Sign-in isn't configured.</b><p>Add VITE_PRIVY_APP_ID to the gitignored .env and restart the web app. Until then, use the test wallet.</p></div>
      ) : (
        <button className="nk-cta" onClick={login} disabled={busy || starting || creating} aria-busy={busy || starting || creating}>
          {starting ? "Starting sign-in…" : creating ? "Creating your Noren wallet…" : busy ? "Waiting for sign-in…" : "Sign in with email or wallet"}
        </button>
      )}
      {(err || s.error) && <div className="nk-err" role="alert">{err ?? s.error}</div>}
      <button className="nk-cta soft" onClick={() => setWalletMode("test")}>Use a test wallet instead</button>
      <ul className="nk-signin-notes">
        <li><Mark id="ARC" size={16} />Arc testnet and local forks. No real money.</li>
        <li><Mark id="KOHAKU" size={16} />Your private balance's keys come from a signature by your wallet, made on this device.</li>
      </ul>
    </section>
  );
}

/** Profile menu: which wallet signs, and signing out of Privy. */
export function WalletSwitch() {
  const s = useSigner();
  const [err, setErr] = useState<string | null>(null);
  if (!PRIVY_APP_ID) return <div className="nk-menu-row"><small>Wallet</small><span className="nk-tag-k">Test wallet · Setup required: VITE_PRIVY_APP_ID for sign-in</span></div>;
  return (
    <div className="nk-wmode">
      <div className="nk-seg" role="radiogroup" aria-label="Wallet">
        <button role="radio" aria-checked={s.mode === "privy"} onClick={() => setWalletMode("privy")}>Noren wallet</button>
        <button role="radio" aria-checked={s.mode === "test"} onClick={() => setWalletMode("test")}>Test wallet</button>
      </div>
      <small className="nk-wmode-who">{s.mode === "privy" ? (s.status === "in" ? `Signed in as ${s.wallet!.login} (Privy)` : "Not signed in") : "A key kept in this browser, for the local forks"}</small>
      {s.mode === "privy" && s.status === "in" && <button className="nk-btn ghost" onClick={() => privyActions()?.logout().catch((e) => setErr(msgOf(e)))}>Sign out</button>}
      {err && <div className="nk-err" role="alert">{err}</div>}
    </div>
  );
}
