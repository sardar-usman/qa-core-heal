import { test, expect } from '@playwright/test';

test('performs the dynamic action', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/dynamic.html');
  // Role mutated (link instead of button), exact name preserved. The heal
  // must go to getByRole with the exact name — never the random id.
  await page.getByRole('link', { name: 'Perform Action', exact: true }).click();
  await expect(page.locator('#dyn-note')).toHaveText('performed');
});
