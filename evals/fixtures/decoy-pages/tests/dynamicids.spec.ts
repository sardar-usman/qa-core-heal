import { test, expect } from '@playwright/test';

test('presses the dynamic id button', async ({ page }) => {
  await page.goto('http://127.0.0.1:4202/dynamicids.html');
  // The heading "Dynamic IDs" is the exact-text decoy; the real control's
  // caption is "Dynamic ID".
  await page.getByRole('button', { name: 'Dynamic IDs' }).click();
  await expect(page.locator('#note')).toHaveText('pressed');
});
