import { test, expect } from '@playwright/test';

test('shows the ready status', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  await expect(page.getByLabel('Quantity')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Ready');
});
