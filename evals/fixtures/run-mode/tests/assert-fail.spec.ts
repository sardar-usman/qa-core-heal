import { test, expect } from '@playwright/test';

test('shows the done status', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  // The element resolves fine; its TEXT is wrong ("Ready", not "Done").
  // That is an app/assertion problem, not a locator problem: no heal.
  await expect(page.locator('#status')).toHaveText('Done');
});
