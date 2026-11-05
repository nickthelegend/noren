# Browser bundling with Vite

Import customer helpers from `@noren/core/customer`; do not import `@noren/core/node` in the browser. `loadArtifact` has dynamic `node:` imports inside a `typeof window === 'undefined'` branch. Vite may report that it externalized those imports, but the browser path uses Fetch and Cache Storage.

`maci-crypto`, used by the Kohaku stack, imports Node's `assert` name. Install the browser `assert` package in the web app and alias that name in `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: { alias: { assert: require.resolve('assert/') } },
  optimizeDeps: { include: ['snarkjs', '@kohaku-eth/privacy-pools', '@kohaku-eth/provider/viem', 'maci-crypto'] },
});
```

`pnpm add assert --store-dir '/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.pnpm-store'` installs the polyfill for this workspace. The `optimizeDeps` entries help Vite's dev server prebundle the CommonJS packages; the alias is needed for production too. A temporary Vite 7.2.2 entry importing `customer.ts` built successfully with this config (1,108 transformed modules). The resulting main chunk was about 2.2 MB minified, so load the customer module lazily in a web app. This checks bundling, not in-browser proving.
