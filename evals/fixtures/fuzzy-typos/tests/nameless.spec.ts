import { test } from '@playwright/test';

test('wipes everything', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/nameless.html');
  await page.locator('#wipeAllButton').click();
});
