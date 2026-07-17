import { test } from '@playwright/test';

test('picks a draft action via the underscored selector', async ({ page }) => {
  await page.goto('http://127.0.0.1:4192/two.html');
  // The corrected selector matches TWO buttons here: refuse, as always.
  await page.locator('buttons_1.btn.btn-primary').click();
});
