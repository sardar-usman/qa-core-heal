import { test, expect } from '@playwright/test';

test('pays now', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/overlay.html');
  // The locator is fine; a persistent invisible overlay intercepts the
  // click. Healing must not touch this — it may be a real defect.
  await page.locator('#pay-now').click();
  await expect(page.locator('#pay-note')).toHaveText('paid');
});
