import { defineConfig } from '@playwright/test';

// The base URL lives ONLY here (not in qa-core.config.json and not as an
// absolute URL anywhere in the specs or page objects). The heal CLI must
// read it from this config, the way Playwright itself does.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.DEMOWEBSHOP_BASE_URL ?? 'https://demowebshop.tricentis.com',
    actionTimeout: 10000,
  },
  reporter: [['line']],
});
