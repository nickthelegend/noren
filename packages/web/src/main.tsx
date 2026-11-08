import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
const App = lazy(() => __NOREN_EDITION__ === "wif" ? import("./WifEdition").then(m => ({ default: m.WifEdition })) : import("./App").then(m => ({ default: m.App })));
// Fonts are bundled and served by this app (OFL): no request to a font CDN.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><Suspense fallback={<div className="boot" aria-busy="true" />}><App /></Suspense></React.StrictMode>);
