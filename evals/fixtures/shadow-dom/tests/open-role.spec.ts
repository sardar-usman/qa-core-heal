import { test, expect } from '@playwright/test';

test('generates the guid by role name', async ({ page }) => {
  await page.goto('http://127.0.0.1:4194/open.html');
  // One edit from the shadow button's accessible name (its leaf text).
  // The scan collects shadow identity evidence exactly like light DOM,
  // so a role-name typo must heal into the open root (H-ROLE-07 pin).
  await page.getByRole('button', { name: 'Generate GUIDD' }).click();
  await expect(page.locator('#status')).toHaveText('generated');
});
