import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    // e2e.spec.ts is a Playwright test (different runner/test.describe
    // implementation) — including it here causes a runtime conflict, not a
    // real failure. Playwright specs run via `npx playwright test`, never vitest.
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e.spec.ts']
  }
});
