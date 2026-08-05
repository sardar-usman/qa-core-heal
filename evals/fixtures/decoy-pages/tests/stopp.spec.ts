import { test, expect } from '@playwright/test';

test('stops the animation', async ({ page }) => {
  await page.goto('http://127.0.0.1:4202/stopp.html');
  // The list item "Stopp" is the exact-text decoy; the real control is
  // the button "Stop".
  await page.getByRole('button', { name: 'Stopp' }).click();
  await expect(page.locator('#note')).toHaveText('stopped');
});
