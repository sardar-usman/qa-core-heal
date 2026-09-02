import { test, expect } from '@playwright/test';

test('removes via truncated id', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/visibility.html');
  // Truncated id: the heal must emit the element's OWN stable id,
  // never the broken token as a role name.
  await page.locator("#removed").click();
  await expect(page.locator('#note')).toHaveText('gone');
});
