import { test } from '@playwright/test';

test('clicks the dashed action on the one-button page', async ({ page }) => {
  await page.goto('http://127.0.0.1:4192/');
  // Even with EXACTLY ONE unique match for the would-be correction on
  // this page, a dashed tag must never auto-heal — only hint.
  await page.locator('buttons-1.btn.btn-primary').click();
});
