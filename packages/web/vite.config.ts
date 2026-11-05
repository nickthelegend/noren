import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// See packages/core/BROWSER.md: maci-crypto imports Node's `assert`; snarkjs and Kohaku are CommonJS-heavy.
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom", "viem"], alias: { assert: require.resolve("assert/") } },
  define: { "process.env": {}, global: "globalThis" },
  optimizeDeps: { include: ["snarkjs", "@kohaku-eth/privacy-pools", "@kohaku-eth/provider/viem", "maci-crypto"], esbuildOptions: { target: "es2022" } },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  server: { port: 5190, strictPort: true },
});
