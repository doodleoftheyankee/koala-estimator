import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': import.meta.dirname } },
  test: {
    // Tests may sit next to their screens in app/ as well as in lib/ and components/.
    include: ['lib/**/*.test.{ts,tsx}', 'components/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['lib/pricing/**', 'lib/learning/**'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/__fixtures__/**', 'lib/pricing/types.ts', 'lib/learning/types.ts', 'lib/learning/io.ts', 'lib/learning/nightly.ts'],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
