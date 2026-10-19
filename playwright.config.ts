import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4310',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm exec tsx tests/e2e/server.ts',
      url: 'http://127.0.0.1:4311/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm exec vite --config apps/web/vite.config.ts',
      url: 'http://127.0.0.1:4310',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
