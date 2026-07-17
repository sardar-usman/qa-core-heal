import { test, expect } from '@playwright/test';

test('searches the catalog by prefix', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/prefix.html');
  // Truncated identifier: search_f is a whole prefix of search_field and
  // of nothing else on the page.
  await page.locator('[name="search_f"]').fill('gadget');
  await expect(page.locator('[name="search_field"]')).toHaveValue('gadget');
});
