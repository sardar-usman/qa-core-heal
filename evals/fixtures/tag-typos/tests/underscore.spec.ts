import { test, expect } from '@playwright/test';

test('clicks the primary action via the underscored selector', async ({ page }) => {
  await page.goto('http://127.0.0.1:4192/');
  // '_' is illegal in ANY tag name (custom elements use dashes), so
  // buttons_1 is always a typo: strip the suffix, correct one edit
  // (buttons_1 -> buttons -> button), heal to the corrected selector.
  await page.locator('buttons_1.btn.btn-primary').click();
  await expect(page.locator('#click-note')).toHaveText('clicked');
});
