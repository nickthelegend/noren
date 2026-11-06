import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { testTimeout: 180000, include: ['sdk/test/**/*.test.ts', 'underwriter/test/**/*.test.ts'], fileParallelism: false },
})
