import { defineConfig } from '@playwright/test';

// A TypeScript enum is NOT erasable syntax: Node's type stripping refuses
// it, so qa-core-heal's config loader fails on this file — while Playwright
// itself (full transpiler) loads it fine and runs the tests. The baseURL
// below is therefore invisible to heal; only the trace knows the page.
enum Environment {
  Local = 'local',
}

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
  metadata: { environment: Environment.Local },
});
