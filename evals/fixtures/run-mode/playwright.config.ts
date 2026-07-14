import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10000,
  expect: { timeout: 2500 },
  use: {
    baseURL: 'http://127.0.0.1:4188',
    actionTimeout: 2500,
  },
  reporter: [['line']],
  webServer: {
    command: 'node serve.mjs',
    url: 'http://127.0.0.1:4188/',
    reuseExistingServer: true,
    timeout: 10000,
  },
});
