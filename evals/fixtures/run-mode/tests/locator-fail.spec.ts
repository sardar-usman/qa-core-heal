import { test, expect } from '@playwright/test';

test('sets the quantity', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  // Typo'd id: the live page has #quantity. A locator failure run mode heals.
  await page.locator('#quantiy').fill('3');
  await expect(page.getByLabel('Quantity')).toHaveValue('3');
});
