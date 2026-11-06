import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test-sdk/**/*.test.ts"], testTimeout: 60_000 } });
