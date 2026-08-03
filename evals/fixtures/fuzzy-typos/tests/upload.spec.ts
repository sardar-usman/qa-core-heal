import { test, expect } from '@playwright/test';

test('starts the upload', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/upload.html');
  // One edit from the value-attribute button's accessible name.
  await page.getByRole("button", { name: "Uploadd" }).click();
  await expect(page.locator('#note')).toHaveText('sent');
});
