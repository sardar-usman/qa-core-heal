import { test, expect } from '@playwright/test';

test('shows the search widget', async ({ page }) => {
  await page.goto('http://127.0.0.1:4193/tie.html');
  // #search_box and #searchBox are BOTH exact-equal to the broken
  // identifier after normalization: a genuine tie, refused with both named.
  await expect(page.locator('.search-box')).toBeVisible();
});
