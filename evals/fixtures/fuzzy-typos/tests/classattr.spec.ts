import { test } from '@playwright/test';

test('records the primary click', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/classattr.html');
  // No element carries this aria-label; the page shows selector strings
  // as CODE SAMPLES. Those must never appear as fuzzy candidates.
  await page.locator('[aria-label="Button"]').click();
});
