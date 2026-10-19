import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ['shared', 'github', 'diagnostics'].map((name) => [
        `@gitnostics/${name}`,
        fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
      ]),
    ),
  },
  test: {
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '**/dist/**'],
    testTimeout: 15000,
  },
});
