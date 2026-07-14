import { test, expect } from '@playwright/test';

// The test authenticates PROGRAMMATICALLY (like a real suite's auth setup),
// so the test itself reaches /app and fails there on the broken locator.
// Heal's probe has no such setup: without a storage state it gets
// 302-redirected to /login — the authenticated-probing scenarios.

test('sets the app quantity', async ({ page }) => {
  await page.context().addCookies([{
    name: 'session', value: 'valid-token', url: 'http://127.0.0.1:4188',
  }]);
  await page.goto('http://127.0.0.1:4188/app');
  await page.locator('#quantiy').fill('3', { timeout: 2500 });
  await expect(page.getByLabel('Quantity')).toHaveValue('3');
});
