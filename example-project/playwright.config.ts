import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15000,
  expect: { timeout: 3000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    actionTimeout: 3000,
  },
  reporter: [['line']],
  webServer: {
    command: 'node serve.mjs',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: true,
    timeout: 10000,
  },
});
