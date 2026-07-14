import { test, expect } from '@playwright/test';

test('sets the quantity in the app', async ({ page }) => {
  // Relative navigation only: no absolute goto() anywhere, so with the
  // config unloadable, the trace URL is the ONLY way to know the page.
  await page.goto('/');
  await page.locator('#quantiy').fill('3');
  await expect(page.getByLabel('Quantity')).toHaveValue('3');
});
