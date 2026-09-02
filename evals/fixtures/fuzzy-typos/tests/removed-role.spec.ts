import { test, expect } from '@playwright/test';

test('removes via typoed role name', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/visibility.html');
  // Typoed role name: the heal must emit the element's full computed
  // accessible name with exact: true.
  await page.getByRole("button", { name: "Removd" }).click();
  await expect(page.locator('#note')).toHaveText('gone');
});
