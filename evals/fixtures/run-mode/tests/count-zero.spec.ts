import { test, expect } from '@playwright/test';

test('counts the quantity field', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  // toHaveCount(1) on a selector matching NOTHING: actual count 0 means
  // nothing matched — locator evidence, so run mode must heal it. The live
  // page has #quantity.
  await expect(page.locator('#quantiy')).toHaveCount(1);
});
