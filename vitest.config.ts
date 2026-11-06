import { configDefaults, defineConfig } from 'vitest/config';

// `pnpm test` runs every offline suite in the monorepo. Suites that need a running fork (*.fork.test.ts) or a public
// network (*.live.test.ts) run in their own package (see TESTING.md) and are excluded here. The demo shop's tests use
// node:test and run with `pnpm --dir examples/shop test`.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/*.fork.test.ts', '**/*.live.test.ts', '**/out/**', '**/lib/**', 'examples/shop/**'] },
});
