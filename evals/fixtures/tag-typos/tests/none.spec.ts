import { test } from '@playwright/test';

test('clicks the missing primary action', async ({ page }) => {
  await page.goto('http://127.0.0.1:4192/none.html');
  // Valid tag, compound classes, nothing on the page matches: refused with
  // the teaching appendix about compound CSS selectors.
  await page.locator('button.btn.btn-primary').click();
});
