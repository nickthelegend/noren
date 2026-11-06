import { useEffect, useState } from "react";
import { Landing } from "./Landing";
import { Dashboard } from "./Dashboard";
import { Checkout } from "./Checkout";
import { Credit } from "./Credit";
import { Icon, Logo, useRoute } from "./ui";

export function App() {
  const route = useRoute();
  if (route.page === "dashboard") return <Dashboard tab={route.tab} sub={route.sub} />;
  if (route.page === "pay") return <Checkout id={route.id} />;
  if (route.page === "credit") return <Credit />;
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
          <a href="#/credit" className="hide-s">Tsuke credit</a>
          <a href="#/dashboard">Dashboard</a>
          <a href="https://github.com/nickthelegend/noren" target="_blank" rel="noreferrer" className="hide-s">GitHub</a>
        </nav>
        <a className="lx-btn light sm" href="#/dashboard">Start <Icon.arrow /></a>
      </header>
      <Landing />
      <footer className="site-foot">
        <div className="site-brand"><Logo /><span>Noren</span></div>
        <p>Private payments for EVM. Built on the Ethereum Foundation's Kohaku and 0xbow's Privacy Pools. MIT licensed.</p>
        <p className="faint">Test networks only. Running on a local Arc testnet fork until the public deployment is funded.</p>
      </footer>
    </div>
  );
}
