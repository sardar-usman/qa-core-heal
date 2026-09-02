import { test } from '@playwright/test';

test('opens the gear menu', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/icononly.html');
  await page.locator('#btnGenerate').click();
});
