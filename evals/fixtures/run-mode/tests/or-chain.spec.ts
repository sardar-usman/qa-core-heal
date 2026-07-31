import { test } from '@playwright/test';
import { SelectPage } from '../pages/select-page';

test('clicks any action via .or() combinator', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/select.html');
  // Both .or() arms are broken in the POM: the first arm alone must never
  // be probed or healed as if it were the whole locator.
  await new SelectPage(page).anyAction.click();
});
