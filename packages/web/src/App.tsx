import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Landing } from "./Landing";
import { Dashboard } from "./Dashboard";
import { Checkout } from "./Checkout";
import { NorenApp } from "./app/NorenApp";
import { TxPage } from "./tx";
import { Icon, Logo, useRoute } from "./ui";
import { PRIVY_APP_ID } from "./signer";
import { APP_URL, HOSTED, MERCHANT_URL, SURFACE, surfaceHref } from "./hosted";

// Privy (sign-in + embedded wallet) loads only on the product surfaces, and only when VITE_PRIVY_APP_ID is set.
const NorenPrivy = lazy(() => import("./privy"));
const WithPrivy = ({ children }: { children: ReactNode }) => (PRIVY_APP_ID ? <Suspense fallback={<div className="boot" aria-busy="true" />}><NorenPrivy>{children}</NorenPrivy></Suspense> : <>{children}</>);

export function App() {
  const route = useRoute();
  // Two Vercel projects: a route that belongs to the other surface (Noren Merchant ⇄ landing and Noren app) moves there.
  useEffect(() => {
    const base = route.page === "dashboard" && SURFACE === "app" ? MERCHANT_URL : route.page === "app" && SURFACE === "merchant" ? APP_URL : "";
    if (base) location.replace(`${base}/${location.hash}`);
  }, [route.page]);
  if (route.page === "dashboard") return <WithPrivy><Dashboard tab={route.tab} sub={route.sub} /></WithPrivy>;
  // Keyed by the whole hash so an app handoff (#/pay/<id>?m=usdc) always starts on the chosen method.
  if (route.page === "pay") return <WithPrivy><Checkout key={location.hash} id={route.id} /></WithPrivy>;
  if (route.page === "app") return <WithPrivy><NorenApp /></WithPrivy>;
  if (route.page === "tx") return <TxPage chain={route.chain} hash={route.hash} />;
  return <Site />;
}

function Site() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => { const on = () => setScrolled(scrollY > 24); on(); addEventListener("scroll", on, { passive: true }); return () => removeEventListener("scroll", on); }, []);
  return (
    <div className="site">
      <header className={`site-nav ${scrolled ? "solid" : ""}`}>
        <a className="site-brand" href="#/"><Logo /><span>Noren</span></a>
        <nav className="mono">
          <a href="#/" className="hide-s">Home</a>
          <a href="#developers" className="hide-s">Developers</a>
          <a href={surfaceHref("#/app")} className="hide-s">Noren app</a>
          <a href={surfaceHref("#/dashboard")}>Noren Merchant</a>
          <a href="https://github.com/nickthelegend/noren" target="_blank" rel="noreferrer" className="hide-s">GitHub</a>
        </nav>
        <a className="lx-btn light sm" href={surfaceHref("#/dashboard")}>Start <Icon.arrow /></a>
      </header>
      <Landing />
      <footer className="site-foot">
        <div className="site-brand"><Logo /><span>Noren</span></div>
        <p>Private payments for EVM. Built on the Ethereum Foundation's Kohaku and 0xbow's Privacy Pools. MIT licensed.</p>
        <p className="faint">{HOSTED ? "Test networks only. Live on the public Arc testnet (chain 5042002). Robinhood Chain features run on a local mainnet snapshot." : "Test networks only. Running on a local Arc testnet fork until the public deployment is funded."}</p>
      </footer>
    </div>
  );
}
