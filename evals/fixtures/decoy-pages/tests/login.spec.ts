import { test, expect } from '@playwright/test';

test('logs in', async ({ page }) => {
  await page.goto('http://127.0.0.1:4202/login.html');
  // The heading "Login" normalizes identically to the broken name; the
  // real control is the button "Log In".
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.locator('#note')).toHaveText('logged');
});
