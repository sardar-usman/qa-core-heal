import { test } from '@playwright/test';

test('clicks the hover link', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/mouseover.html');
  await page.getByRole('link', { name: 'Click me' }).click();
});
