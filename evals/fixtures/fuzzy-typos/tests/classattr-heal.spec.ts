import { test, expect } from '@playwright/test';

test('clicks the named primary button', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/classattr-heal.html');
  // The lost aria-label heals to the role/name locator — cleanly, despite
  // the contaminating code samples on the page.
  await page.locator('[aria-label="Button"]').click();
  await expect(page.locator('#click-note')).toHaveText('clicked');
});
