import { test, expect } from '@playwright/test';

test('edits the nested field', async ({ page }) => {
  await page.goto('http://127.0.0.1:4194/nested.html');
  // The field sits two open shadow roots deep: candidate collection must
  // recurse through nested roots, not just the first level.
  await page.locator('.editField').fill('42');
  await expect(page.locator('#editField')).toHaveValue('42');
});
