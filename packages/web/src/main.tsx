import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
// Fonts are bundled and served by this app (OFL): no request to a font CDN.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
