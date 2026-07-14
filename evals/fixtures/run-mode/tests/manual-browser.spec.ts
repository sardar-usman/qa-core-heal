import { test, expect } from '@playwright/test';
// The library package, NOT @playwright/test: launches from here escape the
// test-runner's tracing instrumentation, exactly like the real repo.
import { chromium, type Browser, type Page } from 'playwright';

// Custom browser setup: chromium launched manually in beforeAll. Built-in
// tracing only covers fixture-created pages, so failures here produce NO
// trace — the failure URL must come from static route inference instead.

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await browser.close();
});

test('reads the status with a manual browser', async () => {
  await page.goto('http://127.0.0.1:4188/');
  await expect(page.locator('#stauts')).toHaveText('Ready', { timeout: 3000 });
});
