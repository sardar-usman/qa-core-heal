import { test, expect } from '@playwright/test';

test('pays after the overlay clears', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/overlay-clears.html');
  // The overlay disappears after 2s; Playwright's actionability retries
  // absorb the wait and the click lands. All green — nothing to heal.
  await page.locator('#pay-now').click();
  await expect(page.locator('#pay-note')).toHaveText('paid');
});
