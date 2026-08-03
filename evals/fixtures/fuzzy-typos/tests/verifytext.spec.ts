import { test, expect } from '@playwright/test';

test('greets the user', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/verifytext.html');
  // One edit from the NBSP-spaced greeting; the heal must target the
  // true greeting, not the 0.64-ish "Hello UserName!" decoy.
  await page.getByText("Welcome UserNam!").click();
  await expect(page.locator('#note')).toHaveText('greeted');
});
