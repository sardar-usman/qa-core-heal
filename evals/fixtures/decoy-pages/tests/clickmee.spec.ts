import { test, expect } from '@playwright/test';

test('clicks me', async ({ page }) => {
  await page.goto('http://127.0.0.1:4202/clickmee.html');
  // The paragraph "Click mee" is the exact-text decoy; the real control
  // is the button "Click me".
  await page.getByRole('button', { name: 'Click mee' }).click();
  await expect(page.locator('#note')).toHaveText('clicked');
});
