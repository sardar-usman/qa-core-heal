import { test } from '@playwright/test';

test('clicks the first row positionally', async ({ page }) => {
  await page.goto('http://127.0.0.1:4198/');
  // Positional predicate + path step: opaque, refuses exactly as today.
  await page.locator('//ul/li[3]').click();
});

test('clicks via class containment trick', async ({ page }) => {
  await page.goto('http://127.0.0.1:4198/');
  // Class-attribute containment: styling, not identity — opaque.
  await page.locator("//div[contains(@class,'btn-primary')]").click();
});

test('clicks via sibling axis', async ({ page }) => {
  await page.goto('http://127.0.0.1:4198/');
  // Axis navigation: opaque.
  await page.locator('//h1/following-sibling::section').click();
});
