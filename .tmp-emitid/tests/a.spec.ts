import { test, expect } from '@playwright/test';
test('removes it', async ({ page }) => {
  await page.goto('/page.html');
  await page.locator("#removed").click();
  await expect(page.locator('#note')).toHaveText('gone');
});
