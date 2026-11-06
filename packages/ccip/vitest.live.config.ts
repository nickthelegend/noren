import { defineConfig } from "vitest/config";

// Public-network suite (Chainlink CCIP API + testnet RPCs); excluded from the offline `pnpm test`.
export default defineConfig({ test: { include: ["test-sdk/**/*.live.test.ts"], testTimeout: 60_000 } });
