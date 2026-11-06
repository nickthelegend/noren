import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

// VITE_* keys (VITE_PRIVY_APP_ID) come from the repo's gitignored .env, as scripts/dev-all.ts does for the server:
// this checkout's .env, else the main checkout's when this is a git worktree. Only VITE_-prefixed values reach the app.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function envDir() {
  if (existsSync(resolve(root, ".env"))) return root;
  try { return resolve(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim(), ".."); } catch { return root; }
}

// See packages/core/BROWSER.md: maci-crypto imports Node's `assert`; snarkjs and Kohaku are CommonJS-heavy.
export default defineConfig({
  plugins: [react()],
  envDir: envDir(),
  resolve: { dedupe: ["react", "react-dom", "viem"], alias: { assert: require.resolve("assert/") } },
  define: { "process.env": {}, global: "globalThis" },
  optimizeDeps: { include: ["snarkjs", "@kohaku-eth/privacy-pools", "@kohaku-eth/provider/viem", "maci-crypto"], esbuildOptions: { target: "es2022" } },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  server: { port: 5190, strictPort: true },
});
