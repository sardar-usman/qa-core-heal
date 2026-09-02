import { test, expect } from '@playwright/test';
test('removes by role', async ({ page }) => {
  await page.goto('/page.html');
  await page.getByRole("button", { name: "Removd" }).click();
  await expect(page.locator('#note')).toHaveText('gone');
});
