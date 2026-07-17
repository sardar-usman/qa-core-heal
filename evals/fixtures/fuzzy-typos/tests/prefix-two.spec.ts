import { test, expect } from '@playwright/test';

test('searches the filtered catalog by prefix', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/prefix-two.html');
  // search_f completes to search_field AND search_filter here: refuse.
  await page.locator('[name="search_f"]').fill('gadget');
  await expect(page.locator('[name="search_field"]')).toHaveValue('gadget');
});
