import { test, expect } from '@playwright/test';

test('shows a single info chip', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  // The page has TWO .info-chip elements. The selector works; the COUNT is
  // wrong — an app/assertion problem, not a locator problem: no heal.
  await expect(page.locator('.info-chip')).toHaveCount(1);
});
