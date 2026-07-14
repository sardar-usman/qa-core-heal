import { test, expect } from '@playwright/test';

// The second-repo shape: the locator wait outlives the TEST timeout, the
// fixture teardown closes the page, and the pending action dies with a
// "Target page, context or browser has been closed" message instead of a
// TimeoutError. The locator evidence lives in the call log, not the
// top-level message — classification must still see it.

test('sets the quantity before the deadline', async ({ page }) => {
  test.setTimeout(3000);
  await page.goto('http://127.0.0.1:4188/');
  await page.locator('#quantiy').fill('3', { timeout: 30000 });
  await expect(page.getByLabel('Quantity')).toHaveValue('3');
});
