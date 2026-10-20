import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': import.meta.dirname } },
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['lib/pricing/**', 'lib/learning/**'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/__fixtures__/**', 'lib/pricing/types.ts'],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
