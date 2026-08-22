import { test, expect } from '@playwright/test';

test('fills the amount and checks the wrong value', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/wrongassert.html');
  // The heal is correct; the assertion below is independently wrong.
  await page.locator('#inputFeld').fill('42');
  await expect(page.locator('#inputField')).toHaveValue('99');
});
