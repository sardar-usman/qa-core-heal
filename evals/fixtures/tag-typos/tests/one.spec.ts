import { test, expect } from '@playwright/test';

test('clicks the primary action', async ({ page }) => {
  await page.goto('http://127.0.0.1:4192/');
  // Tag typo: buttons -> button. The page has exactly one
  // button.btn.btn-primary, so css-tag-fix heals to the CORRECTED
  // compound selector itself.
  await page.locator('buttons.btn.btn-primary').click();
  await expect(page.locator('#click-note')).toHaveText('clicked');
});
