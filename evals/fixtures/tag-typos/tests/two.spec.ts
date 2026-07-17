import { test } from '@playwright/test';

test('picks a draft action', async ({ page }) => {
  await page.goto('http://127.0.0.1:4192/two.html');
  // Same tag typo, but the corrected selector matches TWO buttons here:
  // which one was meant is unknowable, so the heal is refused.
  await page.locator('buttons.btn.btn-primary').click();
});
